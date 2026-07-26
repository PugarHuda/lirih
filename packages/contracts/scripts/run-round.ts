// Operator flow for a deployed Lirih round on Sepolia:
//   finalizeTally -> computeAllocations -> publicDecrypt each alloc -> reveal -> settle
//   npx hardhat run scripts/run-round.ts --network sepolia
// Env: DEPLOYER_PRIVATE_KEY (operator), ROUND_ADDRESS.
import { createWalletClient, createPublicClient, http, getContract } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';

const ABI = [
  { type: 'function', name: 'finalizeTally', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'computeAllocations', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'projectCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'revealAllocation', stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'projects', stateMutability: 'view', inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'payout', type: 'address' }, { name: 'sumRoot', type: 'bytes32' },
      { name: 'sumC', type: 'bytes32' }, { name: 'matchHandle', type: 'bytes32' },
      { name: 'allocHandle', type: 'bytes32' }, { name: 'revealedAlloc', type: 'uint256' },
      { name: 'revealed', type: 'bool' }, { name: 'exists', type: 'bool' },
    ] },
] as const;

async function main() {
  const round = process.env.ROUND_ADDRESS as `0x${string}`;
  if (!round) throw new Error('set ROUND_ADDRESS');
  const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`);
  const transport = http(process.env.SEPOLIA_RPC_URL ?? 'https://sepolia.drpc.org');
  const wallet = createWalletClient({ account, chain: sepolia, transport });
  const pub = createPublicClient({ chain: sepolia, transport });
  const handle = await createViemHandleClient(wallet);
  const c = getContract({ address: round, abi: ABI, client: { public: pub, wallet } });

  console.log('finalizeTally…');
  await c.write.finalizeTally();
  console.log('computeAllocations…');
  await c.write.computeAllocations();

  const n = await c.read.projectCount();
  for (let i = 0n; i < n; i++) {
    const p = await c.read.projects([i]);
    const allocHandle = p[4] as `0x${string}`;
    console.log(`project ${i}: publicDecrypt(${allocHandle.slice(0, 10)}…)`);
    const { value, decryptionProof } = await handle.publicDecrypt(allocHandle);
    await c.write.revealAllocation([i, value as bigint, decryptionProof]);
    console.log(`  revealed alloc = ${value}`);
  }

  console.log('settle…');
  await c.write.settle();
  console.log('done — matching pool split by confidential QF weights.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
