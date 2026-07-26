// Deploy Lirih to Ethereum Sepolia. Requires DEPLOYER_PRIVATE_KEY (funded) in .env.
//   npx hardhat run scripts/deploy-sepolia.ts --network sepolia
import { network } from 'hardhat';

// 0xSplits V2 PushSplitFactory V2.2 — verified live on Sepolia 2026-07-22
const SPLIT_FACTORY = '0x8E8eB0cC6AE34A38B67D5Cf91ACa38f60bc3Ecf4';
const MATCHING_POOL = 10_000n * 10n ** 18n; // 10k mUSDC matching pool

// Contribution window. Short (e.g. 900) to record the full tally->settle cycle;
// long to leave a judge-facing round open. The first deploy used 3600 and the
// round expired unusable — always set this deliberately.
const CONTRIB_WINDOW_SECS = Number(process.env.CONTRIB_WINDOW_SECS ?? 60 * 60);

// Demo grantee payouts: the well-known Hardhat/Anvil test accounts #1..#3. Real,
// publicly verifiable addresses — the split that pays them is the live 0xSplits V2.
const PAYOUTS = (process.env.PROJECT_PAYOUTS ??
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8,' +
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,' +
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906').split(',') as `0x${string}`[];

async function main() {
  const { viem } = await network.connect({ network: 'sepolia', chainType: 'op' });
  const [wallet] = await viem.getWalletClients();
  console.log('deployer:', wallet.account.address);

  const usdc = await viem.deployContract('MockUSDC');
  console.log('MockUSDC:', usdc.address);

  const cusdc = await viem.deployContract('cUSDC', [usdc.address]);
  console.log('cUSDC   :', cusdc.address);

  // anchor the deadline to chain time, not the local clock — `contribute` and
  // `finalizeTally` both compare against block.timestamp.
  const pub = await viem.getPublicClient();
  const now = (await pub.getBlock()).timestamp;
  const deadline = now + BigInt(CONTRIB_WINDOW_SECS);
  const round = await viem.deployContract('LirihRound', [
    cusdc.address,
    usdc.address,
    SPLIT_FACTORY,
    MATCHING_POOL,
    deadline,
  ]);
  console.log('LirihRound:', round.address);
  console.log('deadline  :', new Date(Number(deadline) * 1000).toISOString());

  // fund the matching pool — mint straight to the round (one tx, no ordering
  // dependency; viem write doesn't await receipts, so avoid mint->transfer).
  const hash = await usdc.write.mint([round.address, MATCHING_POOL]);
  await pub.waitForTransactionReceipt({ hash });
  console.log('matching pool funded:', MATCHING_POOL.toString());

  // A round with zero projects makes `contribute` revert UnknownProject — the
  // reason the first deploy was unusable. Register the grantees here.
  for (const payout of PAYOUTS) {
    const h = await round.write.registerProject([payout]);
    await pub.waitForTransactionReceipt({ hash: h });
    console.log('project registered:', payout);
  }

  console.log(`\n--- paste into packages/web/.env.local ---
NEXT_PUBLIC_ROUND=${round.address}
NEXT_PUBLIC_CUSDC=${cusdc.address}
NEXT_PUBLIC_MUSDC=${usdc.address}
NEXT_PUBLIC_RPC=${process.env.SEPOLIA_RPC_URL ?? 'https://sepolia.drpc.org'}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
