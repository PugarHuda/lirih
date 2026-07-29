// Talk to the Lirih MetaMask Snap.
//
// The Snap holds the VIEWING key, not the encrypting one. `Nox.fromExternal`
// requires the proof's owner to be the transaction's direct `msg.sender`, so only
// the EOA can encrypt a donation it is about to submit — see packages/snap/src.
// Decryption of your own contribution DOES happen in the sandbox, and that is the
// half the coercion-resistance claim rests on.
const SNAP_ID = process.env.NEXT_PUBLIC_SNAP_ID ?? 'local:http://localhost:8080';

const eth = () => (window as any).ethereum;

export async function connectSnap() {
  await eth().request({ method: 'wallet_requestSnaps', params: { [SNAP_ID]: {} } });
}

function invoke<T>(method: string, params?: unknown): Promise<T> {
  return eth().request({
    method: 'wallet_invokeSnap',
    params: { snapId: SNAP_ID, request: { method, params } },
  });
}

/// Nox identity address the Snap controls (derived from the user's SRP).
/// Fund this address with cUSDC and grant it ACLs.
export const getNoxAddress = () => invoke<{ address: `0x${string}` }>('getNoxAddress');

/// Decrypt the donor's OWN contribution — shown in a MetaMask dialog, never here.
export const decryptMine = (handle: `0x${string}`) =>
  invoke<{ value: string }>('decryptMine', { handle });
