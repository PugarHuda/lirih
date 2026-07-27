import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { nox, NOX_COMPUTE_ADDRESS, handleGatewayUrl } from '@iexec-nox/nox-hardhat-plugin';
import { createViemHandleClient } from '@iexec-nox/handle';
import { parseEther } from 'viem';
import { timeTravel } from './helpers.ts';

const donorHandleClient = (wallet: any) =>
  createViemHandleClient(
    { ...wallet, getAddresses: async () => [wallet.account.address] },
    {
      smartContractAddress: NOX_COMPUTE_ADDRESS,
      gatewayUrl: handleGatewayUrl(),
      subgraphUrl: 'https://example.com/subgraphs/id/none',
    },
  );

// THE PROPERTY UNDER TEST — quadratic funding weights a project by (Σ√cᵢ)²
// where i ranges over DONORS, not over transactions. If √ is applied per
// transaction instead, one donor can split a donation across N transactions and
// multiply their own matching weight by √N, because
//   N·√(c/N) = √N·√c  >  √c.
// That is the classic sybil attack, except it needs no extra addresses at all.
describe('QF semantics: splitting a donation must not buy extra matching weight', () => {
  it('treats two half-donations from one donor the same as one whole donation', async () => {
    const conn = await nox.connect();
    const { viem } = conn;
    const [op, donorA, donorB] = await viem.getWalletClients();
    const pub = await viem.getPublicClient();

    const usdc = await viem.deployContract('MockUSDC');
    const cusdc = await viem.deployContract('cUSDC', [usdc.address]);
    const factory = await viem.deployContract('MockSplitFactory');
    const M = parseEther('10000');
    const now = (await pub.getBlock()).timestamp;
    const round = await viem.deployContract('LirihRound', [
      cusdc.address, usdc.address, factory.address, M, now + 120n,
    ]);
    await usdc.write.mint([round.address, M]);

    await round.write.registerProject(['0x000000000000000000000000000000000000aaaa', 'Donor A splits 4+4']);
    await round.write.registerProject(['0x000000000000000000000000000000000000bbbb', 'Donor A gives 8 once']);

    // Both projects end up with the SAME per-donor totals: {A: 8, B: 8}. The only
    // difference is that A pays project 0 in two transactions. A second donor is
    // present so the match is non-zero — otherwise both sides are 0 and the
    // equality assertion below would hold even if the bug were still there.
    const plan = [
      { donor: donorA, project: 0n, amt: parseEther('4') }, // split, part 1
      { donor: donorA, project: 0n, amt: parseEther('4') }, // split, part 2
      { donor: donorB, project: 0n, amt: parseEther('8') },
      { donor: donorA, project: 1n, amt: parseEther('8') }, // same total, one tx
      { donor: donorB, project: 1n, amt: parseEther('8') },
    ];

    const gasUsed: bigint[] = [];
    for (const d of plan) {
      await usdc.write.mint([d.donor.account.address, d.amt], { account: d.donor.account });
      await usdc.write.approve([cusdc.address, d.amt], { account: d.donor.account });
      await cusdc.write.wrap([d.donor.account.address, d.amt], { account: d.donor.account });
      await cusdc.write.setOperator([round.address, Number(now) + 3600], { account: d.donor.account });
      const client = await donorHandleClient(d.donor);
      const { handle, handleProof } = await client.encryptInput(d.amt, 'uint256', round.address);
      const hash = await round.write.contribute(
        [d.project, handle, handleProof, d.donor.account.address],
        { account: d.donor.account },
      );
      gasUsed.push((await pub.getTransactionReceipt({ hash })).gasUsed);
    }
    // plan[0] is A's FIRST gift to project 0; plan[1] is A giving again, which
    // has to re-root the donor's new total and unwind the old root — two sqrts.
    console.log(`  first contribution : ${gasUsed[0]}`);
    console.log(`  repeat contribution: ${gasUsed[1]} (second sqrt: +${gasUsed[1] - gasUsed[0]})`);

    await timeTravel(conn, 121);
    await round.write.finalizeTally();
    await round.write.computeAllocations();

    const revealed: bigint[] = [];
    for (let i = 0n; i < 2n; i++) {
      const p = (await round.read.projects([i])) as unknown as any[];
      const { value, decryptionProof } = await nox.publicDecrypt(p[4] as `0x${string}`);
      await round.write.revealAllocation([i, value, decryptionProof]);
      revealed.push(value as bigint);
    }
    console.log(`  split(4+4)+8 = ${revealed[0]}   single 8+8 = ${revealed[1]}`);

    // Plaintext oracle: aggregate PER DONOR first, then take the root.
    const isqrt = (a: bigint) => {
      if (a < 2n) return a;
      let x = a, y = (x + 1n) / 2n;
      while (y < x) { x = y; y = (x + a / x) / 2n; }
      return x;
    };
    const totals = [parseEther('8'), parseEther('8')]; // {A: 8, B: 8} on each project
    const sp = totals.reduce((s, t) => s + isqrt(t), 0n);
    const cp = totals.reduce((s, t) => s + t, 0n);
    const expectedMatch = sp * sp - cp;
    // both projects are identical, so each takes exactly half the pool
    const expectedAlloc = (M * expectedMatch) / (expectedMatch * 2n);

    assert.ok(expectedMatch > 0n, 'oracle sanity: the match must be non-zero');
    assert.ok(revealed[0] > 0n, 'guard against a trivially-equal 0 == 0 pass');
    assert.equal(
      revealed[0], revealed[1],
      'splitting a donation across transactions must not change the matching weight',
    );
    assert.equal(revealed[0], expectedAlloc, 'matches the per-donor-aggregated oracle');
  });
});
