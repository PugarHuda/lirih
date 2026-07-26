// Reference / oracle for the on-chain encrypted math. Pure BigInt, no deps.
// Proves the algorithm choice BEFORE porting to Nox encrypted ops.
// Run: node reference/qf-reference.mjs
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 1. Integer sqrt — two candidates. We must pick the one that is EXACT on the
//    edges under the constraints of Nox (no bit ops, fixed loop count, no
//    early-stop). This test is why we choose bounded binary search over Newton.
// ---------------------------------------------------------------------------

// Candidate A: Newton, fixed 20 iters, seed = a (what the spike optimistically
// assumed). Mirrors the encrypted version exactly so its FAILURE is honest.
function isqrtNewton(a, iters = 20) {
  if (a === 0n) return 0n;
  let r = a;
  for (let i = 0; i < iters; i++) {
    const rSafe = r === 0n ? 1n : r;
    r = (r + a / rSafe) / 2n;
  }
  // floor correction — BOUNDED to 3 steps, as the encrypted version must be
  // (no unbounded loop over encrypted data). If Newton hasn't converged, this
  // leaves r far from floor(sqrt) — which is exactly the failure we're proving.
  for (let k = 0; k < 3 && r * r > a; k++) r -= 1n;
  return r;
}

// Candidate B: bit-by-bit binary search over `bits` high bits. Deterministic,
// always floor(sqrt(a)) as long as bits >= ceil(bitlen(a)/2). Uses only
// add / mul / compare / select in encrypted form -> 4 ops * bits.
function isqrtBinary(a, bits) {
  let result = 0n;
  for (let i = bits - 1; i >= 0; i--) {
    const bit = 1n << BigInt(i);
    const trial = result + bit;          // add (bit is a plaintext e-const)
    if (trial * trial <= a) result = trial; // mul + le + select
  }
  return result;
}

const trueFloorSqrt = (a) => {
  if (a < 2n) return a;
  let x = a, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + a / x) / 2n; }
  return x;
};

// Contribution domain: 1 wei .. 1,000,000 tokens (1e24). So sqrt <= 1e12 < 2^40.
// => bounded binary search needs only 41 bits, not 128. That's 164 ops, not 512.
const MAX_C = 10n ** 24n;
const SQRT_BITS = 41; // 2^41 = 2.2e12 > 1e12, covers the whole domain with margin

console.log('--- isqrt: Newton(20, seed=a) vs bounded binary search ---');
const samples = [
  0n, 1n, 2n, 3n, 4n, 99n, 100n, 10n ** 6n,
  10n ** 18n,            // 1 token
  3n * 10n ** 18n + 7n,  // messy
  10n ** 21n,            // 1k tokens
  10n ** 24n,            // 1M tokens (domain max)
  (10n ** 12n) ** 2n,    // perfect square at the top
];
let newtonFails = 0, binaryFails = 0;
for (const a of samples) {
  const want = trueFloorSqrt(a);
  const n = isqrtNewton(a);
  const b = isqrtBinary(a, SQRT_BITS);
  if (n !== want) { newtonFails++; console.log(`  Newton  MISS a=${a} got=${n} want=${want}`); }
  if (b !== want) { binaryFails++; console.log(`  Binary  MISS a=${a} got=${b} want=${want}`); }
}
console.log(`Newton(20) failures: ${newtonFails}/${samples.length}  <- why we DON'T use it`);
console.log(`Bounded-binary failures: ${binaryFails}/${samples.length}`);
assert.equal(binaryFails, 0, 'bounded binary search must be exact on the whole domain');

// Randomised exactness sweep for the chosen algorithm (seeded-free, deterministic loop)
for (let k = 0; k < 5000; k++) {
  const a = (BigInt(k) * 7919n * 10n ** 15n + BigInt(k * k)) % MAX_C;
  assert.equal(isqrtBinary(a, SQRT_BITS), trueFloorSqrt(a),
    `binary isqrt exact failed at a=${a}`);
}
console.log('Bounded-binary EXACT over 5000-point sweep of [0, 1e24]  OK');

// ---------------------------------------------------------------------------
// 2. QF allocation. matchP = (Σ√cᵢ)² − Σcᵢ  (clamp >=0);  allocP = M·matchP/ΣmatchP
//    This is the oracle the Solidity settle() will be checked against.
// ---------------------------------------------------------------------------
function qfAllocate(projects, M) {
  // projects: array of arrays of contributions (bigint wei)
  const match = projects.map((cs) => {
    const sumRoot = cs.reduce((s, c) => s + isqrtBinary(c, SQRT_BITS), 0n);
    const sumC = cs.reduce((s, c) => s + c, 0n);
    const raw = sumRoot * sumRoot - sumC;     // safeSub clamps negative -> 0
    return raw > 0n ? raw : 0n;
  });
  const total = match.reduce((s, m) => s + m, 0n);
  const alloc = match.map((m) => (total === 0n ? 0n : (M * m) / total)); // floor
  return { match, alloc, total };
}

console.log('\n--- QF allocation ---');
// Classic QF property: many small donors beat one whale of equal total.
const whale = [[100n * 10n ** 18n], []];                 // one 100-token donor
whale[1] = Array.from({ length: 100 }, () => 1n * 10n ** 18n); // 100 x 1-token
const M = 1000n * 10n ** 18n;
const { match, alloc } = qfAllocate(whale, M);
console.log(`whale match=${match[0] / 10n ** 18n}  crowd match=${match[1] / 10n ** 18n} (tokens)`);
assert.ok(match[1] > match[0], 'QF must reward the crowd over the whale');
assert.ok(alloc[1] > alloc[0], 'crowd gets the larger match allocation');

// Conservation: allocations never exceed the pool (floor division only loses dust)
const distributed = alloc.reduce((s, a) => s + a, 0n);
assert.ok(distributed <= M, 'never over-distribute the matching pool');
assert.ok(M - distributed < BigInt(alloc.length), 'dust is at most (#projects-1) wei');
console.log(`pool=${M / 10n ** 18n}  distributed=${distributed / 10n ** 18n}  dust=${M - distributed} wei  OK`);

// Empty round doesn't divide by zero (mirrors the on-chain sumMatch==0 guard)
assert.deepEqual(qfAllocate([[], []], M).alloc, [0n, 0n]);
console.log('empty round -> zero alloc, no div-by-zero  OK');

console.log('\nALL REFERENCE CHECKS PASSED');
