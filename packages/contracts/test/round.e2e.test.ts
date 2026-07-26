import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { nox, NOX_COMPUTE_ADDRESS, handleGatewayUrl } from '@iexec-nox/nox-hardhat-plugin';
import { createViemHandleClient } from '@iexec-nox/handle';
import { parseEther } from 'viem';

// A handle client whose input-proof owner is a SPECIFIC donor. contribute()
// checks ownerInProof == msg.sender, and the Handle SDK reads the owner from
// walletClient.getAddresses()[0]. On the hardhat node eth_accounts returns ALL
// accounts, so [0] is always account #0 — we shim getAddresses to this donor's
// own account. (A browser's injected provider returns only the connected
// account, so packages/web/lib/nox.ts needs no shim.)
const donorHandleClient = (wallet: any) =>
  createViemHandleClient(
    { ...wallet, getAddresses: async () => [wallet.account.address] },
    {
      smartContractAddress: NOX_COMPUTE_ADDRESS,
      gatewayUrl: handleGatewayUrl(),
      subgraphUrl: 'https://example.com/subgraphs/id/none',
    },
  );

// floor(sqrt) + QF oracle — mirrors reference/qf-reference.mjs
const isqrt = (a: bigint) => {
  if (a < 2n) return a;
  let x = a, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + a / x) / 2n; }
  return x;
};
function qfAlloc(perProject: bigint[][], M: bigint) {
  const match = perProject.map((cs) => {
    const sr = cs.reduce((s, c) => s + isqrt(c), 0n);
    const sc = cs.reduce((s, c) => s + c, 0n);
    const raw = sr * sr - sc;
    return raw > 0n ? raw : 0n;
  });
  const tot = match.reduce((s, m) => s + m, 0n);
  return match.map((m) => (tot === 0n ? 0n : (M * m) / tot));
}

describe('Lirih end-to-end confidential QF round', () => {
  it('nets encrypted contributions and settles matching pool by QF weight', async () => {
    const conn = await nox.connect();
    const { viem } = conn;
    const [op, donorA, donorB] = await viem.getWalletClients();

    const usdc = await viem.deployContract('MockUSDC');
    const cusdc = await viem.deployContract('cUSDC', [usdc.address]);
    const factory = await viem.deployContract('MockSplitFactory');

    const M = parseEther('10000');
    // Deadline is chain-relative: EDR genesis time ≠ wall clock, so anchor to
    // the current block timestamp, then time-travel past it before finalize.
    const pub = await viem.getPublicClient();
    const now = (await pub.getBlock()).timestamp;
    const round = await viem.deployContract('LirihRound', [
      cusdc.address, usdc.address, factory.address, M, now + 3600n,
    ]);
    await usdc.write.mint([round.address, M]); // fund the public matching pool

    // two projects
    const pA = '0x000000000000000000000000000000000000aaaa';
    const pB = '0x000000000000000000000000000000000000bbbb';
    await round.write.registerProject([pA]);
    await round.write.registerProject([pB]);

    // contributions: project A gets a crowd, project B one whale — QF should
    // favour A. Keep amounts small: each sqrt is ~164 sequential Runner ops.
    const donations: { donor: typeof donorA; project: bigint; amt: bigint }[] = [
      { donor: donorA, project: 0n, amt: parseEther('4') },
      { donor: donorB, project: 0n, amt: parseEther('4') },
      { donor: op,     project: 1n, amt: parseEther('16') },
    ];

    for (const d of donations) {
      // faucet + wrap + authorize round as operator on cUSDC
      await usdc.write.mint([d.donor.account.address, d.amt], { account: d.donor.account });
      await usdc.write.approve([cusdc.address, d.amt], { account: d.donor.account });
      await cusdc.write.wrap([d.donor.account.address, d.amt], { account: d.donor.account });
      await cusdc.write.setOperator([round.address, Number(now) + 3600], { account: d.donor.account });
      // encrypt AS THE DONOR (proof owner == msg.sender) + contribute
      // (viewer = donor's own address for decrypt-mine)
      const client = await donorHandleClient(d.donor);
      const { handle, handleProof } = await client.encryptInput(d.amt, 'uint256', round.address);
      await round.write.contribute(
        [d.project, handle, handleProof, d.donor.account.address],
        { account: d.donor.account },
      );
    }

    // advance past the (chain-relative) deadline, then finalize
    await conn.provider.request({ method: 'evm_increaseTime', params: ['0xE11'] }); // 3601s
    await conn.provider.request({ method: 'evm_mine', params: [] });
    await round.write.finalizeTally();
    await round.write.computeAllocations();

    // reveal each allocation via gateway-signed public decrypt
    const revealed: bigint[] = [];
    for (let i = 0n; i < 2n; i++) {
      const p = (await round.read.projects([i])) as unknown as any[];
      const allocHandle = p[4] as `0x${string}`; // allocHandle field
      const { value, decryptionProof } = await nox.publicDecrypt(allocHandle);
      await round.write.revealAllocation([i, value, decryptionProof]);
      revealed.push(value as bigint);
    }

    const expected = qfAlloc([[parseEther('4'), parseEther('4')], [parseEther('16')]], M);
    assert.equal(revealed[0], expected[0], 'project A allocation');
    assert.equal(revealed[1], expected[1], 'project B allocation');
    assert.ok(revealed[0] > revealed[1], 'QF favours the crowd-funded project');

    // Escrowed donations must actually reach the projects — they used to stay
    // locked in the round forever. They arrive as cUSDC and stay encrypted, so
    // assert on the balance HANDLE going from zero to non-zero (the payouts
    // granted us no viewer role, so there is nothing to decrypt here).
    const ZERO_HANDLE = `0x${'00'.repeat(32)}`;
    assert.equal(await cusdc.read.confidentialBalanceOf([pA]), ZERO_HANDLE, 'A unpaid pre-settle');
    assert.equal(await cusdc.read.confidentialBalanceOf([pB]), ZERO_HANDLE, 'B unpaid pre-settle');

    await round.write.settle();
    assert.equal(Number(await round.read.phase()), 3, 'phase == Settled');

    assert.notEqual(
      await cusdc.read.confidentialBalanceOf([pA]), ZERO_HANDLE,
      'project A received its escrowed confidential donations',
    );
    assert.notEqual(
      await cusdc.read.confidentialBalanceOf([pB]), ZERO_HANDLE,
      'project B received its escrowed confidential donations',
    );
  });
});
