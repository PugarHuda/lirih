# Lirih — confidential quadratic funding on iExec Nox

**Your donation stays secret. The allocation is public. With the Snap installed,
you cannot prove to anyone how you gave.**

Lirih is confidential participatory budgeting: an organisation splits a matching
pool across projects/teams, but every contribution amount is encrypted
end-to-end via [iExec Nox](https://docs.noxprotocol.io). Quadratic-funding
weights are computed inside a TEE; **only the final per-project allocation is
ever decrypted.** When you cannot prove how you donated, bribery and coercion
lose their grip — the property [MACI](https://maci.pse.dev) gets from ZK, Lirih
gets from a TEE, with full DeFi composability.

That last property is conditional and this README will not pretend otherwise:
it holds on the MetaMask Snap path and **not** on the fallback path, where your
EOA holds the viewing role and can sign to prove an amount. The UI says which
mode is live. Full explanation in [Coercion resistance, and its
condition](#coercion-resistance-and-its-condition).

Settlement lands in an **unmodified [0xSplits V2](https://splits.org)** split on
Ethereum Sepolia. The target protocol is never forked or modified.

Submission for the iExec WTF Hackathon Summer Edition.

## What is new, and what is not

**Every line of this codebase was written during the hackathon.** Nothing was
carried over from Diam, the confidential OTC desk the same author built for the
Vibe Coding hackathon, or from any other prior project — different mechanism
(quadratic funding, not an RFQ), different integrated protocol (0xSplits, not a
peer-to-peer settlement), different chain. The only third-party code here is
upstream and unmodified: iExec Nox, OpenZeppelin, and 0xSplits V2.

## How privacy is added (say the pattern out loud)

ERC-7984 handles are encrypted; a public splitter needs plaintext at its
boundary. Lirih uses the **aggregate-reveal** pattern: N encrypted contributions
are reduced to one public per-project number inside the TEE. Individual
donations — and who gave to whom — never touch the chain.

## Architecture

```
Donor ── encrypt(amount) ─► LirihRound (Nox)
                              │  Σ√cᵢ, Σcᵢ  per project (encrypted)
                              │  matchₚ = Sp²−Cp ; allocₚ = M·matchₚ/Σmatchₚ
                              │  reveal ONLY allocₚ (gateway-signed, 2-tx)
                              ▼
                         0xSplits V2 PushSplit  (unmodified) ─► project payouts
MetaMask Snap ── holds the VIEWING key in the SES sandbox; decrypt-your-own runs there
```

## Packages

| Package | What |
|---|---|
| `packages/contracts` | `LirihRound.sol` + `Isqrt.sol` (encrypted integer sqrt) + `cUSDC` wrapper + Splits interface. Hardhat 3 + Nox plugin. |
| `packages/web` | Next.js donor flow (faucet → wrap → confidential donate), live at [lirih.vercel.app](https://lirih.vercel.app). Playwright tests drive it in a real browser. |
| `packages/snap` | MetaMask Snap: in-sandbox VIEWING key + decrypt-your-own-contribution. It does not encrypt — see below. |
| `reference/` | `qf-reference.mjs` — plaintext oracle proving the sqrt + QF math. |

## Quick start

**Just want to see it work? → [lirih.vercel.app](https://lirih.vercel.app)** —
deployed, pointed at a round that is **open for contributions until 2026-08-05**.
Donate to it, read your own donation back, top up the matching pool. Nothing to
install and no deploy. Details in [Frontend](#frontend).

To run the whole thing yourself:

```bash
# contracts
cd packages/contracts
npm install
npx hardhat compile
# needs Docker Desktop running (the Nox plugin boots the offchain stack):
npx hardhat test
# deploy (needs a funded DEPLOYER_PRIVATE_KEY — see below):
CONTRIB_WINDOW_SECS=5400 npx hardhat run scripts/deploy-sepolia.ts --network sepolia
# seed real confidential donations from distinct donors, then run the operator flow
ROUND_ADDRESS=… CUSDC_ADDRESS=… MUSDC_ADDRESS=… npx hardhat run scripts/seed-round.ts --network sepolia
ROUND_ADDRESS=… npx hardhat run scripts/run-round.ts --network sepolia  # after the deadline

# reference math (no deps, no toolchain)
node reference/qf-reference.mjs

# the donor UI, and the Snap that holds your viewing key
cd ../web  && npm install && npm run dev
cd ../snap && npm install && npm run build && npm run serve
```

Copy [`.env.example`](./.env.example) → `packages/contracts/.env` and fill in your
key (the Hardhat config loads the `.env` sitting next to it). Nox on Ethereum
Sepolia is live: `NoxCompute 0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF`.

The frontend reads its addresses from `packages/web/.env.local`; the deploy
script prints the exact block to paste.

## Why integer sqrt is the hard part

Quadratic funding needs `√cᵢ`. Nox has no `sqrt` and no bit ops, so Newton can't
be seeded to converge in a fixed loop. `Isqrt.sol` uses a bounded bit-by-bit
binary search (proven exact over `[0, 1e24]` in `reference/`), and the
contribution domain cap lets it run in 41 bits (164 encrypted ops) instead of
128. Full write-up in [`feedback.md`](./feedback.md).

## Two live rounds on Ethereum Sepolia

Both run the contract **as it stands on this branch**, and both are
source-verified. A settled round is a read-only artefact, so there is also an
open one you can actually use.

### The settled round — what quadratic funding does

Round [`0x4f15c2a6…`](https://sepolia.etherscan.io/address/0x4f15c2a627e3f8e866a83fc57f3aa0897ad47399)
ran end to end on 2026-07-29 — encrypted contributions, QF computed under
encryption, allocations revealed by gateway-signed proof, settled into a real
[0xSplits V2](https://sepolia.etherscan.io/address/0x5B323E1CB8A09D776EC065A05540bc21468c5aed)
PushSplit:

| Project | Raised | Donors | Matching received |
|---|---|---|---|
| Clean Water Initiative | 200 | **two** | **9,999.999999999999999999 mUSDC** |
| Open Source Maintainers | **900** | one | **0** |

**The whale raised 4.5× more money and earned zero matching.** That is quadratic
funding doing its job, and at no point was any individual donation amount public
— only the two final allocations were ever decrypted. Verified by reading the
chain rather than trusting the script's output: phase `Settled`, the split has
code, 9,999.999999999999999999 mUSDC actually arrived at the crowd-funded
project's payout (the last wei is integer-division dust), the whale's payout
holds nothing, and **both** projects hold non-zero *encrypted* cUSDC — the
escrowed donations were forwarded confidentially, so even the per-project raw
totals never became public.

Gas: `finalizeTally` 309k · `computeAllocations` 287k · `revealAllocation`
99k/62k · `settle` 671k.

### The open round — go and use it

Round [`0x6cc49586…`](https://sepolia.etherscan.io/address/0x6cc49586e37d1d0d53c6836d76db0f38c280f5de)
takes contributions until **2026-08-05**, and it is what `packages/web/.env.local`
points at. Donate to it, decrypt your own contribution, top up the matching pool,
and after the deadline drive it to settlement yourself from the browser.

It is seeded with cases chosen to demonstrate things rather than to look busy,
and each was a path with no prior on-chain execution:

- **A repeat donation.** Two donors gave 100 twice each. The second contribution
  cost **3.62M gas against 2.07M** — that is the second encrypted square root,
  the price of rooting each donor's running total instead of each transaction —
  and decrypting that donor's own handle returns **200**, not the last 100. This
  is the sybil fix, on-chain, rather than in a test.
- **A crowdfunded pool.** `fundPool` called by a **non-operator** took the
  matching pool from 10,000 to **12,500**. Permissionless while the round is
  open, and now demonstrated rather than described.
- **A donation past the anti-whale cap.** 2,000,000 mUSDC against a sqrt domain
  capped at 1e24, so `_clampForSqrt` engaged. The excess still escrows and still
  reaches the project; it just buys no further matching weight.
- **A donation placed from a headless browser**, by the wallet-injected
  Playwright spec, which is how the whole donor path is known to work rather
  than assumed to.

| Contract | Address |
|---|---|
| LirihRound — settled | `0x4f15c2a627e3f8e866a83fc57f3aa0897ad47399` |
| LirihRound — open until 2026-08-05 | `0x6cc49586e37d1d0d53c6836d76db0f38c280f5de` |
| cUSDC (ERC-7984), shared | `0x763da807dd237053fc4f7aaef0e128fbcf37756b` |
| MockUSDC, shared | `0x4e41423064e8baca5df7e651bd29c9a25c98d24f` |
| 0xSplits V2 PushSplit (created by settle) | `0x5B323E1CB8A09D776EC065A05540bc21468c5aed` |
| PushSplitFactory V2.2 (unmodified, upstream) | `0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4` |

An [earlier settled round](https://sepolia.etherscan.io/address/0x3627a23a2a1d767ec993d96c9ed3dd4aad9c84b2)
from 2026-07-27 produced the same result on an older revision of the contract.

## Verified against live Nox on Ethereum Sepolia

No mock data on the confidential path — these are measured numbers from the live
gateway and Runner on chainId `11155111`, not the local test stack:

| Step | Result |
|---|---|
| `encryptInput` (gateway encrypts inside its TEE) | 2.3 s |
| `contribute` — `fromExternal` + 41-bit encrypted sqrt on-chain | **2,049,820 gas**, success |
| Donor decrypts their **own** contribution (ACL viewer, gasless) | correct plaintext, ~5 s after the tx |
| `Isqrt` exactness vs plaintext oracle | exact over a 5000-point sweep of `[0, 1e24]` |

Encrypted QF output matches the plaintext oracle in `reference/qf-reference.mjs`
before settlement is allowed to proceed.

Gas, measured on the Nox Runner at K=8 projects (`test/bench.test.ts`):

| Step | Gas | Per project |
|---|---|---|
| `contribute`, donor's first gift to a project (one sqrt) | 2.63M | — |
| `contribute`, same donor giving again (two sqrts — see below) | 4.73M | — |
| `finalizeTally` | 1,059k | ~132k |
| `computeAllocations` | 939k | ~117k |
| `settle` (incl. forwarding donations to every project) | 2,056k | ~187k |

`contribute` costs 2.05M on live Sepolia versus 2.60M on the local Runner. Each
contribution is its own transaction, so the donor count is never bounded by the
block gas limit.

**No per-project loop is bounded by a block.** All three resume:
`finalizeTallyPaged(n)` and `computeAllocationsPaged(n)` advance the phase only
once the last project lands — a partial tally must never be visible to the next
phase, because `sumMatch` is the divisor for every allocation — and
`forwardEscrowPaged(n)` delivers the escrowed donations, which is the expensive
one at ~187k of confidential transfer per project. That loop used to live only
inside `settle`, which left a single unbounded loop in a contract whose other two
had been made resumable for exactly this reason. `settle` now forwards whatever is
left, so skipping the paged call entirely behaves as it always did. At 64 projects
the whole path is ~27M and fits a single Sepolia block anyway, but "fits today's
gas limit" is the argument the paged tally was written to stop depending on.

Both unpaged entry points finish a partly-paged pass — which is not free: they
call the paged internals with `type(uint256).max`, and `cursor + max` **panics on
overflow** once the cursor is non-zero. Page-then-finish reverted until the page
arithmetic was rewritten to clamp instead of add. Every earlier test used one
style throughout, which is exactly why nothing caught it.

The test suite is **23 passing** against the real Nox stack: encrypted-sqrt
exactness, the full round versus a plaintext QF oracle, the splitting property
below, the gas benchmark, and nineteen guard tests covering phase ordering, deadline
enforcement, authorization, a forged decryption proof, an empty round, an
underfunded pool, crowdfunded top-ups, stranded-pool recovery, resumable pagination
across all three passes, page-then-finish, and a zero payout address.

## Splitting a donation buys no extra matching weight

Quadratic funding weights a project by `(Σ√cᵢ)²` where `i` ranges over **donors**,
not over transactions. Take the root per transaction instead and one donor can
split a gift across `N` transactions to multiply their own weight by `√N`, since
`N·√(c/N) = √N·√c` — a sybil attack that needs no extra addresses at all.

Lirih keeps an encrypted per-donor running total and swaps that donor's old root
out for their new one, so the weight depends only on what each donor gave in
total. `test/qf-semantics.test.ts` proves it: two projects with identical
per-donor totals `{A: 8, B: 8}` receive exactly equal matching even when A pays
one of them in two transactions. That second root is why a repeat contribution
costs ~1.8× a first one; donors who give once never pay it.

## Frontend

**Live: [lirih.vercel.app](https://lirih.vercel.app)** — a landing page at `/`
explaining the mechanism with numbers read live from the settled round, and the
donor app at `/app`. Nothing to install; connect a Sepolia wallet and donate.

The UI is a small dark design system rather than inline styles: tokens for every
colour and space, Space Grotesk / Inter / JetBrains Mono (tabular figures, because
two balances you cannot line up are two balances you cannot compare), 44px minimum
targets on anything that spends gas, visible focus rings, and
`prefers-reduced-motion` honoured. Icons are inline SVG — emoji render differently
on every platform, ignore `currentColor`, and are read aloud by their unicode name.

`packages/web/.env.local` is committed, so a local run reaches the same live state:

```bash
cd packages/web && npm install && npm run dev
```

It does three things worth clicking:

- **Choose a project, then give.** The projects are the interface, read from
  chain — quadratic funding is a contest *between* them, so a dropdown of ids made
  the one decision that matters abstract: you picked "1" and never saw who you
  were funding, or against whom. Then faucet → wrap to cUSDC → authorise the round
  → encrypted `contribute`, as labelled steps with an Etherscan link per
  transaction and a chain guard that offers to switch you to Sepolia.
- **Decrypt your own contribution, and nobody else's.** The running total comes
  back in plaintext for you alone, with the active viewing mode labelled.
- **Fund the matching pool.** Permissionless while the round is open, so the pool
  everyone is competing for can be crowdfunded rather than fixed by one sponsor at
  deployment. This amount is public by design; only donations are secret.
- **Advance the round — anyone can do this.** A phase-aware panel exposing
  `finalizeTally` → `computeAllocations` → `revealAllocation` → `settle`. Every
  one of those is permissionless, so a judge can drive a stalled round to
  settlement themselves rather than take the claim on trust. It offers only the
  step that is actually ready, and refuses to finalize before the deadline.

The donor buttons read the round's phase **before** offering to spend your gas.
Donating is the last of five transactions and the only one that reverts on a
closed round, so a phase-blind page would walk you through mint, approve, wrap
and authorize — four real transactions — before failing. A round spends most of
its life closed, so that is the common case: the page disables the flow, names
the phase, and points at what you can still do. It also warns before you exceed
the per-donor matching cap of 1,000,000 mUSDC, which is the bound that keeps the
encrypted square root exact — above it the money still reaches the project but
earns no further matching, and a donor who is not told reads that as a bug.

Addresses come from `packages/web/.env.local`; `scripts/deploy-sepolia.ts` prints
a replacement block if you deploy your own round.

### The write path is tested in a browser too

`e2e/wallet.ts` injects a real signing wallet as `window.ethereum` — an EIP-1193
provider backed by an ethers `Wallet`, not a mock of MetaMask. Transactions are
signed, broadcast and mined on real Sepolia, so the opt-in spec drives the whole
sequence a user actually performs and asserts the result on-chain.

That is where this project's real bugs lived, and read-only assertions cannot
reach any of them. It is **opt-in** because it spends gas:

```bash
WALLET_KEY=0x… npm run test:e2e            # skips without the key
```

It deliberately does NOT pretend a Snap is installed: `wallet_requestSnaps`
throws, the page falls back to the EOA viewer, and the spec asserts that the page
*says so* — which is the check that would catch a page quietly downgrading while
still calling itself coercion-resistant. Loading the Snap in MetaMask Flask is
still a human's job, because MetaMask's own RPC restrictions are the thing that
put the viewing key in the Snap to begin with.

It is laid out as a dashboard: a sidebar switching between **Donate / Results / How it works**, with the
contract's state pinned above the panels so it does not move when you do. The
panels are alternatives rather than steps, and in a single column the answer sat
below the question — you scrolled past what you came to read to reach what you
came to do. Below 900px the rail becomes a scrollable strip of tabs, because a
232px sidebar on a 375px screen leaves no room for the thing it navigates.

### The design claims are tested, not asserted

This README used to say the UI passes contrast, keeps focus rings, uses 44px
targets, honours `prefers-reduced-motion` and survives a phone. All of that was
written and none of it was checked, which is the same "claim stronger than the
evidence" pattern the rest of this project spent its life removing. So it gets
the same treatment: `quality.spec.ts` runs an axe scan over both pages, measures
every control that spends gas, tabs into the page and reads back the computed
outline, emulates reduced motion, and loads at 375px asserting the document does
not scroll sideways.

It found three real defects on the first run, all invisible on a desktop:
`--fg-dim` measured ~3.6:1 against the card surface where 4.5:1 was claimed; a
project/side `<select>` sized itself to its longest option and pushed the whole
page wider than a phone; and links inside running text were distinguished by
colour alone. Fixed, and the scan is now clean.

### The read path is tested against the deployed page

`npm run test:e2e` drives [lirih.vercel.app](https://lirih.vercel.app) in a real
Chromium and asserts against the live round. This is the gap that stayed open
longest here: `tsc` was clean and `next build` was clean on code that threw the
instant a browser ran it — a barrel import pulling in `ethers`, a peer dependency
whose exports map only exposes `"."`, so the deep import type-checked and then
failed to resolve. Nothing but opening the page catches that.

Five tests, no wallet — everything asserted is what a visitor sees *before*
connecting one, which is also what has to be right for anyone to get as far as
connecting. They check that the phase and the on-chain project names really come
back from Sepolia, that the donor buttons match the round's phase, that the
matching-weight cap warns before you cross it, and that the advance panel offers
only the step the round is actually ready for. A `pageerror` or a `console.error`
fails the run, because a swallowed rejection just looks like an empty page — which
is exactly how the `refresh().catch(() => {})` bug presented before it was found.

```bash
cd packages/web && npm run test:e2e            # against the deployed page
BASE=http://localhost:3000 npm run test:e2e    # against your own dev server
```

## Coercion resistance, and its condition

The reason to encrypt donations at all is that quadratic funding makes bribery
cheap: "show me you gave to my project and I'll pay you." Hiding the amount is
only half the defence. The other half is making sure the donor *cannot choose* to
reveal it convincingly.

`packages/snap` is a MetaMask Snap that holds the **viewing key** and decrypts
your own contribution **inside the SES sandbox**. The key derives from the user's
SRP via `snap_getEntropy`, not from their EOA — deliberately, because an EOA-held
viewing key is one a briber can simply ask you to sign with. Your number is shown
in a MetaMask dialog and never becomes a signature you can hand over.

The Snap does **not** encrypt the donation, and cannot: `Nox.fromExternal`
requires the owner of an input proof to be the direct `msg.sender` of the
transaction consuming it, so a donation encrypted by the Snap identity and
submitted by your EOA would revert `InvalidProof`. This Snap exposed exactly such
a method until it was checked against that rule — dead code the page never called,
but dead code that *looked* like the right thing to reach for. Lebur reached for
its equivalent and broke its entire Snap path. Encryption stays with the EOA,
inside the gateway's TEE; the Snap owns the half that carries the property.

```bash
cd packages/snap && npm install && npm run build && npm run serve   # localhost:8080
```

**Without the Snap, the page falls back to the EOA as viewer.** The donation is
still encrypted on-chain and still invisible to everyone else — but you can then
sign to prove the amount to a briber, so the coercion-resistance claim does not
hold on that path. The UI states the active mode explicitly (green for the Snap,
amber for the fallback) rather than choosing silently, and both paths retry
because the ciphertext lags the handle by a few seconds.

The Snap builds clean and evaluates under SES. **It has not yet been loaded in
MetaMask Flask** — passing `mm-snap eval` is not the same as a wallet round trip,
and that distinction is worth keeping until someone has actually done it.

## What is simulated, and what is not

**One thing: the ERC-20 faucet token.** `MockUSDC` stands in for USDC because
Sepolia has no faucet-able canonical USDC.

Nothing on the confidential path is simulated. The round runs on live Nox, the
escrow is real ERC-7984, the QF weights are computed under encryption by the real
Runner, the allocations are revealed by a real gateway-signed proof the contract
verifies itself, and settlement lands in a real 0xSplits V2 PushSplit created by
the unmodified upstream factory. `mocks/MockSplitFactory.sol` exists only because
0xSplits is Sepolia-only and not on a fresh EDR node — it is a test double for an
*external* protocol, and `LirihRound` cannot tell the difference because it only
ever sees `ISplitFactoryV2`.

## Prior art

Coercion-resistant funding is not a new goal. [MACI](https://maci.pse.dev) is the
canonical answer and [clr.fund](https://clr.fund) ran it in production: donors
encrypt to a coordinator's key and can invalidate an earlier vote with a later
one, so a receipt shown to a briber proves nothing. It costs a trusted
coordinator, a ZK circuit, and a tally that must be proved rather than computed.

Lirih takes the property from a TEE instead. The differences that matter:
the weights are computed by the contract *in the same transaction*, so there is
no coordinator holding the plaintext and no proving step between the round and
the payout; and because the output is an ordinary ERC-20 transfer into an
unmodified 0xSplits V2 split, settlement composes with the rest of DeFi rather
than terminating in a bespoke tally contract. The cost is the trust model — a
TEE, not a ZK proof — and this README will not blur the two.

## The deploy script refuses to anchor a deadline to a stale block

Worth its own section because it cost a round, twice.

`deploy-sepolia.ts` sets the contribution deadline from `block.timestamp`, which
is the correct anchor — `contribute` and `finalizeTally` both compare against
chain time, and the local clock is not the chain's. What it did not account for
is that `latest` from a **load-balanced RPC is not necessarily recent**. A deploy
in this session produced a round whose deadline was already **seven hours in the
past** — born dead, unusable, ~5M gas gone — because that one call happened to be
answered by a badly lagging backend. Two calls seconds apart returned timestamps
seven hours apart.

The [first dead round](https://sepolia.etherscan.io/address/0x4c9502b6deab6e15de0a4f4e69dcaa27896aef1d)
was almost certainly the same fault. It was diagnosed at the time as a local-clock
bug and "fixed" by anchoring to `block.timestamp` — which was already the right
anchor and was never the problem.

The script now polls until a backend answers with a block that is actually
current, cross-checks it against the wall clock, and **aborts** rather than deploy
a corpse. A stale read is recoverable; a stale deadline written into a constructor
is not. Lebur's deploy script carries the same guard for the same reason.

## Verified source

Every deployed contract is source-verified, so the code above can be read on-chain
rather than taken on trust:

Every address above is verified against **this branch**, so the code you are
reading and the code that is running are the same code — there is no revision gap
to explain away.

| Contract | Verified |
|---|---|
| LirihRound — settled | [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0x4f15c2a627e3f8e866a83fc57f3aa0897ad47399) |
| LirihRound — open | [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0x6cc49586e37d1d0d53c6836d76db0f38c280f5de) |
| cUSDC | [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0x763da807dd237053fc4f7aaef0e128fbcf37756b) |
| MockUSDC | [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0x4e41423064e8baca5df7e651bd29c9a25c98d24f) |

```bash
npx hardhat verify sourcify --network sepolia <address> <constructor args…>
```

Sourcify needs no API key. Note that its task ignores `--constructor-args-path`
(it resolves libraries only), so a constructor taking an array cannot be
expressed there — use `verify blockscout` for those.

## Anyone can fund the pool; nothing can be stranded

`fundPool()` is permissionless while the round is open, so the matching pool can
itself be crowdfunded rather than fixed by one sponsor at deployment. It credits
only what actually arrives, so a fee-on-transfer token cannot inflate `M` past
the balance really held, and it closes at the contribution deadline because `M`
is an input to the allocation maths and must not move under a computed tally.

The operator role is transferable in two steps (`transferOperator` then
`acceptOperator`), so it can be a multisig rather than permanently the EOA that
sent the deployment. Two-step because the operator is the only party who can
register projects — a typo that stranded the role would leave a round whose
projects can never be registered.

`sweepPool()` covers the all-whale round: every project's match is zero, so
`settle` has no weights to divide by, creates no split, and leaves the pool sitting
in the contract — `settledSplit == address(0)` is exactly that condition, and only
then can the operator recover it.

**Two more ways to strand a round existed until they were tested for**, and both
are worth stating because the claim above was made before either was found:

- **A round with projects but no donations could never settle.** Settlement
  forwards each project its escrowed cUSDC, and ERC-7984 refuses a transfer from
  an *uninitialised* balance handle — which is what a round that never received a
  donation has. The forward loop reverted on every attempt, the phase stuck at
  Allocated, and the matching pool was locked in a contract whose only recovery
  path opens after settlement. The existing "empty round settles" test missed it
  by registering no projects at all, so the loop never ran.
- **A zero payout address bricked the round permanently.** `registerProject` took
  it happily, ERC-7984 rejects `address(0)` as a receiver, and a payout can never
  be edited afterwards. One typo in the one input the operator still types by hand
  and every donation in that round was unrecoverable.

Both are fixed and both have a named regression test. The honest version of the
original claim: the permissionless pipeline removed the *operator* as a way to
strand funds, and these two removed the ways the contract could strand them on
its own.

## Check the arithmetic yourself

Once a round is allocated, the results panel sums the revealed allocations and
compares them against the on-chain matching pool, showing the unallocated
remainder in wei. Correct settlement leaves at most one wei per project, the dust
integer division cannot avoid. On the settled round above it reads exactly zero.

## License

MIT
