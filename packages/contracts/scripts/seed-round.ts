// Seed a live Sepolia round with real confidential donations from DISTINCT
// donor addresses, so the QF result actually demonstrates quadratic funding.
//   npx hardhat run scripts/seed-round.ts --network sepolia
// Env: DEPLOYER_PRIVATE_KEY (funds the donors), ROUND/CUSDC/MUSDC_ADDRESS.
//
// The plan below is chosen so the numbers make the QF argument on their own:
//   project 0: 3 donors x 100  -> S=3e10, C=300e18 -> match = 9e20-3e20 = 6e20
//   project 1: 1 whale  x 900  -> S=3e10, C=900e18 -> match = 9e20-9e20 = 0
//   project 2: 2 donors x 100  -> S=2e10, C=200e18 -> match = 4e20-2e20 = 2e20
// Project 1 raises the MOST money (900) and earns ZERO matching, because it all
// came from one address. Expected split of the 10k pool: 7500 / 0 / 2500.
import { createWalletClient, createPublicClient, http, parseEther, formatEther, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { donate } from './donate.ts';
import { freshChainTime } from './chain-time.ts';

// ⚠️ NEVER fund the well-known hardhat/anvil test accounts on a PUBLIC testnet.
// Their private keys are public, so sweeper bots empty them within seconds —
// account #4 (0x15d34AAf…) is sitting on nonce 30,000+ from exactly that. An
// earlier version of this script used that mnemonic and lost 0.036 Sepolia ETH
// instantly; the funding looked like it "silently failed" because the balance
// was gone before the next transaction was built.
//
// Donor keys are therefore derived from the DEPLOYER's key, so they are
// reproducible across runs (no extra secrets to store) but not publicly known.
const donorKeyFor = (funderKey: string, i: number) =>
  keccak256(toHex(`${funderKey}:lirih-donor:${i}`)) as `0x${string}`;

// LEAN=1 is the faucet-budget version: 2 projects, 3 contributions, and the
// FUNDER itself is donor 0 — so only ONE extra address needs gas, and no ETH is
// stranded in wallets we never use again. It still makes the whole QF argument:
// project 0 is funded by a crowd of two, project 1 by a single whale giving MORE
// money, and the whale still earns zero matching.
// Full version: 3 projects, 6 contributions, 3 funded donors.
const LEAN = process.env.LEAN === '1';

const DONOR_INDEXES = LEAN ? [4] : [4, 5, 6];

// Fund each donor UP TO this, and sweep the remainder back afterwards.
//
// Size it against the RESERVE, not the expected bill: a sender must be able to
// cover `gasLimit * maxFeePerGas`, even though it only ever pays
// `gasUsed * (baseFee + tip)`. A 2.6M-gas contribute at the 3 gwei ceiling
// reserves ~0.008 ETH while actually costing ~0.0027. Budgeting for the real
// cost gets the transaction rejected before it is ever mined, and the rejection
// surfaces as a bare "execution reverted" with no revert data.
const GAS_TARGET = parseEther(LEAN ? '0.0095' : '0.025');

// A donor giving to the SAME project twice pays for a second encrypted sqrt:
// ~4.73M gas against ~2.6M, because the contract has to swap that donor's old
// root out for their new one. At the 3 gwei ceiling that reserves ~0.0142 ETH,
// so the flat target above is not enough and the transaction is rejected before
// it is mined -- surfacing as "gas required exceeds allowance", which reads like
// a contract problem and is a funding one.
const REPEAT_TARGET = parseEther('0.018');

/// What this donor slot must hold, given what the plan asks of it.
const targetFor = (slot: number) => {
  const projects = PLAN.filter(([, s]) => s === slot).map(([p]) => p);
  const givesTwice = projects.length !== new Set(projects).size;
  return givesTwice ? REPEAT_TARGET : GAS_TARGET;
};

// [projectId, donorSlot, wholeTokens]; slot -1 means the funder itself.
const LEAN_PLAN: [number, number, string][] = [
  [0, -1, '100'], [0, 0, '100'],  // crowd of two -> earns the matching
  [1, -1, '900'], //  one whale, 4.5x the money, zero matching
];

const FULL_PLAN: [number, number, string][] = [
  [0, 0, '100'], [0, 1, '100'], [0, 2, '100'],
  [1, 0, '900'],
  [2, 1, '100'], [2, 2, '100'],
];

// PLAN=cases seeds a round that demonstrates the two properties this project is
// actually about, rather than just producing a plausible-looking book.
//
// The crowd/whale contrast is the QF argument: project 1 raises three times more
// money than project 0 and earns ZERO matching, because it all came from one
// address.
//
// The repeat donation is the one that has never been shown on-chain. Quadratic
// funding weights a project by (Σ√cᵢ)² where i ranges over DONORS, not
// transactions -- take the root per transaction and one donor can split a gift
// across N of them and multiply their own weight by √N, with no extra addresses
// at all. Donor 0 gives 100 twice here, so their weight is √200 and not 2·√100,
// and the second contribution costs a second sqrt (~1.8x the gas) to prove it.
const CASES_PLAN: [number, number, string][] = [
  [0, -1, '100'], // crowd member one
  [0,  0, '100'], // crowd member two
  [0,  0, '100'], // ...and again, from the SAME donor: splitting must buy nothing
  [1, -1, '900'], // the whale: most money raised, zero matching earned
];

const PLAN = process.env.PLAN === 'cases' ? CASES_PLAN : LEAN ? LEAN_PLAN : FULL_PLAN;

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};

async function main() {
  const round = env('ROUND_ADDRESS') as `0x${string}`;
  const cusdc = env('CUSDC_ADDRESS') as `0x${string}`;
  const musdc = env('MUSDC_ADDRESS') as `0x${string}`;

  const transport = http(process.env.SEPOLIA_RPC_URL ?? 'https://sepolia.drpc.org');
  const pub = createPublicClient({ chain: sepolia, transport });
  const funder = privateKeyToAccount(env('DEPLOYER_PRIVATE_KEY') as `0x${string}`);
  const funderWallet = createWalletClient({ account: funder, chain: sepolia, transport });

  // Fail fast if the window is already shut, or too tight to finish in. Each
  // contribution needs a gateway round trip plus ~5 transactions, so budget
  // generously — discovering DeadlinePassed halfway through wastes the gas of
  // every contribution that already landed, and the round cannot be reopened.
  const roundAbi = [{ type: 'function', name: 'contributionDeadline', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint64' }] }] as const;
  const deadline = Number(await pub.readContract({ address: round, abi: roundAbi, functionName: 'contributionDeadline' }));
  // Fresh, not just `latest`: a stale block makes a window that has already
  // closed look open, and seeding would then spend gas per contribution until
  // one reverts DeadlinePassed halfway through the plan.
  const chainNow = Number(await freshChainTime(pub));
  const left = deadline - chainNow;
  const needed = 90 * PLAN.length;
  if (left <= 0) {
    throw new Error(`round ${round} closed ${-left}s ago — redeploy, it cannot be reopened`);
  }
  if (left < needed) {
    throw new Error(
      `only ${left}s left on the contribution window but ~${needed}s needed for ` +
      `${PLAN.length} contributions. Redeploy with a longer CONTRIB_WINDOW_SECS.`,
    );
  }
  console.log(`window: ${left}s left (need ~${needed}s)`);

  const donors = DONOR_INDEXES.map((i) => {
    const key = donorKeyFor(env('DEPLOYER_PRIVATE_KEY'), i);
    return { address: privateKeyToAccount(key).address, key };
  });
  donors.forEach((d, i) => console.log(`donor ${i}: ${d.address}`));
  console.log(`funder : ${funder.address} (${formatEther(await pub.getBalance({ address: funder.address }))} ETH)`);

  // top up only the shortfall — re-runs shouldn't re-drain the funder
  for (const [i, d] of donors.entries()) {
    const target = targetFor(i); // plan slots index this array, not the HD path
    const bal = await pub.getBalance({ address: d.address });
    if (bal >= target) {
      console.log(`donor ${i} funded (${formatEther(bal)} ETH), skipping topup`);
      continue;
    }
    const hash = await funderWallet.sendTransaction({ to: d.address, value: target - bal });
    await pub.waitForTransactionReceipt({ hash });
    // Confirm the ETH is actually THERE. A receipt only proves the transfer was
    // mined, not that the balance survived — funding a publicly-known key gets
    // swept by bots between this transaction and the next one, which reads as a
    // baffling "insufficient funds" much later instead of an error here.
    const after = await pub.getBalance({ address: d.address });
    if (after < target / 2n) {
      throw new Error(
        `donor ${i} (${d.address}) shows ${formatEther(after)} ETH right after being sent ` +
        `${formatEther(GAS_TOPUP)}. The funds were swept — is this a publicly-known key?`,
      );
    }
    console.log(`donor ${i} topped up: ${formatEther(after)} ETH`);
  }

  // Sequential on purpose: each donor's wrap/contribute reads state its own
  // previous tx wrote, and the Nox gateway rate-limits concurrent encryptInput.
  // Contributions are irreversible and expensive, so a mid-run failure must be
  // resumable: START_AT skips steps that already landed. Re-running them would
  // not just waste gas — a second gift to the SAME project is a repeat
  // contribution, which costs a second sqrt AND changes that donor's total.
  const startAt = Number(process.env.START_AT ?? 0);
  const funderKey = env('DEPLOYER_PRIVATE_KEY') as `0x${string}`;
  for (const [idx, [projectId, slot, tokens]] of PLAN.entries()) {
    const who = slot < 0 ? 'funder' : `donor ${slot}`;
    if (idx < startAt) {
      console.log(`\n--- [${idx}] SKIPPED (START_AT=${startAt}): project ${projectId} <- ${who} (${tokens})`);
      continue;
    }
    console.log(`\n--- [${idx}] project ${projectId} <- ${who} (${tokens}) ---`);
    await donate({
      key: slot < 0 ? funderKey : donors[slot].key,
      round, cusdc, musdc,
      projectId: BigInt(projectId), amount: parseEther(tokens),
    });
  }
  // Return each donor's unspent ETH. Donors are over-funded on purpose (see
  // GAS_TARGET), so without this the surplus is stranded in throwaway wallets —
  // which matters on a faucet budget. Best-effort: a failed sweep must not fail
  // the seeding that already succeeded.
  console.log('\nsweeping unspent donor gas back to the funder…');
  for (const [i, d] of donors.entries()) {
    try {
      const bal = await pub.getBalance({ address: d.address });
      // Hold back gasLimit * maxFeePerGas, NOT the expected fee — the sender must
      // cover the ceiling or the transfer is rejected outright. Mirrors the
      // GAS_TARGET reasoning above; getting it wrong here just fails the sweep.
      const cost = 21_000n * 3_000_000_000n; // 21k gas at the 3 gwei ceiling
      if (bal <= cost) { console.log(`  donor ${i}: ${formatEther(bal)} ETH, not worth sweeping`); continue; }
      const w = createWalletClient({ account: privateKeyToAccount(d.key), chain: sepolia, transport });
      const hash = await w.sendTransaction({ to: funder.address, value: bal - cost });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`  donor ${i}: returned ${formatEther(bal - cost)} ETH`);
    } catch (e) {
      console.log(`  donor ${i}: sweep failed (${(e as Error).message.split('\n')[0]}) — funds remain in ${d.address}`);
    }
  }
  console.log(`funder now: ${formatEther(await pub.getBalance({ address: funder.address }))} ETH`);
  console.log('\nseeded. run scripts/run-round.ts after the contribution deadline.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
