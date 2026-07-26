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
    // ponytail: hard cap bounds the finalizeTally/computeAllocations loop gas.
    // A budgeting round has tens of teams, not thousands. Upgrade path if ever
    // needed: paginate finalizeTally(from,to) / computeAllocations(from,to).
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
        bool exists;
    }

    address public immutable operator;
    IERC7984 public immutable cToken;        // confidential donation token
    IERC20 public immutable matchingToken;   // plaintext token holding pool M
    ISplitFactoryV2 public immutable splitFactory;
    uint256 public immutable matchingPool;   // M, public by design
    uint64 public immutable contributionDeadline;

    Phase public phase;
    address public settledSplit;
    uint256 public revealedCount;

    // Donor's own contribution handle, viewer-granted so they can decrypt it in
    // their wallet (Snap) — the coercion-resistance path: you can see what you
    // gave, but can't prove it to anyone. ponytail: keeps the LATEST handle per
    // (donor, project); accumulate if per-contribution history is ever needed.
    mapping(address => mapping(uint256 => euint256)) public myContribution;

    Project[] public projects;
    euint256 internal sumMatch;

    euint256[SQRT_BITS] internal BIT;
    euint256 internal EZERO;
    euint256 internal EONE;
    euint256 internal ECAP;

    event ProjectRegistered(uint256 indexed id, address payout);
    event Contributed(uint256 indexed id, address indexed donor);
    event AllocationRevealed(uint256 indexed id, uint256 amount);
    event Settled(address split);

    error NotOperator();
    error WrongPhase();
    error DeadlineNotReached();
    error DeadlinePassed();
    error UnknownProject();
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

    function registerProject(address payout) external onlyOperator returns (uint256 id) {
        if (phase != Phase.Contribution) revert WrongPhase();
        require(projects.length < MAX_PROJECTS, "too many projects");
        id = projects.length;
        Project storage p = projects.push();
        p.payout = payout;
        p.sumRoot = EZERO;
        p.sumC = EZERO;
        p.exists = true;
        emit ProjectRegistered(id, payout);
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
        if (!p.exists) revert UnknownProject();

        euint256 c = Nox.fromExternal(encAmount, proof);
        Nox.allowTransient(c, address(cToken)); // let the token spend this handle
        euint256 escrowed = cToken.confidentialTransferFrom(msg.sender, address(this), c);
        Nox.allowThis(escrowed);

        // record the donor's own contribution handle + grant them decrypt rights
        myContribution[msg.sender][projectId] = escrowed;
        if (viewer != address(0)) Nox.addViewer(escrowed, viewer);

        // Clamp the sqrt input to CONTRIB_CAP so the 41-bit search is always
        // exact (can't `require(escrowed <= cap)` on an encrypted value). This
        // doubles as a legitimate anti-whale QF weight cap; the full `escrowed`
        // still counts toward sumC (raw contributions).
        euint256 forSqrt = Nox.select(Nox.le(escrowed, ECAP), escrowed, ECAP);
        euint256 root = Isqrt.sqrt(forSqrt, _bits(), EZERO);
        p.sumRoot = Nox.add(p.sumRoot, root);
        p.sumC = Nox.add(p.sumC, escrowed);
        Nox.allowThis(p.sumRoot); // MANDATORY: unlisted result handle dies next tx
        Nox.allowThis(p.sumC);

        emit Contributed(projectId, msg.sender);
    }

    // ── Tally (encrypted) ─────────────────────────────────────────────────────

    /// @notice matchₚ = Sp² − Cp (clamped ≥0), summed into sumMatch. After
    ///         deadline, once. Loops all projects — keep K small for the demo.
    function finalizeTally() external onlyOperator {
        if (phase != Phase.Contribution) revert WrongPhase();
        if (block.timestamp <= contributionDeadline) revert DeadlineNotReached();

        for (uint256 i; i < projects.length; ++i) {
            Project storage p = projects[i];
            euint256 sq = Nox.mul(p.sumRoot, p.sumRoot);
            (, euint256 matchP) = Nox.safeSub(sq, p.sumC); // 0 if Cp > Sp²
            p.matchHandle = matchP;
            Nox.allowThis(p.matchHandle);
            sumMatch = Nox.add(sumMatch, matchP);
            Nox.allowThis(sumMatch);
        }
        phase = Phase.Tallied;
    }

    /// @notice allocₚ = M·matchₚ/Σmatchₚ, marked publicly decryptable. Guarded
    ///         against Σmatchₚ == 0 (empty round) via select.
    function computeAllocations() external onlyOperator {
        if (phase != Phase.Tallied) revert WrongPhase();
        euint256 Menc = Nox.toEuint256(matchingPool);
        Nox.allowThis(Menc);
        ebool empty = Nox.eq(sumMatch, EZERO);
        euint256 denom = Nox.select(empty, EONE, sumMatch); // avoid div-by-zero saturation

        for (uint256 i; i < projects.length; ++i) {
            Project storage p = projects[i];
            euint256 alloc = Nox.div(Nox.mul(Menc, p.matchHandle), denom);
            p.allocHandle = alloc;
            Nox.allowThis(p.allocHandle);
            Nox.allowPublicDecryption(p.allocHandle);
        }
        phase = Phase.Allocated;
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
        if (!p.exists) revert UnknownProject();
        if (p.revealed) return;
        if (Nox.publicDecrypt(p.allocHandle, decryptionProof) != amount) revert BadDecryption();
        p.revealedAlloc = amount;
        p.revealed = true;
        revealedCount++;
        emit AllocationRevealed(projectId, amount);
    }

    // ── Settle (public: matching pool -> Splits V2) ────────────────────────────

    /// @notice Once every allocation is revealed: forward the escrowed
    ///         confidential donations to each project, then create a 0xSplits V2
    ///         split with the QF weights and push the matching pool through it.
    /// @dev The raw donations move as cToken and stay ENCRYPTED — no unwrap flow
    ///      needed here. Each payout receives cUSDC and can unwrap on its own
    ///      schedule, so per-project raw totals never become public either.
    function settle() external onlyOperator nonReentrant {
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

        // Forward each project's escrowed contributions, still confidential.
        // Σ over projects of sumC == the round's whole escrowed balance, and
        // ERC-7984 caps at balance, so this can't overdraw.
        for (uint256 i; i < n; ++i) {
            Nox.allowTransient(projects[i].sumC, address(cToken));
            cToken.confidentialTransfer(projects[i].payout, projects[i].sumC);
        }

        // QF weights only exist if some project earned match. In an all-whale
        // round every matchₚ == 0, so there is nothing to weight the pool by.
        // ponytail: pool then stays in this contract — no sweep path, because a
        // real round always has one non-whale project. Add `sweepPool(address)`
        // if a deployment must be able to recover it.
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

    function _bits() internal view returns (euint256[] memory bits) {
        bits = new euint256[](SQRT_BITS);
        for (uint256 i; i < SQRT_BITS; ++i) bits[i] = BIT[i];
    }

    function projectCount() external view returns (uint256) {
        return projects.length;
    }
}
