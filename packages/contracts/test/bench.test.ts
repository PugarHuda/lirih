import { describe, it } from 'node:test';
import { nox, NOX_COMPUTE_ADDRESS, handleGatewayUrl } from '@iexec-nox/nox-hardhat-plugin';
import { createViemHandleClient } from '@iexec-nox/handle';
import { parseEther } from 'viem';
import { timeTravel } from './helpers.ts';

// Owner-shimmed handle client — see round.e2e.test.ts for why.
const donorHandleClient = (wallet: any) =>
  createViemHandleClient(
    { ...wallet, getAddresses: async () => [wallet.account.address] },
    {
      smartContractAddress: NOX_COMPUTE_ADDRESS,
      gatewayUrl: handleGatewayUrl(),
      subgraphUrl: 'https://example.com/subgraphs/id/none',
    },
  );

// Benchmark "L": the demo-size ceiling. finalizeTally/computeAllocations loop
// over ALL projects (empty ones still run the full encrypted mul/safeSub/div),
// so the per-project marginal is what caps L against the ~30M block gas limit.
// We register K projects but only fund a few contributions to keep Runner time
// down — the loop cost is identical either way.
const K = 8; // projects
const SEPOLIA_BLOCK_GAS = 30_000_000n;

describe('Lirih benchmark — gas per step + L ceiling', () => {
  it(`profiles a K=${K}-project round on the real Nox Runner`, async () => {
    const conn = await nox.connect();
    const { viem } = conn;
    const [op, donorA, donorB] = await viem.getWalletClients();
    const pub = await viem.getPublicClient();
    const gas = async (hash: `0x${string}`) =>
      (await pub.waitForTransactionReceipt({ hash })).gasUsed;

    const usdc = await viem.deployContract('MockUSDC');
    const cusdc = await viem.deployContract('cUSDC', [usdc.address]);
    const factory = await viem.deployContract('MockSplitFactory');

    const M = parseEther('10000');
    const now = (await pub.getBlock()).timestamp;
    const round = await viem.deployContract('LirihRound', [
      cusdc.address, usdc.address, factory.address, M, now + 300n,
    ]);
    await usdc.write.mint([round.address, M]);

    // K projects (payouts must be distinct + non-zero for the split)
    for (let i = 0; i < K; i++) {
      await round.write.registerProject([`0x${(i + 1).toString(16).padStart(40, '0')}` as `0x${string}`, `project ${i}`]);
    }

    // fund 3 real contributions (rest of the K projects stay empty)
    const donors = [
      { donor: op, project: 0n, amt: parseEther('4') },
      { donor: donorA, project: 0n, amt: parseEther('4') },
      { donor: donorB, project: 1n, amt: parseEther('16') },
    ];
    let contributeGas = 0n;
    for (const d of donors) {
      await usdc.write.mint([d.donor.account.address, d.amt], { account: d.donor.account });
      await usdc.write.approve([cusdc.address, d.amt], { account: d.donor.account });
      await cusdc.write.wrap([d.donor.account.address, d.amt], { account: d.donor.account });
      await cusdc.write.setOperator([round.address, Number(now) + 3600], { account: d.donor.account });
      const client = await donorHandleClient(d.donor);
      const { handle, handleProof } = await client.encryptInput(d.amt, 'uint256', round.address);
      const h = await round.write.contribute(
        [d.project, handle, handleProof, d.donor.account.address],
        { account: d.donor.account },
      );
      contributeGas = await gas(h); // last one; all are O(1) — one sqrt each
    }

    await timeTravel(conn, 301); // short jump — see test/helpers.ts

    const finalizeGas = await gas(await round.write.finalizeTally());
    const allocGas = await gas(await round.write.computeAllocations());

    for (let i = 0n; i < BigInt(K); i++) {
      const p = (await round.read.projects([i])) as unknown as any[];
      const { value, decryptionProof } = await nox.publicDecrypt(p[4] as `0x${string}`);
      await round.write.revealAllocation([i, value, decryptionProof]);
    }
    const settleGas = await gas(await round.write.settle());

    const perProjectFinalize = finalizeGas / BigInt(K);
    const perProjectAlloc = allocGas / BigInt(K);
    const perProjectLoop = perProjectFinalize + perProjectAlloc;
    // L: max projects whose finalize+alloc fit in one Sepolia block.
    const L = SEPOLIA_BLOCK_GAS / perProjectLoop;

    console.log('\n── Lirih gas benchmark (Nox Runner, K=' + K + ') ──');
    console.log('contribute (1 donor, 1 sqrt) :', contributeGas.toString());
    console.log('finalizeTally  (K projects)  :', finalizeGas.toString(), `(~${perProjectFinalize}/project)`);
    console.log('computeAllocs  (K projects)  :', allocGas.toString(), `(~${perProjectAlloc}/project)`);
    console.log('settle                       :', settleGas.toString());
    console.log('→ L (finalize+alloc fit 30M) : ~' + L.toString() + ' projects/block');
    console.log('  (contributes are separate txs, so N donors is unbounded by block gas)\n');
  });
});
