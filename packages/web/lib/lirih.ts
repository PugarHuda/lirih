// Minimal ABIs + addresses for the Lirih frontend. Addresses come from
// .env.local — deploy-sepolia.ts prints the block to paste.
import { createPublicClient, createWalletClient, custom, http, type WalletClient } from 'viem';
import { sepolia } from 'viem/chains';

export const ADDRESSES = {
  round: (process.env.NEXT_PUBLIC_ROUND ?? '0x') as `0x${string}`,
  cusdc: (process.env.NEXT_PUBLIC_CUSDC ?? '0x') as `0x${string}`,
  musdc: (process.env.NEXT_PUBLIC_MUSDC ?? '0x') as `0x${string}`,
};

// viem's bundled Sepolia default RPC is unreliable (rpc.sepolia.org is dead);
// point NEXT_PUBLIC_RPC at drpc or a keyed provider.
export const pub = createPublicClient({
  chain: sepolia,
  transport: http(process.env.NEXT_PUBLIC_RPC),
});

/// Connect the injected wallet, ensuring it is actually on Sepolia first.
/// Shared by the donor flow and the round-advancing panel: without the guard the
/// wallet signs against whatever chain it happens to be on and every call
/// reverts against a codeless address, which reads as "the dApp is broken".
export async function connectWallet(onStatus?: (s: string) => void) {
  const eth = (globalThis as any).ethereum;
  if (!eth) throw new Error('No injected wallet found — install MetaMask.');
  const [addr] = (await eth.request({ method: 'eth_requestAccounts' })) as `0x${string}`[];

  const current = (await eth.request({ method: 'eth_chainId' })) as string;
  if (parseInt(current, 16) !== sepolia.id) {
    onStatus?.('wrong network — switching to Sepolia…');
    try {
      await eth.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${sepolia.id.toString(16)}` }],
      });
    } catch {
      throw new Error(
        `This round lives on Ethereum Sepolia (${sepolia.id}); your wallet is on ` +
        `chain ${parseInt(current, 16)}. Switch networks and try again.`,
      );
    }
  }
  return createWalletClient({ chain: sepolia, transport: custom(eth), account: addr });
}

export const explorerTx = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
export const explorerAddr = (a: string) => `https://sepolia.etherscan.io/address/${a}`;

/// Send a write and WAIT for the receipt. Mandatory here: the donate flow is
/// mint -> approve -> wrap -> setOperator, and each step reads the state the
/// previous one wrote. Firing them without awaiting reverts on the wrapper.
/// `onHash` fires as soon as the hash exists, so the UI can link the pending tx
/// instead of freezing for the ~15s until it confirms.
export async function tx(
  w: WalletClient,
  req: Parameters<WalletClient['writeContract']>[0],
  onHash?: (hash: `0x${string}`) => void,
) {
  const hash = await w.writeContract(req);
  onHash?.(hash);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`tx reverted: ${hash}`);
  return hash;
}

export const roundAbi = [
  { type: 'function', name: 'contribute', stateMutability: 'nonpayable',
    inputs: [
      { name: 'projectId', type: 'uint256' },
      { name: 'encAmount', type: 'bytes32' },      // externalEuint256 handle
      { name: 'proof', type: 'bytes' },
      { name: 'viewer', type: 'address' },         // who may decrypt this contribution
    ], outputs: [] },
  { type: 'function', name: 'myContribution', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'revealAllocation', stateMutability: 'nonpayable',
    inputs: [
      { name: 'projectId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'decryptionProof', type: 'bytes' },
    ], outputs: [] },
  { type: 'function', name: 'phase', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'uint8' }] },
  // The post-deadline pipeline is permissionless by design — no operator gate —
  // so the UI can expose it to anyone. See LirihRound.finalizeTally.
  { type: 'function', name: 'finalizeTally', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'computeAllocations', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'contributionDeadline', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'revealedCount', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'matchingPool', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'settledSplit', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'address' }] },
  { type: 'function', name: 'projectCount', stateMutability: 'view', inputs: [],
    outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'projects', stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'payout', type: 'address' },
      { name: 'sumRoot', type: 'bytes32' },
      { name: 'sumC', type: 'bytes32' },
      { name: 'matchHandle', type: 'bytes32' },
      { name: 'allocHandle', type: 'bytes32' },
      { name: 'revealedAlloc', type: 'uint256' },
      { name: 'revealed', type: 'bool' },
      { name: 'exists', type: 'bool' },
      { name: 'name', type: 'string' }, // appended last on-chain; index 8
    ] },
] as const;

export const cusdcAbi = [
  { type: 'function', name: 'wrap', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'setOperator', stateMutability: 'nonpayable',
    inputs: [{ name: 'operator', type: 'address' }, { name: 'until', type: 'uint48' }],
    outputs: [] },
] as const;

export const musdcAbi = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
] as const;

export const PHASES = ['Contribution', 'Tallied', 'Allocated', 'Settled'] as const;
