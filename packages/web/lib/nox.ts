// Browser-side Nox integration for Lirih. Ethereum Sepolia is a built-in
// default in @iexec-nox/handle, so no gateway/subgraph override is needed.
import { createViemHandleClient } from '@iexec-nox/handle';
import type { WalletClient } from 'viem';

export type HandleClient = Awaited<ReturnType<typeof createViemHandleClient>>;

let cached: HandleClient | undefined;

export async function getHandleClient(wallet: WalletClient): Promise<HandleClient> {
  if (!cached) cached = await createViemHandleClient(wallet);
  return cached;
}

/// Encrypt a donation amount into a handle + proof bound to the round contract.
/// The proof binds (wallet, round) — the wallet MUST be the direct tx sender to
/// `contribute`, so submit from this same wallet (no router/multicall).
export async function encryptDonation(
  wallet: WalletClient,
  amount: bigint,
  roundAddress: `0x${string}`,
) {
  const client = await getHandleClient(wallet);
  const { handle, handleProof } = await client.encryptInput(amount, 'uint256', roundAddress);
  return { handle, handleProof };
}

/// Public-decrypt a revealed allocation handle -> {value, decryptionProof}.
/// The proof is fed back to LirihRound.revealAllocation for on-chain verification.
export async function publicDecryptAllocation(wallet: WalletClient, handle: `0x${string}`) {
  const client = await getHandleClient(wallet);
  const { value, decryptionProof } = await client.publicDecrypt(handle);
  return { value: value as bigint, decryptionProof };
}

/// ACL-gated private decrypt (gasless) — used to let a donor read their OWN
/// contribution handle. Requires the wallet to hold the viewer/admin role.
export async function decryptMine(wallet: WalletClient, handle: `0x${string}`) {
  const client = await getHandleClient(wallet);
  const { value } = await client.decrypt(handle);
  return value as bigint;
}
