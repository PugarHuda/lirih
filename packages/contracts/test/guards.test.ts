import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { nox } from '@iexec-nox/nox-hardhat-plugin';
import { parseEther } from 'viem';
import { timeTravel } from './helpers.ts';

// Guard / phase / authorization tests. These deliberately avoid a SUCCESSFUL
// contribute: every one costs 164 sequential Runner ops, and each guard here
// reverts before any Nox arithmetic runs, so the whole file stays cheap.
// The happy path lives in round.e2e.test.ts.

const SPLIT_ZERO = '0x0000000000000000000000000000000000000000';

// Short window on purpose: the suite shares a ~3600s proof-expiry budget
// across ALL files. See test/helpers.ts.
async function fixture(windowSecs = 20n) {
  const conn = await nox.connect();
  const { viem } = conn;
  const [op, other] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();

  const usdc = await viem.deployContract('MockUSDC');
  const cusdc = await viem.deployContract('cUSDC', [usdc.address]);
  const factory = await viem.deployContract('MockSplitFactory');
  const M = parseEther('10000');
  const now = (await pub.getBlock()).timestamp;
  const round = await viem.deployContract('LirihRound', [
    cusdc.address, usdc.address, factory.address, M, now + windowSecs,
  ]);
  return { conn, viem, pub, op, other, usdc, cusdc, factory, round, M };
}

describe('LirihRound guards', () => {
  it('only the operator may register projects', async () => {
    const { round, other } = await fixture();
    await assert.rejects(
      () => round.write.registerProject([SPLIT_ZERO, 'x'], { account: other.account }),
      /NotOperator/,
      'a stranger must not be able to add a payout address',
    );
  });

  it('rejects contributions once the deadline has passed', async () => {
    const { round, conn, op } = await fixture();
    await round.write.registerProject([SPLIT_ZERO, 'demo project']);
    await timeTravel(conn, 21);
    // the deadline check runs before fromExternal, so a dummy handle is fine
    await assert.rejects(
      () => round.write.contribute([0n, `0x${'00'.repeat(32)}`, '0x', op.account.address]),
      /DeadlinePassed/,
    );
  });

  it('refuses to tally before the deadline', async () => {
    const { round } = await fixture();
    await assert.rejects(() => round.write.finalizeTally(), /DeadlineNotReached/);
  });

  it('enforces the phase order', async () => {
    const { round, conn } = await fixture();
    // Contribution phase: neither of the later steps may run
    await assert.rejects(() => round.write.computeAllocations(), /WrongPhase/);
    await assert.rejects(() => round.write.settle(), /WrongPhase/);

    await timeTravel(conn, 21);
    await round.write.finalizeTally();
    // Tallied phase: cannot tally twice, cannot settle yet
    await assert.rejects(() => round.write.finalizeTally(), /WrongPhase/);
    await assert.rejects(() => round.write.settle(), /WrongPhase/);
  });

  // This is the regression test for making the pipeline permissionless. If these
  // three steps were operator-gated, a silent operator could strand donor escrow
  // in the contract forever.
  it('lets ANYONE drive the round to settlement, not just the operator', async () => {
    const { round, usdc, other, conn, M } = await fixture();
    await usdc.write.mint([round.address, M]); // fund the matching pool

    await timeTravel(conn, 21);
    await round.write.finalizeTally({ account: other.account });
    assert.equal(Number(await round.read.phase()), 1, 'Tallied by a non-operator');

    await round.write.computeAllocations({ account: other.account });
    assert.equal(Number(await round.read.phase()), 2, 'Allocated by a non-operator');

    await round.write.settle({ account: other.account });
    assert.equal(Number(await round.read.phase()), 3, 'Settled by a non-operator');
  });

  // Covers the `total > 0` guard: with no project earning any match there are no
  // QF weights to divide the pool by, and the Splits factory would revert on a
  // zero totalAllocation. The round must still be able to close.
  it('settles an empty round without reverting, leaving the pool untouched', async () => {
    const { round, usdc, conn, M } = await fixture();
    await usdc.write.mint([round.address, M]);
    await timeTravel(conn, 21);

    await round.write.finalizeTally();
    await round.write.computeAllocations();
    await round.write.settle();

    assert.equal(Number(await round.read.phase()), 3, 'phase == Settled');
    assert.equal(await round.read.settledSplit(), SPLIT_ZERO, 'no split was created');
    assert.equal(await usdc.read.balanceOf([round.address]), M, 'pool stayed put');
  });

  it('refuses to settle while an allocation is still sealed', async () => {
    const { round, usdc, conn, M } = await fixture();
    await usdc.write.mint([round.address, M]);
    await round.write.registerProject([SPLIT_ZERO, 'demo project']);
    await timeTravel(conn, 21);
    await round.write.finalizeTally();
    await round.write.computeAllocations();
    // one project registered, zero revealed -> revealedCount != projects.length
    await assert.rejects(() => round.write.settle(), /WrongPhase/);
  });

  it('rejects a forged decryption proof', async () => {
    const { round, conn } = await fixture();
    await round.write.registerProject([SPLIT_ZERO, 'demo project']);
    await timeTravel(conn, 21);
    await round.write.finalizeTally();
    await round.write.computeAllocations();
    // The contract trusts only the gateway signature, never the caller's number.
    await assert.rejects(
      () => round.write.revealAllocation([0n, parseEther('9999'), '0x']),
      /.*/,
      'a bogus proof must not be accepted',
    );
  });

  it('underfunded matching pool cannot settle', async () => {
    const { round, conn } = await fixture(); // note: pool never funded
    await timeTravel(conn, 21);
    await round.write.finalizeTally();
    await round.write.computeAllocations();
    await assert.rejects(() => round.write.settle(), /pool underfunded/);
  });

  // ── crowdfunded matching pool ────────────────────────────────────────────

  it('lets anyone top up the matching pool while the round is open', async () => {
    const { round, usdc, other, M } = await fixture();
    const extra = parseEther('2500');
    await usdc.write.mint([other.account.address, extra], { account: other.account });
    await usdc.write.approve([round.address, extra], { account: other.account });
    await round.write.fundPool([extra], { account: other.account });

    assert.equal(await round.read.matchingPool(), M + extra, 'M grew by the top-up');
    assert.equal(await usdc.read.balanceOf([round.address]), extra, 'tokens actually arrived');
  });

  it('refuses pool top-ups once contributions have closed', async () => {
    const { round, usdc, conn, other } = await fixture();
    const extra = parseEther('100');
    await usdc.write.mint([other.account.address, extra], { account: other.account });
    await usdc.write.approve([round.address, extra], { account: other.account });
    await timeTravel(conn, 21);
    // M is an input to the allocation maths; it must not move under a tally.
    await assert.rejects(
      () => round.write.fundPool([extra], { account: other.account }),
      /DeadlinePassed/,
    );
  });

  // ── stranded-pool recovery ───────────────────────────────────────────────

  it('sweeps the pool only when settlement distributed nothing', async () => {
    const { round, usdc, conn, op, other, M } = await fixture();
    await usdc.write.mint([round.address, M]);
    await timeTravel(conn, 21);
    await round.write.finalizeTally();
    await round.write.computeAllocations();
    await round.write.settle();
    // empty round -> no split was created -> the pool is stranded here
    assert.equal(await round.read.settledSplit(), SPLIT_ZERO);

    await assert.rejects(
      () => round.write.sweepPool([other.account.address], { account: other.account }),
      /NotOperator/,
      'a stranger must not be able to drain the pool',
    );

    const before = await usdc.read.balanceOf([op.account.address]);
    await round.write.sweepPool([op.account.address]);
    assert.equal(await usdc.read.balanceOf([round.address]), 0n, 'round drained');
    assert.equal(await usdc.read.balanceOf([op.account.address]), before + M, 'operator repaid');
  });

  // ── pagination ───────────────────────────────────────────────────────────

  it('tallies and allocates across several transactions without advancing early', async () => {
    const { round, usdc, conn, M } = await fixture();
    await usdc.write.mint([round.address, M]);
    for (const n of ['A', 'B', 'C']) await round.write.registerProject([SPLIT_ZERO, `project ${n}`]);
    await timeTravel(conn, 21);

    // One project at a time. The phase must NOT advance until the last one lands:
    // sumMatch is the divisor for every allocation, so a partial tally leaking into
    // the next phase would divide every project by an incomplete total.
    await round.write.finalizeTallyPaged([1n]);
    assert.equal(Number(await round.read.phase()), 0, 'still Contribution after 1 of 3');
    assert.equal(await round.read.tallyCursor(), 1n);
    await round.write.finalizeTallyPaged([1n]);
    assert.equal(Number(await round.read.phase()), 0, 'still Contribution after 2 of 3');
    await round.write.finalizeTallyPaged([1n]);
    assert.equal(Number(await round.read.phase()), 1, 'Tallied only after the last one');
    assert.equal(await round.read.tallyCursor(), 3n);

    await round.write.computeAllocationsPaged([2n]);
    assert.equal(Number(await round.read.phase()), 1, 'still Tallied after 2 of 3');
    assert.equal(await round.read.allocCursor(), 2n);
    await round.write.computeAllocationsPaged([5n]); // overshoot clamps to the end
    assert.equal(Number(await round.read.phase()), 2, 'Allocated');
    assert.equal(await round.read.allocCursor(), 3n);
  });

  it('rejects a zero page size instead of looping forever', async () => {
    const { round, conn } = await fixture();
    await round.write.registerProject([SPLIT_ZERO, 'p']);
    await timeTravel(conn, 21);
    await assert.rejects(() => round.write.finalizeTallyPaged([0n]), /maxCount = 0/);
  });

  // Is UnknownProject reachable at all? `projects[id]` bounds-checks first, so an
  // out-of-range id panics (0x32) long before the `exists` flag is read, and every
  // in-range project has exists == true by construction. If both assertions below
  // hold, the error is dead code.
  it('bounds-checks project ids before the exists flag is ever consulted', async () => {
    const { round, conn, op } = await fixture();
    await round.write.registerProject([SPLIT_ZERO, 'only project']);

    await assert.rejects(
      () => round.write.contribute([99n, `0x${'00'.repeat(32)}`, '0x', op.account.address]),
      (e: Error) => {
        assert.ok(!/UnknownProject/.test(e.message), 'panics on bounds, never UnknownProject');
        return true;
      },
    );

    await timeTravel(conn, 21);
    await round.write.finalizeTally();
    await round.write.computeAllocations();
    await assert.rejects(
      () => round.write.revealAllocation([99n, 1n, '0x']),
      (e: Error) => {
        assert.ok(!/UnknownProject/.test(e.message), 'panics on bounds, never UnknownProject');
        return true;
      },
    );
  });
});
