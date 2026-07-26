// Talk to the Lirih MetaMask Snap. All confidential compute happens inside the
// Snap's SES sandbox — this page only relays handles/results, never plaintext.
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

/// Encrypt a donation inside the sandbox -> {handle, handleProof} to submit.
export const encryptDonation = (amount: bigint, round: `0x${string}`) =>
  invoke<{ handle: `0x${string}`; handleProof: `0x${string}` }>('encryptDonation', {
    amount: amount.toString(), round,
  });

/// Decrypt the donor's OWN contribution — shown in a MetaMask dialog, never here.
export const decryptMine = (handle: `0x${string}`) =>
  invoke<{ value: string }>('decryptMine', { handle });
