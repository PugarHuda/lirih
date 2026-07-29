// Reading chain time from a public RPC, safely.
//
// `latest` from a load-balanced endpoint is NOT necessarily recent. A deploy in
// this project anchored a contribution deadline to a block that was seven hours
// stale and produced a round that was closed before it existed — unusable, ~5M
// gas gone. Two calls seconds apart returned timestamps seven hours apart. The
// very first dead round (0x4c9502b6) was almost certainly the same fault,
// misdiagnosed as a local-clock bug.
//
// Every script that compares against a deadline goes through here, because the
// failure is silent in both directions: a stale block makes a closed window look
// open (so seeding runs past the real deadline and reverts mid-way, having spent
// gas) and makes an open window look closed (so a script refuses work that would
// have succeeded).

const TOLERANCE = 180; // s. Sepolia blocks are ~12s; 180s is generous slack.

/// Chain time from a block that is actually current, or throw.
///
/// The wall clock is a CROSS-CHECK, never the anchor — anchoring to it is what
/// breaks when the machine's timezone or clock is off. If the two cannot be
/// reconciled after several attempts, that is worth stopping for: a stale read
/// is recoverable, a stale deadline written into a constructor is not.
export async function freshChainTime(pub: any): Promise<bigint> {
  let last = 0n;
  for (let i = 1; i <= 8; i++) {
    const ts = (await pub.getBlock({ blockTag: 'latest', cacheTime: 0 })).timestamp;
    last = ts;
    const skew = Math.floor(Date.now() / 1000) - Number(ts);
    if (Math.abs(skew) <= TOLERANCE) return ts;
    console.log(`  RPC returned a block ${skew}s behind the wall clock — retrying (${i}/8)…`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `every RPC response was stale (last block ${last}, wall clock ` +
    `${Math.floor(Date.now() / 1000)}). Set SEPOLIA_RPC_URL to a different endpoint.`,
  );
}

/// Block until chain time is past `deadline`, reporting as it waits.
///
/// The alternative — firing the transaction and letting it revert — is what this
/// project actually did, and a `DeadlineNotReached` arrives as an unreadable viem
/// dump with the real reason buried under sixty lines of ABI. Waiting is also
/// simply correct: the round is going to be finalizable, just not yet.
export async function waitForDeadline(pub: any, deadline: bigint, label = 'deadline') {
  for (;;) {
    const now = await freshChainTime(pub);
    const left = Number(deadline - now);
    if (left <= 0) return;
    console.log(`  ${label} in ${left}s — waiting…`);
    await new Promise((r) => setTimeout(r, Math.min(left, 30) * 1000));
  }
}
