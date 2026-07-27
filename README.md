# Lirih — confidential quadratic funding on iExec Nox

**Your vote stays secret. The allocation is public. Nobody can prove how you gave.**

Lirih is confidential participatory budgeting: an organisation splits a matching
pool across projects/teams, but every contribution amount is encrypted
end-to-end via [iExec Nox](https://docs.noxprotocol.io). Quadratic-funding
weights are computed inside a TEE; **only the final per-project allocation is
ever decrypted.** Because you can't prove how you donated, bribery and coercion
are defeated — the property [MACI](https://maci.pse.dev) gets from ZK, Lirih
gets from a TEE, with full DeFi composability.

Settlement lands in an **unmodified [0xSplits V2](https://splits.org)** split on
Ethereum Sepolia. The target protocol is never forked or modified.

Submission for the iExec WTF Hackathon Summer Edition.

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
MetaMask Snap ── encrypt/decrypt inside the SES sandbox (plaintext never hits page JS)
```

## Packages

| Package | What |
|---|---|
| `packages/contracts` | `LirihRound.sol` + `Isqrt.sol` (encrypted integer sqrt) + `cUSDC` wrapper + Splits interface. Hardhat 3 + Nox plugin. |
| `packages/web` | Next.js donor flow (faucet → wrap → confidential donate). |
| `packages/snap` | MetaMask Snap: in-sandbox encryption + decrypt-your-own-contribution. |
| `reference/` | `qf-reference.mjs` — plaintext oracle proving the sqrt + QF math. |

## Quick start

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

# reference math (no deps)
node reference/qf-reference.mjs
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

## A complete round, settled on Ethereum Sepolia

Round [`0x3627a23a…`](https://sepolia.etherscan.io/address/0x3627a23a2a1d767ec993d96c9ed3dd4aad9c84b2)
ran end to end on 2026-07-27 — encrypted contributions, QF computed under
encryption, allocations revealed by gateway-signed proof, settled into a real
[0xSplits V2](https://sepolia.etherscan.io/address/0xA59b26EEe6234c99aE9ce3e1242ce1d2D3175Ff6)
PushSplit:

| Project | Raised | Donors | Matching received |
|---|---|---|---|
| Clean Water Initiative | 200 | **two** | **9,999.999999… mUSDC** |
| Open Source Maintainers | **900** | one | **0** |

**The whale raised 4.5× more money and earned zero matching.** That is quadratic
funding doing its job, and at no point was any individual donation amount public
— only the two final allocations were ever decrypted.

Both projects also hold non-zero **encrypted** cUSDC balances: the escrowed
donations were forwarded confidentially, so even the per-project raw totals stay
private. Operator flow gas: `finalizeTally` 287k · `computeAllocations` 262k ·
`revealAllocation` 99k/62k · `settle` 640k.

| Contract | Address |
|---|---|
| LirihRound | `0x3627a23a2a1d767ec993d96c9ed3dd4aad9c84b2` |
| cUSDC (ERC-7984) | `0xf7f2ef8372e50b332127695193571a4ca61bc515` |
| MockUSDC | `0xed5bb1f73119445e45d85e4b7f44fae4f78e455e` |
| 0xSplits V2 PushSplit (created by settle) | `0xA59b26EEe6234c99aE9ce3e1242ce1d2D3175Ff6` |
| PushSplitFactory V2.2 (unmodified, upstream) | `0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4` |

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
| `contribute`, donor's first gift to a project (one sqrt) | 2.64M | — |
| `contribute`, same donor giving again (two sqrts — see below) | 4.73M | — |
| `finalizeTally` | 1,037k | ~130k |
| `computeAllocations` | 915k | ~114k |
| `settle` (incl. forwarding donations to every project) | 2,008k | ~187k |

`contribute` costs 2.05M on live Sepolia versus 2.60M on the local Runner. Each
contribution is its own transaction, so the donor count is never bounded by the
block gas limit.

The per-project loops are not bounded either: `finalizeTallyPaged(n)` and
`computeAllocationsPaged(n)` process a bounded slice and resume, advancing the
phase only once the last project lands — a partial tally must never be visible
to the next phase, because `sumMatch` is the divisor for every allocation. At 64
projects the whole path is ~27M and fits a single Sepolia block anyway, but that
is a property of today's gas limit rather than of the design.

The test suite is **18 passing** against the real Nox stack: encrypted-sqrt
exactness, the full round versus a plaintext QF oracle, the splitting property
below, the gas benchmark, and fourteen guard tests covering phase ordering, deadline
enforcement, authorization, a forged decryption proof, an empty round, an
underfunded pool, crowdfunded top-ups, stranded-pool recovery, and resumable pagination.

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

The only mock in the system is the ERC-20 faucet token (`MockUSDC`) standing in
for USDC — the round, the Nox compute, and the 0xSplits V2 settlement are all
real contracts on Sepolia.

## License

MIT

## Verified source

Every deployed contract is source-verified, so the code above can be read on-chain
rather than taken on trust:

| Contract | Verified |
|---|---|
| LirihRound | [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0x3627a23a2a1d767ec993d96c9ed3dd4aad9c84b2) |
| cUSDC | [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0xf7f2ef8372e50b332127695193571a4ca61bc515) |
| MockUSDC | [Sourcify](https://sourcify.dev/server/repo-ui/11155111/0xed5bb1f73119445e45d85e4b7f44fae4f78e455e) |

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

`sweepPool()` closes the one remaining path to permanently stranded funds. In an
all-whale round every project's match is zero, so `settle` has no weights to
divide by, creates no split, and leaves the pool sitting in the contract —
`settledSplit == address(0)` is exactly that condition, and only then can the
operator recover it. Together with the permissionless pipeline, there is now no
state in which donor money or the matching pool can be locked forever.

## Check the arithmetic yourself

Once a round is allocated, the results panel sums the revealed allocations and
compares them against the on-chain matching pool, showing the unallocated
remainder in wei. Correct settlement leaves at most one wei per project, the dust
integer division cannot avoid. On the settled round above it reads exactly zero.
