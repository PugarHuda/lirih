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
import { createWalletClient, createPublicClient, http, parseEther, formatEther, toHex } from 'viem';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { donate } from './donate.ts';

// Well-known public test mnemonic (hardhat/anvil default). Demo donor keys are
// intentionally public — these are throwaway testnet identities, and using
// indexes 4..6 keeps them distinct from the 1..3 grantee payout addresses.
const MNEMONIC = 'test test test test test test test test test test test junk';
const DONOR_INDEXES = [4, 5, 6];
const GAS_FLOOR = parseEther('0.004');   // ~1 contribute (2.05M gas) of headroom
const GAS_TOPUP = parseEther('0.012');   // enough for 2 donations each

// [projectId, donorSlot, wholeTokens]
const PLAN: [number, number, string][] = [
  [0, 0, '100'], [0, 1, '100'], [0, 2, '100'],
  [1, 0, '900'],
  [2, 1, '100'], [2, 2, '100'],
];

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

  const donors = DONOR_INDEXES.map((addressIndex) => {
    const hd = mnemonicToAccount(MNEMONIC, { addressIndex });
    return { address: hd.address, key: toHex(hd.getHdKey().privateKey!) as `0x${string}` };
  });
  donors.forEach((d, i) => console.log(`donor ${i}: ${d.address}`));
  console.log(`funder : ${funder.address} (${formatEther(await pub.getBalance({ address: funder.address }))} ETH)`);

  // top up only what's needed — re-runs shouldn't re-drain the funder
  for (const [i, d] of donors.entries()) {
    const bal = await pub.getBalance({ address: d.address });
    if (bal >= GAS_FLOOR) {
      console.log(`donor ${i} funded (${formatEther(bal)} ETH), skipping topup`);
      continue;
    }
    const hash = await funderWallet.sendTransaction({ to: d.address, value: GAS_TOPUP });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`donor ${i} topped up to ${formatEther(GAS_TOPUP)} ETH`);
  }

  // Sequential on purpose: each donor's wrap/contribute reads state its own
  // previous tx wrote, and the Nox gateway rate-limits concurrent encryptInput.
  for (const [projectId, slot, tokens] of PLAN) {
    console.log(`\n--- project ${projectId} <- donor ${slot} (${tokens}) ---`);
    await donate({
      key: donors[slot].key, round, cusdc, musdc,
      projectId: BigInt(projectId), amount: parseEther(tokens),
    });
  }
  console.log('\nseeded. run scripts/run-round.ts after the contribution deadline.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
