// Shared test-chain time helper.
//
// THE CONSTRAINT: `NoxCompute.proofExpirationDuration` is **1 hour**, and a
// handleProof is rejected once `block.timestamp > createdAt + 1 hour`, where
// `createdAt` comes from the gateway's wall clock. Chain time only moves
// forward, and every test file shares one hardhat node — so the WHOLE SUITE has
// a single ~3600s budget of `evm_increaseTime`. Blow it and later files fail with
// "Proof expired" (pitfall #3), even though each file passes on its own.
//
// Do NOT try to fix this with evm_snapshot/evm_revert: rewinding the chain
// desynchronises the Nox Ingestor, which tracks a block cursor and will not
// re-emit events for block numbers it has already consumed. Handles then never
// resolve at all ("Handles not resolved after 60 attempts") — strictly worse.
//
// The fix is simply to not jump an hour when a few seconds proves the same
// thing: give each round a SHORT contribution window and step just past it.
// Keep each window comfortably larger than the number of transactions the
// contribution phase needs, since hardhat advances the timestamp per block.
export const DRIFT_BUDGET_SECS = 3600;

/// Advance chain time and mine, so `block.timestamp` comparisons observe it.
/// Keep `secs` as small as the assertion allows — see the note above.
export async function timeTravel(conn: any, secs: number): Promise<void> {
  await conn.provider.request({
    method: 'evm_increaseTime',
    params: [`0x${secs.toString(16)}`],
  });
  await conn.provider.request({ method: 'evm_mine', params: [] });
}
