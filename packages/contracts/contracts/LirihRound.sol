// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, ebool, euint256, externalEuint256} from
    "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {IERC7984} from
    "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Isqrt} from "./Isqrt.sol";
import {ISplitFactoryV2, IPushSplit, Split} from "./ISplitFactoryV2.sol";

/// @title Lirih — confidential quadratic funding round.
/// @notice Donation amounts are encrypted end-to-end (ERC-7984). Per project we
///         keep Sp = Σ√cᵢ and Cp = Σcᵢ under encryption. At settle:
///         matchₚ = Sp² − Cp (clamped ≥0), allocₚ = M·matchₚ/Σmatchₚ. Only the
///         final per-project allocation of the public matching pool M is ever
///         decrypted; who gave how much stays encrypted forever — you cannot
///         prove how you donated, so bribery/coercion is defeated (MACI's
///         property via a TEE instead of ZK).
///
/// Positioned as confidential participatory budgeting / internal capital
/// allocation — an org splits a budget across teams while individual votes
/// (contributions) stay private.
contract LirihRound is ReentrancyGuard {
    uint256 internal constant SQRT_BITS = 41; // √(1e24) < 2^41; see reference/
    uint256 internal constant CONTRIB_CAP = 1e24; // 1M tokens @18dp; sqrt-domain bound
    // Sanity bound only. The gas argument for it is gone — finalizeTallyPaged and
    // computeAllocationsPaged make both loops resumable — but an unbounded project
    // list still makes `settle` build one array the Splits factory has to accept in
    // a single call, so a ceiling stays.
    uint256 internal constant MAX_PROJECTS = 64;

    enum Phase { Contribution, Tallied, Allocated, Settled }

    struct Project {
        address payout;
        euint256 sumRoot;      // Σ√cᵢ
        euint256 sumC;         // Σcᵢ
        euint256 matchHandle;  // Sp² − Cp
        euint256 allocHandle;  // M·matchₚ/Σmatchₚ (public-decryptable after Allocated)
        uint256 revealedAlloc; // filled by revealAllocation()
        bool revealed;
        // Retained deliberately even though nothing reads it any more: it sits at
        // tuple index 7 of the generated `projects(uint256)` getter, and removing
        // it would shift `name` down an index and break every caller decoding an
        // already-deployed round. Storage layout is an interface.
        bool exists;
        // Appended LAST on purpose: the auto-generated `projects(uint256)` getter
        // returns members in declaration order, so adding this at the end keeps
        // every existing tuple index stable for callers.
        string name;           // display label; grantee identity is public by design
    }

    // Not immutable: the only powers left here are registering projects and
    // sweeping an undistributed pool, and both belong to whoever is actually
    // running the round. Transferable means that can be a multisig or a DAO rather
    // than permanently the EOA that happened to send the deployment transaction.
    address public operator;
    IERC7984 public immutable cToken;        // confidential donation token
    IERC20 public immutable matchingToken;   // plaintext token holding pool M
    ISplitFactoryV2 public immutable splitFactory;
    // M, public by design. NOT immutable: anyone may top it up while the round is
    // open (see fundPool), so a matching pool can itself be crowdfunded rather
    // than depending on one sponsor deciding the number up front.
    uint256 public matchingPool;
    uint64 public immutable contributionDeadline;

    address public pendingOperator;

    Phase public phase;
    address public settledSplit;
    uint256 public revealedCount;

    // How far the tally, allocation and escrow-forwarding passes have got. All
    // three are resumable, so a round with more projects than fit in one block
    // can still be driven to completion — see finalizeTallyPaged.
    uint256 public tallyCursor;
    uint256 public allocCursor;
    uint256 public forwardCursor;

    // Donor's RUNNING TOTAL per project, viewer-granted so they can decrypt it in
    // their wallet (Snap) — the coercion-resistance path: you can see what you
    // gave, but can't prove it to anyone.
    mapping(address => mapping(uint256 => euint256)) public myContribution;

    // Whether this donor has already given to this project. Plaintext on purpose:
    // participation is ALREADY public (the Contributed event names the donor and
    // the project) — only amounts are secret. Knowing this in plaintext lets us
    // skip a 164-op sqrt on a donor's first contribution.
    mapping(address => mapping(uint256 => bool)) public hasGiven;

    Project[] public projects;
    euint256 internal sumMatch;

    euint256[SQRT_BITS] internal BIT;
    euint256 internal EZERO;
    euint256 internal EONE;
    euint256 internal ECAP;

    event ProjectRegistered(uint256 indexed id, address payout, string name);
    event Contributed(uint256 indexed id, address indexed donor);
    event AllocationRevealed(uint256 indexed id, uint256 amount);
    event Settled(address split);
    event PoolFunded(address indexed from, uint256 amount, uint256 newTotal);
    event PoolSwept(address indexed to, uint256 amount);
    event OperatorTransferStarted(address indexed from, address indexed to);
    event OperatorTransferred(address indexed from, address indexed to);

    error NotOperator();
    error WrongPhase();
    error DeadlineNotReached();
    error DeadlinePassed();
    error BadDecryption();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(
        IERC7984 cToken_,
        IERC20 matchingToken_,
        ISplitFactoryV2 splitFactory_,
        uint256 matchingPool_,
        uint64 contributionDeadline_
    ) {
        operator = msg.sender;
        cToken = cToken_;
        matchingToken = matchingToken_;
        splitFactory = splitFactory_;
        matchingPool = matchingPool_;
        contributionDeadline = contributionDeadline_;

        EZERO = Nox.toEuint256(0);
        EONE = Nox.toEuint256(1);
        ECAP = Nox.toEuint256(CONTRIB_CAP);
        Nox.allowThis(EZERO);
        Nox.allowThis(EONE);
        Nox.allowThis(ECAP);
        sumMatch = EZERO;
        for (uint256 i; i < SQRT_BITS; ++i) {
            BIT[i] = Nox.toEuint256(uint256(1) << i);
            Nox.allowThis(BIT[i]);
        }
    }

    // ── Setup ────────────────────────────────────────────────────────────────

    function registerProject(address payout, string calldata name)
        external
        onlyOperator
        returns (uint256 id)
    {
        if (phase != Phase.Contribution) revert WrongPhase();
        require(projects.length < MAX_PROJECTS, "too many projects");
        // A zero payout BRICKS THE ROUND. Settlement forwards each project its
        // escrowed donations, ERC-7984 rejects address(0) as a receiver, and a
        // project's payout can never be edited — so one typo here leaves a round
        // that can never leave Allocated and donor escrow locked in this contract
        // forever. That is the exact failure the permissionless pipeline and
        // sweepPool were added to rule out, reachable through the one input the
        // operator still controls. Costs a single comparison to close.
        require(payout != address(0), "zero payout");
        id = projects.length;
        Project storage p = projects.push();
        p.payout = payout;
        p.name = name;
        p.sumRoot = EZERO;
        p.sumC = EZERO;
        p.exists = true;
        emit ProjectRegistered(id, payout, name);
    }

    /// @notice Hand the operator role to another address — typically a multisig.
    /// @dev Two-step on purpose: `pendingOperator` must accept, so a typo cannot
    ///      strand the role at an address nobody controls. That matters more than
    ///      usual here because the operator is the only party who can register
    ///      projects, and a round whose projects can never be registered is dead.
    function transferOperator(address to) external onlyOperator {
        pendingOperator = to;
        emit OperatorTransferStarted(operator, to);
    }

    function acceptOperator() external {
        require(msg.sender == pendingOperator, "not pending operator");
        emit OperatorTransferred(operator, pendingOperator);
        operator = pendingOperator;
        pendingOperator = address(0);
    }

    /// @notice Top up the matching pool. Permissionless and open to anyone while
    ///         the round is accepting contributions — the pool is public by
    ///         design, so there is nothing to hide and no reason to gate it.
    /// @dev Pulls `amount` of the PLAINTEXT matching token and raises M by exactly
    ///      what arrived, so a fee-on-transfer token cannot inflate M beyond the
    ///      balance actually held. Closed once contributions close, because M is
    ///      an input to allocations and must not move under a computed tally.
    function fundPool(uint256 amount) external {
        if (phase != Phase.Contribution) revert WrongPhase();
        if (block.timestamp > contributionDeadline) revert DeadlinePassed();
        uint256 before = matchingToken.balanceOf(address(this));
        require(matchingToken.transferFrom(msg.sender, address(this), amount), "transfer failed");
        uint256 received = matchingToken.balanceOf(address(this)) - before;
        matchingPool += received;
        emit PoolFunded(msg.sender, received, matchingPool);
    }

    /// @notice Recover whatever matching token is left once the round has settled.
    /// @dev Settled is the only guard that matters, and it is doing all the work:
    ///      before it, the pool is an input to a computation nobody may disturb;
    ///      after it, M has already been transferred to the split and distributed,
    ///      so anything still sitting here is by definition surplus.
    ///
    ///      It used to additionally require `settledSplit == address(0)` — the
    ///      all-whale case, where no project earned match, no split was created,
    ///      and the whole pool stayed put. That is the LOUD case, not the only one.
    ///      A round that settled normally strands any matching token sent to this
    ///      address directly rather than through `fundPool`, which anyone can do
    ///      with one ERC-20 call, and that condition locked exactly those funds
    ///      forever. Dropping the check covers both cases with less code.
    ///
    ///      Never touches donations: those are cUSDC and left in `settle`.
    function sweepPool(address to) external onlyOperator {
        if (phase != Phase.Settled) revert WrongPhase();
        uint256 amount = matchingToken.balanceOf(address(this));
        require(amount > 0, "nothing to sweep");
        require(matchingToken.transfer(to, amount), "transfer failed");
        emit PoolSwept(to, amount);
    }

    // ── Contribution ──────────────────────────────────────────────────────────

    /// @notice Donate an encrypted amount. Donor must first `setOperator(this)`
    ///         on cToken. The proof binds the handle to (msg.sender, this) — do
    ///         NOT route through a router/multicall or fromExternal reverts.
    /// @dev We accumulate the ACTUALLY transferred amount (ERC-7984 caps at the
    ///      donor's balance and returns the real figure) — a donor can't earn QF
    ///      weight beyond what they truly escrowed.
    /// @param viewer address allowed to decrypt the donor's own contribution
    ///        (the donor's Snap-derived Nox identity, or their EOA, or 0 to skip).
    function contribute(
        uint256 projectId,
        externalEuint256 encAmount,
        bytes calldata proof,
        address viewer
    ) external {
        if (phase != Phase.Contribution) revert WrongPhase();
        if (block.timestamp > contributionDeadline) revert DeadlinePassed();
        Project storage p = projects[projectId];

        euint256 c = Nox.fromExternal(encAmount, proof);
        Nox.allowTransient(c, address(cToken)); // let the token spend this handle
        euint256 escrowed = cToken.confidentialTransferFrom(msg.sender, address(this), c);
        Nox.allowThis(escrowed);

        // QF weights a project by (Σ√cᵢ)² where i ranges over DONORS, not over
        // transactions. Taking √ per transaction would let one donor split a
        // donation across N txs and multiply their own weight by √N — a sybil
        // attack needing no extra addresses. So we keep a per-donor running
        // total, and swap that donor's OLD root out for their NEW one.
        bool repeat = hasGiven[msg.sender][projectId];
        euint256 prevTotal = repeat ? myContribution[msg.sender][projectId] : EZERO;
        euint256 newTotal = repeat ? Nox.add(prevTotal, escrowed) : escrowed;

        hasGiven[msg.sender][projectId] = true;
        myContribution[msg.sender][projectId] = newTotal;
        Nox.allowThis(newTotal);
        if (viewer != address(0)) Nox.addViewer(newTotal, viewer);

        euint256[] memory bits = _bits();
        euint256 newRoot = Isqrt.sqrt(_clampForSqrt(newTotal), bits, EZERO);
        if (repeat) {
            // Invariant: p.sumRoot already contains prevRoot (we added it on this
            // donor's previous contribution), so the plain sub cannot underflow.
            // Costs a second 164-op sqrt — only for donors who give again.
            euint256 prevRoot = Isqrt.sqrt(_clampForSqrt(prevTotal), bits, EZERO);
            p.sumRoot = Nox.add(Nox.sub(p.sumRoot, prevRoot), newRoot);
        } else {
            p.sumRoot = Nox.add(p.sumRoot, newRoot);
        }
        p.sumC = Nox.add(p.sumC, escrowed);
        Nox.allowThis(p.sumRoot); // MANDATORY: unlisted result handle dies next tx
        Nox.allowThis(p.sumC);

        emit Contributed(projectId, msg.sender);
    }

    // ── Tally (encrypted) ─────────────────────────────────────────────────────

    /// @notice matchₚ = Sp² − Cp (clamped ≥0), summed into sumMatch. After
    ///         deadline, once. Loops all projects — keep K small for the demo.
    /// @dev PERMISSIONLESS by design. This step and every step after it are
    ///      fully deterministic — the phase guards and the deadline fix the only
    ///      valid ordering, and there is no operator discretion left to exercise.
    ///      Gating them on the operator would mean a silent or unwilling operator
    ///      could strand donor escrow in this contract forever. Any donor can
    ///      now push a round to completion; the caller just pays the gas.
    function finalizeTally() external {
        _finalizeTally(type(uint256).max);
    }

    /// @notice Tally at most `maxCount` more projects. Resumable: call repeatedly
    ///         until the phase flips to Tallied.
    /// @dev Removes the block-gas ceiling on project count. Each project costs
    ///      ~130k here, so ~64 projects fit one block comfortably today — but that
    ///      is a property of the current limit, not of the design, and a round
    ///      whose loop no longer fits would otherwise be permanently unfinishable.
    function finalizeTallyPaged(uint256 maxCount) external {
        _finalizeTally(maxCount);
    }

    function _finalizeTally(uint256 maxCount) internal {
        if (phase != Phase.Contribution) revert WrongPhase();
        if (block.timestamp <= contributionDeadline) revert DeadlineNotReached();
        require(maxCount > 0, "maxCount = 0");

        uint256 end = _pageEnd(tallyCursor, maxCount);
        for (uint256 i = tallyCursor; i < end; ++i) {
            Project storage p = projects[i];
            euint256 sq = Nox.mul(p.sumRoot, p.sumRoot);
            (, euint256 matchP) = Nox.safeSub(sq, p.sumC); // 0 if Cp > Sp²
            p.matchHandle = matchP;
            Nox.allowThis(p.matchHandle);
            sumMatch = Nox.add(sumMatch, matchP);
            Nox.allowThis(sumMatch);
        }
        tallyCursor = end;
        // Only advance once EVERY project is tallied — sumMatch is the divisor for
        // every allocation, so a partial tally must never be visible to the next phase.
        if (end == projects.length) phase = Phase.Tallied;
    }

    /// @notice allocₚ = M·matchₚ/Σmatchₚ, marked publicly decryptable. Guarded
    ///         against Σmatchₚ == 0 (empty round) via select.
    /// @dev Permissionless — see the note on `finalizeTally`.
    function computeAllocations() external {
        _computeAllocations(type(uint256).max);
    }

    /// @notice Allocate at most `maxCount` more projects. Resumable, like the tally.
    function computeAllocationsPaged(uint256 maxCount) external {
        _computeAllocations(maxCount);
    }

    function _computeAllocations(uint256 maxCount) internal {
        if (phase != Phase.Tallied) revert WrongPhase();
        require(maxCount > 0, "maxCount = 0");
        // sumMatch is final for the whole phase, so recomputing the divisor per page
        // is safe — every page divides by exactly the same number.
        euint256 Menc = Nox.toEuint256(matchingPool);
        Nox.allowThis(Menc);
        ebool empty = Nox.eq(sumMatch, EZERO);
        euint256 denom = Nox.select(empty, EONE, sumMatch); // avoid div-by-zero saturation

        uint256 end = _pageEnd(allocCursor, maxCount);
        for (uint256 i = allocCursor; i < end; ++i) {
            Project storage p = projects[i];
            euint256 alloc = Nox.div(Nox.mul(Menc, p.matchHandle), denom);
            p.allocHandle = alloc;
            Nox.allowThis(p.allocHandle);
            Nox.allowPublicDecryption(p.allocHandle);
        }
        allocCursor = end;
        if (end == projects.length) phase = Phase.Allocated;
    }

    // ── Reveal (2-tx: off-chain publicDecrypt -> verify here) ──────────────────

    /// @notice Verify the gateway-signed decryption of allocₚ and record it.
    ///         Anyone can submit the proof; the contract trusts only the
    ///         gateway signature, never the caller's claimed number.
    function revealAllocation(uint256 projectId, uint256 amount, bytes calldata decryptionProof)
        external
    {
        if (phase != Phase.Allocated) revert WrongPhase();
        Project storage p = projects[projectId];
        if (p.revealed) return;
        if (Nox.publicDecrypt(p.allocHandle, decryptionProof) != amount) revert BadDecryption();
        p.revealedAlloc = amount;
        p.revealed = true;
        revealedCount++;
        emit AllocationRevealed(projectId, amount);
    }

    // ── Forward escrow (encrypted, resumable) ─────────────────────────────────

    /// @notice Deliver at most `maxCount` more projects their escrowed donations,
    ///         still encrypted. Resumable, permissionless, and safe to skip
    ///         entirely — `settle` forwards whatever is left.
    /// @dev This existed only inside `settle` before, which left ONE unbounded
    ///      loop in a contract whose other two had been made resumable for
    ///      exactly this reason. It is also the expensive one: a confidential
    ///      transfer is ~187k, so 64 projects is ~12M of `settle`'s cost, next to
    ///      a Splits `createSplit` in the same transaction. That fits a 60M
    ///      Sepolia block today — but "today's gas limit" is the argument the
    ///      paged tally was written to stop relying on, and it applies here
    ///      unchanged.
    ///
    ///      Allowed from Allocated so it can be drained ahead of settlement. Not
    ///      earlier: `sumC` must be final, and a project's own payout learning its
    ///      escrow before the round is allocated changes nothing about the maths
    ///      but does hand it the money before the round agrees it is over.
    function forwardEscrowPaged(uint256 maxCount) external nonReentrant {
        if (phase != Phase.Allocated) revert WrongPhase();
        require(maxCount > 0, "maxCount = 0");
        _forwardEscrow(maxCount);
    }

    /// @dev Σ over projects of sumC == the round's whole escrowed balance, and
    ///      ERC-7984 caps a transfer at the balance, so this can never overdraw
    ///      however it is sliced. The cursor is what makes it idempotent: a
    ///      project already forwarded is never behind it again.
    function _forwardEscrow(uint256 maxCount) internal {
        uint256 end = _pageEnd(forwardCursor, maxCount);
        // A round that never received a donation has never held cUSDC, so its
        // balance HANDLE was never initialised — and ERC-7984 reverts on a
        // transfer from an uninitialised handle even when the amount is an
        // encrypted zero. Without this check, a round with projects registered
        // and no contributions could never settle: the forward loop reverted
        // every time, the phase stuck at Allocated, and the matching pool was
        // locked in here forever because sweepPool only opens once Settled.
        // Nothing to send is not an error, so advance the cursor and move on.
        if (Nox.isInitialized(cToken.confidentialBalanceOf(address(this)))) {
            for (uint256 i = forwardCursor; i < end; ++i) {
                Nox.allowTransient(projects[i].sumC, address(cToken));
                cToken.confidentialTransfer(projects[i].payout, projects[i].sumC);
            }
        }
        forwardCursor = end;
    }

    // ── Settle (public: matching pool -> Splits V2) ────────────────────────────

    /// @notice Once every allocation is revealed: forward the escrowed
    ///         confidential donations to each project, then create a 0xSplits V2
    ///         split with the QF weights and push the matching pool through it.
    /// @dev The raw donations move as cToken and stay ENCRYPTED — no unwrap flow
    ///      needed here. Each payout receives cUSDC and can unwrap on its own
    ///      schedule, so per-project raw totals never become public either.
    /// @dev Permissionless — see the note on `finalizeTally`. Recipients and
    ///      weights come from already-revealed on-chain state, so the caller
    ///      cannot influence who gets paid what.
    function settle() external nonReentrant {
        if (phase != Phase.Allocated) revert WrongPhase();
        if (revealedCount != projects.length) revert WrongPhase();
        require(matchingToken.balanceOf(address(this)) >= matchingPool, "pool underfunded");

        uint256 n = projects.length;
        address[] memory recipients = new address[](n);
        uint256[] memory allocations = new uint256[](n);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            recipients[i] = projects[i].payout;
            allocations[i] = projects[i].revealedAlloc;
            total += projects[i].revealedAlloc;
        }

        // effects before value-moving interactions (nonReentrant also guards)
        phase = Phase.Settled;

        // Forward whatever forwardEscrowPaged has not already delivered. On a
        // round nobody paged, that is all of it and this behaves exactly as it
        // always did; on one that was paged to completion, it is a no-op.
        _forwardEscrow(type(uint256).max);

        // QF weights only exist if some project earned match. In an all-whale
        // round every matchₚ == 0, so there is nothing to weight the pool by, no
        // split is created, and the pool stays here — which is precisely the
        // `settledSplit == address(0)` condition `sweepPool` recovers from.
        if (total > 0) {
            Split memory s = Split({
                recipients: recipients,
                allocations: allocations,
                totalAllocation: total,
                distributionIncentive: 0
            });
            address split = splitFactory.createSplit(s, address(0), address(this)); // ownerless
            settledSplit = split;

            require(matchingToken.transfer(split, matchingPool), "transfer failed");
            IPushSplit(split).distribute(s, address(matchingToken), address(this));
        }
        emit Settled(settledSplit);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    /// @dev Where a page ends: `cursor + maxCount`, clamped to the project count.
    ///
    ///      Written this way for one reason. The unpaged entry points call the
    ///      paged internals with `type(uint256).max`, and `cursor + max` PANICS on
    ///      overflow the moment `cursor` is non-zero. So after any paged call had
    ///      advanced a cursor, the matching unpaged "just finish it" function
    ///      reverted — exactly when a caller reaches for it. Nothing was strandable
    ///      (calling the paged version again always worked) but it is a revert
    ///      where none is meant to exist, and it only shows up in the mixed order.
    function _pageEnd(uint256 cursor, uint256 maxCount) internal view returns (uint256) {
        uint256 n = projects.length;
        unchecked {
            return maxCount >= n - cursor ? n : cursor + maxCount;
        }
    }

    /// @dev Clamp the sqrt input to CONTRIB_CAP so the 41-bit search is always
    ///      exact — we cannot `require(x <= cap)` on an encrypted value. Doubles
    ///      as a legitimate anti-whale QF weight cap; the full amount still
    ///      counts toward sumC (raw contributions).
    function _clampForSqrt(euint256 v) internal returns (euint256) {
        return Nox.select(Nox.le(v, ECAP), v, ECAP);
    }

    function _bits() internal view returns (euint256[] memory bits) {
        bits = new euint256[](SQRT_BITS);
        for (uint256 i; i < SQRT_BITS; ++i) bits[i] = BIT[i];
    }

    function projectCount() external view returns (uint256) {
        return projects.length;
    }
}
