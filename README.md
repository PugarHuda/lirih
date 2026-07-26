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

Gas, measured: `finalizeTally` ≈130k/project · `computeAllocations` ≈114k/project
· `contribute` 2.05M. `MAX_PROJECTS` is 64, which binds before the block limit
does.

The only mock in the system is the ERC-20 faucet token (`MockUSDC`) standing in
for USDC — the round, the Nox compute, and the 0xSplits V2 settlement are all
real contracts on Sepolia.

## License

MIT
