'use client';
// Reads revealed per-project allocations after settlement, and offers the
// donor a "decrypt my contribution" button routed through the Snap sandbox.
import { useEffect, useState } from 'react';
import { formatEther, createWalletClient, custom } from 'viem';
import { sepolia } from 'viem/chains';
import { ADDRESSES, roundAbi, PHASES, pub } from '../lib/lirih';
import { connectSnap, decryptMine } from '../lib/snap';
import { decryptMine as decryptMineWithEoa } from '../lib/nox';

const ZERO_HANDLE = `0x${'00'.repeat(32)}`;

type Row = { id: number; payout: `0x${string}`; alloc: bigint; revealed: boolean; name: string };

export default function Results({ projectId }: { projectId: number }) {
  const [phase, setPhase] = useState<number>();
  const [rows, setRows] = useState<Row[]>([]);
  const [note, setNote] = useState('');
  const [mine, setMine] = useState<bigint>();

  async function refresh() {
    const ph = await pub.readContract({ address: ADDRESSES.round, abi: roundAbi, functionName: 'phase' });
    setPhase(Number(ph));
    const n = await pub.readContract({ address: ADDRESSES.round, abi: roundAbi, functionName: 'projectCount' });
    const out: Row[] = [];
    for (let i = 0n; i < (n as bigint); i++) {
      const p = (await pub.readContract({
        address: ADDRESSES.round, abi: roundAbi, functionName: 'projects', args: [i],
      })) as unknown as any[];
      out.push({
        id: Number(i), payout: p[0], alloc: p[5] as bigint,
        revealed: p[6] as boolean, name: (p[8] as string) ?? '',
      });
    }
    setRows(out);
  }

  useEffect(() => { refresh().catch(() => {}); }, []);

  async function decryptContribution() {
    setNote('');
    setMine(undefined);
    const eth = (window as any).ethereum;
    const [me] = (await eth.request({ method: 'eth_requestAccounts' })) as `0x${string}`[];

    const handle = (await pub.readContract({
      address: ADDRESSES.round, abi: roundAbi, functionName: 'myContribution',
      args: [me, BigInt(projectId)],
    })) as `0x${string}`;

    if (handle === ZERO_HANDLE) {
      setNote(`no contribution from this account to project ${projectId}`);
      return;
    }

    // Prefer the Snap: it decrypts inside the SES sandbox and shows the number in
    // a MetaMask dialog, so plaintext never reaches this page. Only if the Snap
    // is unavailable do we decrypt here with the EOA — which is also the case
    // where the donation was never coercion-resistant to begin with.
    try {
      await connectSnap();
      setNote('decrypting inside the MetaMask Snap…');
      await decryptMine(handle);
      setNote('shown in MetaMask — it never reached this page');
    } catch {
      setNote('Snap unavailable — decrypting on this page with your EOA…');
      const w = createWalletClient({ chain: sepolia, transport: custom(eth), account: me });
      const value = await decryptMineWithEoa(w, handle, (i, n) =>
        setNote(`waiting for the Nox Runner to publish the ciphertext… (${i}/${n})`));
      setMine(value);
      setNote('decrypted locally with your EOA — this key CAN prove the amount to others');
    }
  }

  return (
    <section style={{ maxWidth: 560, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h2>Results {phase !== undefined && <small>· phase: {PHASES[phase]}</small>}</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th align="left">Project</th><th align="right">Matching (revealed)</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.name || `project ${r.id}`}
                <span style={{ color: '#888', fontSize: 12 }}> · {r.payout.slice(0, 8)}…</span>
              </td>
              <td align="right">{r.revealed ? `${formatEther(r.alloc)} mUSDC` : '— sealed —'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button style={{ marginTop: 12 }} onClick={decryptContribution}>Decrypt my contribution (in-wallet)</button>
      <button style={{ marginTop: 12, marginLeft: 8 }} onClick={refresh}>Refresh</button>
      {note && <p style={{ marginTop: 10, fontSize: 14, color: '#555' }}>{note}</p>}
      {mine !== undefined && (
        <p style={{ marginTop: 6, fontSize: 14 }}>
          Your contribution to project {projectId}: <b>{formatEther(mine)} mUSDC</b>
        </p>
      )}
    </section>
  );
}
