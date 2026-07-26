// One real confidential donation against a live Sepolia round — the frontend's
// donor path minus MetaMask. Validates the LIVE Nox gateway (not the local
// Runner): encryptInput -> contribute (fromExternal + 41-bit sqrt on-chain).
//   npx hardhat run scripts/donate.ts --network sepolia
// Env: DONOR_PRIVATE_KEY (defaults to DEPLOYER_PRIVATE_KEY), ROUND_ADDRESS,
//      CUSDC_ADDRESS, MUSDC_ADDRESS, PROJECT_ID, AMOUNT (whole tokens).
import { createWalletClient, createPublicClient, http, getContract, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createViemHandleClient } from '@iexec-nox/handle';

const musdcAbi = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

const cusdcAbi = [
  { type: 'function', name: 'wrap', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'setOperator', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint48' }], outputs: [] },
] as const;

const roundAbi = [
  { type: 'function', name: 'contribute', stateMutability: 'nonpayable',
    inputs: [{ type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes' }, { type: 'address' }],
    outputs: [] },
  { type: 'function', name: 'myContribution', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bytes32' }] },
] as const;

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};

export type DonateOpts = {
  key: `0x${string}`;
  round: `0x${string}`;
  cusdc: `0x${string}`;
  musdc: `0x${string}`;
  projectId: bigint;
  amount: bigint;   // wei-scaled (18dp)
  verify?: boolean; // poll decrypt of own contribution (slow; skip when seeding)
};

export async function donate(o: DonateOpts) {
  const { round, cusdc, musdc, projectId, amount } = o;
  const account = privateKeyToAccount(o.key);
  const transport = http(process.env.SEPOLIA_RPC_URL ?? 'https://sepolia.drpc.org');
  const wallet = createWalletClient({ account, chain: sepolia, transport });
  const pub = createPublicClient({ chain: sepolia, transport });
  console.log(`donor ${account.address} -> project ${projectId}, ${amount / 10n ** 18n} mUSDC`);

  const wait = async (hash: `0x${string}`, label: string) => {
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${label}: ${rc.status} (gas ${rc.gasUsed})`);
    if (rc.status !== 'success') throw new Error(`${label} reverted`);
  };

  const m = getContract({ address: musdc, abi: musdcAbi, client: { public: pub, wallet } });
  const c = getContract({ address: cusdc, abi: cusdcAbi, client: { public: pub, wallet } });
  const r = getContract({ address: round, abi: roundAbi, client: { public: pub, wallet } });

  await wait(await m.write.mint([account.address, amount]), 'mint');
  await wait(await m.write.approve([cusdc, amount]), 'approve');
  await wait(await c.write.wrap([account.address, amount]), 'wrap');
  const until = BigInt(Math.floor(Date.now() / 1000) + 3600);
  await wait(await c.write.setOperator([round, until]), 'setOperator');

  // Encrypt client-side: the gateway encrypts inside its TEE, the proof binds
  // (this wallet, round) so we MUST be the direct tx sender to contribute.
  console.log('encryptInput via live gateway…');
  const handleClient = await createViemHandleClient(wallet);
  const t0 = Date.now();
  const { handle, handleProof } = await handleClient.encryptInput(amount, 'uint256', round);
  console.log(`  handle ${handle} (${Date.now() - t0}ms)`);

  console.log('contribute (fromExternal + encrypted sqrt)…');
  await wait(
    await r.write.contribute([projectId, handle as `0x${string}`, handleProof, account.address]),
    'contribute',
  );
  const mine = await r.read.myContribution([account.address, projectId]);
  console.log(`myContribution handle: ${mine}`);
  if (!o.verify) return mine as `0x${string}`;

  // The handle is on-chain instantly but the ciphertext only exists once the
  // remote Runner has processed the event — poll instead of assuming.
  console.log('decrypting own contribution (ACL-gated, gasless)…');
  for (let i = 1; i <= 30; i++) {
    try {
      const { value } = await handleClient.decrypt(mine as `0x${string}`);
      console.log(`  decrypted after ${i} attempt(s): ${value}`);
      break;
    } catch (e) {
      if (i === 30) throw e;
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
  return mine as `0x${string}`;
}

// CLI entry — only when run directly, so seed-round.ts can import donate().
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  donate({
    key: (process.env.DONOR_PRIVATE_KEY ?? env('DEPLOYER_PRIVATE_KEY')) as `0x${string}`,
    round: env('ROUND_ADDRESS') as `0x${string}`,
    cusdc: env('CUSDC_ADDRESS') as `0x${string}`,
    musdc: env('MUSDC_ADDRESS') as `0x${string}`,
    projectId: BigInt(process.env.PROJECT_ID ?? '0'),
    amount: parseEther(process.env.AMOUNT ?? '100'),
    verify: true,
  }).catch((e) => { console.error(e); process.exitCode = 1; });
}
