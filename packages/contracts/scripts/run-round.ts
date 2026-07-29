// Operator flow for a deployed Lirih round on Sepolia:
//   finalizeTally -> computeAllocations -> publicDecrypt each alloc -> reveal -> settle
//   npx hardhat run scripts/run-round.ts --network sepolia
// Env: DEPLOYER_PRIVATE_KEY (operator), ROUND_ADDRESS.
import { createWalletClient, createPublicClient, http, getContract } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';
import { waitForDeadline } from './chain-time.ts';

const ABI = [
  { type: 'function', name: 'finalizeTally', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'computeAllocations', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'projectCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'contributionDeadline', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'settledSplit', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'revealAllocation', stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'projects', stateMutability: 'view', inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'payout', type: 'address' }, { name: 'sumRoot', type: 'bytes32' },
      { name: 'sumC', type: 'bytes32' }, { name: 'matchHandle', type: 'bytes32' },
      { name: 'allocHandle', type: 'bytes32' }, { name: 'revealedAlloc', type: 'uint256' },
      { name: 'revealed', type: 'bool' }, { name: 'exists', type: 'bool' },
      { name: 'name', type: 'string' },
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

  // Every step here reads state the previous one wrote, and viem's `write` does
  // NOT await the receipt — firing them back to back reverts with WrongPhase.
  const wait = async (hash: `0x${string}`, label: string) => {
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${label}: ${rc.status} (gas ${rc.gasUsed})`);
    if (rc.status !== 'success') throw new Error(`${label} reverted`);
  };

  // Wait for the deadline instead of firing into it. This script used to call
  // finalizeTally blind, and running it a minute early — or against an RPC backend
  // whose `latest` block lagged — died on `DeadlineNotReached` reported as sixty
  // lines of ABI dump with the actual reason nowhere in the first screenful. The
  // round WILL be finalizable; it just is not yet, and that is a thing to wait
  // for, not to crash on.
  const deadline = (await c.read.contributionDeadline()) as bigint;
  await waitForDeadline(pub, deadline, 'contributions close');

  console.log('finalizeTally…');
  await wait(await c.write.finalizeTally(), 'finalizeTally');
  console.log('computeAllocations…');
  await wait(await c.write.computeAllocations(), 'computeAllocations');

  const n = await c.read.projectCount();
  const revealed: bigint[] = [];
  for (let i = 0n; i < n; i++) {
    const p = await c.read.projects([i]);
    const allocHandle = p[4] as `0x${string}`;
    console.log(`project ${i} (${p[8]}): publicDecrypt(${allocHandle.slice(0, 10)}…)`);
    // The ciphertext only exists once the remote Runner has processed the
    // event; decrypting straight after the tx confirms is a race.
    let out: { value: unknown; decryptionProof: `0x${string}` } | undefined;
    for (let attempt = 1; attempt <= 30; attempt++) {
      try { out = await handle.publicDecrypt(allocHandle); break; }
      catch (e) {
        if (attempt === 30) throw e;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    const { value, decryptionProof } = out!;
    await wait(await c.write.revealAllocation([i, value as bigint, decryptionProof]), `reveal ${i}`);
    console.log(`  revealed alloc = ${value}`);
    revealed.push(value as bigint);
  }

  console.log('settle…');
  await wait(await c.write.settle(), 'settle');
  const total = revealed.reduce((s, v) => s + v, 0n);
  console.log(`\ndone — matching pool split by confidential QF weights.`);
  console.log(`  allocations: ${revealed.join(' / ')}  (total ${total})`);
  console.log(`  split contract: ${await c.read.settledSplit()}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
