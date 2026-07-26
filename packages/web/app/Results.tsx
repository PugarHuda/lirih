'use client';
// Reads revealed per-project allocations after settlement, and offers the
// donor a "decrypt my contribution" button routed through the Snap sandbox.
import { useEffect, useState } from 'react';
import { formatEther } from 'viem';
import { ADDRESSES, roundAbi, PHASES, pub } from '../lib/lirih';
import { connectSnap, decryptMine } from '../lib/snap';

type Row = { id: number; payout: `0x${string}`; alloc: bigint; revealed: boolean };

export default function Results({ projectId }: { projectId: number }) {
  const [phase, setPhase] = useState<number>();
  const [rows, setRows] = useState<Row[]>([]);

  async function refresh() {
    const ph = await pub.readContract({ address: ADDRESSES.round, abi: roundAbi, functionName: 'phase' });
    setPhase(Number(ph));
    const n = await pub.readContract({ address: ADDRESSES.round, abi: roundAbi, functionName: 'projectCount' });
    const out: Row[] = [];
    for (let i = 0n; i < (n as bigint); i++) {
      const p = (await pub.readContract({
        address: ADDRESSES.round, abi: roundAbi, functionName: 'projects', args: [i],
      })) as unknown as any[];
      out.push({ id: Number(i), payout: p[0], alloc: p[5] as bigint, revealed: p[6] as boolean });
    }
    setRows(out);
  }

  useEffect(() => { refresh().catch(() => {}); }, []);

  async function decryptContribution() {
    const eth = (window as any).ethereum;
    const [me] = await eth.request({ method: 'eth_requestAccounts' });
    await connectSnap();
    // read the donor's own contribution handle, decrypt it inside the Snap
    const handle = (await pub.readContract({
      address: ADDRESSES.round, abi: roundAbi, functionName: 'myContribution',
      args: [me, BigInt(projectId)],
    })) as `0x${string}`;
    await decryptMine(handle); // shown in a MetaMask dialog, never on this page
  }

  return (
    <section style={{ maxWidth: 560, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h2>Results {phase !== undefined && <small>· phase: {PHASES[phase]}</small>}</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th align="left">Project</th><th align="right">Matching (revealed)</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.payout.slice(0, 8)}…</td>
              <td align="right">{r.revealed ? `${formatEther(r.alloc)} mUSDC` : '— sealed —'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button style={{ marginTop: 12 }} onClick={decryptContribution}>Decrypt my contribution (in-wallet)</button>
      <button style={{ marginTop: 12, marginLeft: 8 }} onClick={refresh}>Refresh</button>
    </section>
  );
}
