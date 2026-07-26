import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { nox } from '@iexec-nox/nox-hardhat-plugin';

// floor(√a) reference — mirrors reference/qf-reference.mjs
function floorSqrt(a: bigint): bigint {
  if (a < 2n) return a;
  let x = a, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + a / x) / 2n; }
  return x;
}

describe('Isqrt (encrypted, on-chain) matches floor(sqrt)', () => {
  // Few values: each sqrt is ~164 sequential Runner ops. Perfect square,
  // messy value, and a big in-domain value.
  const cases = [4n, 3n * 10n ** 18n + 7n, 10n ** 18n];

  it('computes floor(sqrt) under encryption', async () => {
    const { viem } = await nox.connect();
    const c = await viem.deployContract('TestIsqrt');

    for (const a of cases) {
      const { handle, handleProof } = await nox.encryptInput(a, 'uint256', c.address);
      await c.write.sqrtPublic([handle, handleProof]);
      const resultHandle = await c.read.lastResult();
      const { value } = await nox.publicDecrypt(resultHandle as `0x${string}`);
      assert.equal(value, floorSqrt(a), `sqrt(${a})`);
    }
  });
});
