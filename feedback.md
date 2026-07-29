# Builder feedback for the iExec Nox team

Built during the WTF Summer Edition while implementing **Lirih**, a confidential
quadratic-funding round. Feedback is grounded in code we actually shipped, not
first impressions. Overall: the primitives are clean and the ERC-7984 library
saved us real work — the sharp edges are all about *what isn't there yet* and a
few footguns that cost us hours.

## What worked well

- **`@iexec-nox/nox-confidential-contracts` is a genuine time-saver.** We wrapped
  plaintext USDC into a confidential token with a 6-line contract
  (`cUSDC is ERC20ToERC7984Wrapper`). Compared to hand-rolling ERC-7984, this is
  the difference between a day and ten minutes. Keep investing here.
- **`Nox.select` as the only branching primitive is the right call.** Once you
  internalise "compute both sides, pick one", the model is clean. We derived a
  full boolean algebra (AND/OR/NOT/XOR) from `select` in ~20 lines.
- **The no-revert / capping semantics of ERC-7984 transfers are correct and
  underrated.** Reading the *returned* transferred handle (not the requested
  amount) let us prevent donors from earning QF weight beyond their real balance
  — a security property that falls out of the design for free.

## Missing primitives that cost us the most

1. **No `sqrt`, and no way to build a fast one.** Quadratic funding needs
   `√cᵢ` per contribution. Newton's method needs a bit-length seed to converge
   in a fixed iteration count — but there are **no bit operations** (`and/or/xor/
   shl/shr`) and no way to read a value's bit length under encryption, so Newton
   from `seed = a` does **not** converge for large inputs (we measured it wrong
   on 5/13 of our test vector at 20 iterations). We fell back to a bit-by-bit
   **binary search** using `add/mul/le/select` — correct and deterministic, but
   `4 × bit-count` ops per root. Capping our input domain to 1e24 let us use 41
   bits (164 ops) instead of 128 (512). **Ask:** a native `sqrt`, or even just
   bit ops + a `msb`/bit-length helper, would turn a 164-op loop into a handful.
2. **No `min`/`max`.** Trivial to build (`select(lt(a,b),a,b)`) but so common
   they belong in the library.
3. **Only 5 encrypted types actually work** (`ebool`, `euint16`, `euint256`,
   `eint16`, `eint256`), while the type-overview docs advertise `euint8/32/64/128`
   and `ebytes*`. We designed everything around `euint256`, but the docs led us
   down a wrong path first. Please mark the unimplemented types clearly.

## Footguns (all cost us real time)

- **Forgetting `Nox.allowThis` on a stored result silently orphans the handle
  next transaction.** This is the single easiest way to ship a broken contract.
  A compile-time or lint warning ("result handle stored without allowThis")
  would prevent an entire class of bugs.
- **`div` saturating to MAX on zero divisor (instead of reverting) is the right
  privacy choice but a correctness trap.** We had to guard every division
  (`select(eq(d,0), ONE, d)`). Please make this prominent in the arithmetic docs
  with the exact guard pattern.
- **`fromExternal` binds the proof to `msg.sender` as the *direct* caller.** Any
  router/multicall in front of the contract breaks it with `InvalidProof`. This
  is correct but surprising; a one-line note in the `fromExternal` docs ("the
  encrypting wallet must be the direct msg.sender") would save people.
- **The proof also expires (`proofExpirationDuration`).** We hit stale-proof
  reverts in testing before we understood this.
- **`unwrap` returns a request id that is a FRESH handle, not the amount handle
  you passed in.** `_burn` mints a new one, and that is what gets
  `allowPublicDecryption` and what `finalizeUnwrap` expects. A contract reads it
  from the return value; an off-chain caller cannot, so the only way to get it is
  the `UnwrapRequested` event. Passing the handle you supplied fails with *"does
  not exist or is not publicly decryptable"*, which reads like Runner lag and is
  not. The interface comment says the id "is the amount handle returned by
  `unwrap`" — the word doing all the work there is *returned*, and it is easy to
  read as *supplied*. Worth an explicit "this is a new handle; read it from the
  event off-chain".
- **We could not get a freshly-minted burn handle to resolve on the local Runner
  at all**, across ~90s of retries and mined blocks, in a test that unwraps
  straight after settlement. Every other handle in the same suite resolves fine,
  including handles the same wrapper produces when the unwrap is initiated by a
  *contract* rather than an EOA (our sibling project does exactly that and it
  works). We could not tell from the error whether this is an Ingestor ordering
  issue, an ACL one, or our own mistake — which is the actual feedback: *"Handles
  not resolved after 60 attempts"* is the same message for "wait longer", "wrong
  handle", and "this will never resolve", and only the first is worth retrying.

## Docs / tooling

- `docs.iex.ec/nox-protocol/*` now 308-redirects to `docs.noxprotocol.io`. The
  hackathon brief still links the old host.
- **`github.com/iExec-Nox/nox-hardhat-starter` returns 404** (linked in the
  brief's Developer Resources). The working equivalent is
  `packages/example-project` inside `nox-hardhat-plugin`. Please fix the link or
  publish the starter.
- The Hardhat plugin requiring `@iexec-nox/nox-protocol-contracts` as a **direct**
  dependency (not transitive) is easy to miss; the error message is good, but a
  line in the quickstart would help.
- **No published per-op latency/throughput number.** Since Nox is TEE (not FHE),
  the cost of a computation is dominated by the sequential event→poll→Runner
  round-trip, and the Runner processes one event at a time. For anything with a
  big op count (our sqrt loops), this decides whether a live demo is feasible.
  A rough "expect ~X ms/op on testnet" figure would let builders size their
  designs without benchmarking blind.

## One concrete request

A confidential `sqrt` (or bit ops to build one cheaply) would unlock quadratic
funding, geometric means, RMS, and any statistics that need roots — a whole
category of confidential-DeFi apps beyond linear arithmetic. It was the single
biggest thing standing between our design and a clean implementation.
