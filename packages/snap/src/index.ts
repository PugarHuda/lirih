// Lirih MetaMask Snap. The confidential-compute client (@iexec-nox/handle) runs
// INSIDE the SES sandbox: RSA keygen, ECDH/HKDF/AES-GCM decrypt, gateway fetch —
// plaintext and the ephemeral key never leave MetaMask to a web page.
//
// Verified in the day-0 spike:
//  - crypto.subtle IS available in the Snap SES sandbox (default endowment).
//  - @iexec-nox/handle uses only WebCrypto + fetch (no node:/Buffer/DOM) -> runs here.
//  - eth_signTypedData_v4 from the user's EOA is BLOCKED for snaps
//    (BLOCKED_RPC_METHODS). So the Nox identity is a snap-owned key derived from
//    snap_getEntropy; grant it the Nox viewer role (addViewer) to read handles.
import type { OnRpcRequestHandler, Json } from '@metamask/snaps-sdk';
import { panel, text, heading, copyable } from '@metamask/snaps-sdk';
import { createEthersHandleClient } from '@iexec-nox/handle';
import { Wallet } from 'ethers';

// THIS SNAP DOES NOT ENCRYPT DONATIONS, AND CANNOT.
//
// It exposed an `encryptDonation` method until it was checked against the rule
// that governs it: `Nox.fromExternal` requires the owner of an input proof to be
// the direct `msg.sender` of the transaction consuming it. A donation encrypted
// by this snap-derived identity and submitted by the user's EOA fails that check
// with `InvalidProof`, always. The page never called it — it encrypts with the
// EOA and uses this snap only for the viewer role — so the method was dead code
// that merely LOOKED like the right thing to reach for. The sibling project
// reached for its equivalent and broke its whole Snap path.
//
// The viewing key is the half that carries the coercion-resistance property, and
// it belongs here: SRP-derived, never leaving the sandbox, so the donor can read
// their own contribution and cannot sign anything that proves it to a briber.
//
// Snap-owned signer derived deterministically from the user's SRP. This address
// is the donor's Nox identity; the round/token ACLs are granted to it.
async function snapSigner() {
  const entropy = await snap.request({
    method: 'snap_getEntropy',
    params: { version: 1, salt: 'lirih-nox-v1' },
  });
  return new Wallet(entropy as string);
}

async function client() {
  // ethers signer path — the handle client only needs signTypedData for the
  // gateway auth, which the snap-derived Wallet can do locally (no MetaMask
  // confirmation, so it isn't hit by the blocked-methods restriction).
  return createEthersHandleClient(await snapSigner());
}

export const onRpcRequest: OnRpcRequestHandler = async ({ request }) => {
  switch (request.method) {
    // Decrypt the donor's OWN contribution handle and show it inside MetaMask.
    // The donor learns their number but can't prove it to anyone (they'd have to
    // expose their SRP-derived key) -> coercion resistance.
    case 'decryptMine': {
      const { handle } = request.params as { handle: `0x${string}` };
      const c = await client();
      // A handle exists on-chain immediately, but its ciphertext only exists once
      // the remote Runner has processed the event — and the Runner is
      // single-threaded with no batching. So an early failure is expected, not
      // exceptional; retry before surfacing anything to the user.
      const decrypt = async () => {
        for (let i = 1; i <= 12; i++) {
          try {
            return await c.decrypt(handle);
          } catch (err) {
            if (i === 12) throw err;
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
        throw new Error('unreachable');
      };
      const { value } = await decrypt();
      await snap.request({
        method: 'snap_dialog',
        params: {
          type: 'alert',
          content: panel([
            heading('Your confidential contribution'),
            text('Only you can see this. It never left your wallet.'),
            copyable(`${value}`),
          ]),
        },
      });
      return { value: value.toString() } as Json;
    }

    // The Nox identity address the page must fund / grant ACLs to.
    case 'getNoxAddress': {
      return { address: (await snapSigner()).address } as Json;
    }

    default:
      throw new Error(`Method not found: ${request.method}`);
  }
};
