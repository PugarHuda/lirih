'use client';
// Reads revealed per-project allocations after settlement, and offers the
// donor a "decrypt my contribution" button routed through the Snap sandbox.
import { useEffect, useState } from 'react';
import { formatEther, createWalletClient, custom } from 'viem';
import { sepolia } from 'viem/chains';
import { ADDRESSES, roundAbi, PHASES, pub, tx, connectWallet, explorerAddr } from '../lib/lirih';
import { connectSnap, decryptMine } from '../lib/snap';
import { decryptMine as decryptMineWithEoa, publicDecryptAllocation } from '../lib/nox';

const ZERO_HANDLE = `0x${'00'.repeat(32)}`;

type Row = { id: number; payout: `0x${string}`; alloc: bigint; revealed: boolean; name: string };

export default function Results({ projectId }: { projectId: number }) {
  const [phase, setPhase] = useState<number>();
  const [rows, setRows] = useState<Row[]>([]);
  const [note, setNote] = useState('');
  const [mine, setMine] = useState<bigint>();
  const [error, setError] = useState('');
  const [deadline, setDeadline] = useState<number>();
  const [pool, setPool] = useState<bigint>();
  const [split, setSplit] = useState<`0x${string}`>();
  const [advancing, setAdvancing] = useState(false);
  const [advNote, setAdvNote] = useState('');

  /// Drive the round to settlement. Every step below is PERMISSIONLESS on-chain:
  /// after the deadline the computation is fully determined, so gating it on an
  /// operator would only mean a silent operator could strand donor escrow
  /// forever. Anyone — including whoever is reading this page — can push it
  /// through; they just pay the gas.
  async function advance() {
    if (advancing) return;
    setAdvancing(true);
    setError('');
    try {
      const w = await connectWallet(setAdvNote);
      const me = w.account!.address;
      const send = (functionName: 'finalizeTally' | 'computeAllocations' | 'settle') =>
        tx(w, { address: ADDRESSES.round, abi: roundAbi, functionName, chain: sepolia, account: me });

      const ph = Number(await pub.readContract({ address: ADDRESSES.round, abi: roundAbi, functionName: 'phase' }));

      if (ph === 0) {
        setAdvNote('finalizing tally (encrypted Sp² − Cp per project)…');
        await send('finalizeTally');
      } else if (ph === 1) {
        setAdvNote('computing allocations under encryption…');
        await send('computeAllocations');
      } else if (ph === 2) {
        const n = Number(await pub.readContract({ address: ADDRESSES.round, abi: roundAbi, functionName: 'projectCount' }));
        let revealedAny = false;
        for (let i = 0; i < n; i++) {
          const p = (await pub.readContract({
            address: ADDRESSES.round, abi: roundAbi, functionName: 'projects', args: [BigInt(i)],
          })) as unknown as any[];
          if (p[6]) continue; // already revealed
          setAdvNote(`decrypting allocation for "${p[8] || `project ${i}`}" via the gateway…`);
          // Gateway-signed decryption; the contract verifies the signature and
          // never trusts the number we pass in.
          const { value, decryptionProof } = await publicDecryptAllocation(w, p[4] as `0x${string}`);
          setAdvNote(`submitting the proof for "${p[8] || `project ${i}`}"…`);
          await tx(w, {
            address: ADDRESSES.round, abi: roundAbi, functionName: 'revealAllocation',
            args: [BigInt(i), value, decryptionProof], chain: sepolia, account: me,
          });
          revealedAny = true;
        }
        if (!revealedAny) {
          setAdvNote('settling — paying the matching pool through 0xSplits V2…');
          await send('settle');
        }
      }
      setAdvNote('');
      await refresh();
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      setError(/User rejected|denied/i.test(msg) ? 'Cancelled in wallet.' : msg.split('\n')[0]);
      setAdvNote('');
    } finally {
      setAdvancing(false);
    }
  }

  async function refresh() {
    if (!ADDRESSES.round || ADDRESSES.round === '0x') {
      setError('NEXT_PUBLIC_ROUND is not set — see packages/web/.env.local');
      return;
    }
    setError('');
    try {
      const ph = await pub.readContract({ address: ADDRESSES.round, abi: roundAbi, functionName: 'phase' });
      setPhase(Number(ph));
      setDeadline(Number(await pub.readContract({ address: ADDRESSES.round, abi: roundAbi, functionName: 'contributionDeadline' })));
      setPool((await pub.readContract({ address: ADDRESSES.round, abi: roundAbi, functionName: 'matchingPool' })) as bigint);
      const s = await pub.readContract({ address: ADDRESSES.round, abi: roundAbi, functionName: 'settledSplit' });
      setSplit(s as `0x${string}`);
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
    } catch (err) {
      // Never swallow this. The common cause is a configured round deployed from
      // OLDER contracts than this frontend: `projects()` gained a `name` member,
      // so decoding an older round fails with an out-of-bounds position. Silently
      // showing an empty table made that look like "the round has no projects".
      const msg = (err as Error)?.message ?? String(err);
      setError(
        /out of bounds|position/i.test(msg)
          ? `Cannot decode round ${ADDRESSES.round}: it was deployed from older contracts than this frontend (projects() has no "name" field). Redeploy and update packages/web/.env.local.`
          : `Failed to read round ${ADDRESSES.round}: ${msg.split('\n')[0]}`,
      );
    }
  }

  useEffect(() => { refresh(); }, []);

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
      {error && (
        <p style={{
          padding: '8px 12px', borderRadius: 6, fontSize: 14,
          background: '#fdecea', border: '1px solid #f5aca6',
        }}>{error}</p>
      )}
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
      {phase !== undefined && phase < 3 && (
        <section style={{
          marginTop: 20, padding: '12px 14px', borderRadius: 8,
          background: '#f4f7fb', border: '1px solid #cdd9e8',
        }}>
          <b style={{ fontSize: 14 }}>Advance the round — anyone can do this</b>
          <p style={{ fontSize: 13, color: '#456', margin: '6px 0 10px' }}>
            After the deadline every remaining step is fully determined, so none of
            them is gated on an operator. If the organiser disappears, any donor can
            push the round through and release the funds. You just pay the gas.
          </p>
          <button disabled={advancing || (phase === 0 && !!deadline && Date.now() / 1000 <= deadline)} onClick={advance}>
            {advancing ? '⏳ working…'
              : phase === 0 ? '1 · Finalize tally'
              : phase === 1 ? '2 · Compute allocations'
              : '3 · Reveal & settle'}
          </button>
          {phase === 0 && !!deadline && Date.now() / 1000 <= deadline && (
            <span style={{ marginLeft: 10, fontSize: 13, color: '#666' }}>
              contributions close {new Date(deadline * 1000).toLocaleString()}
            </span>
          )}
          {advNote && <p style={{ fontSize: 13, color: '#456', marginTop: 8 }}>⏳ {advNote}</p>}
        </section>
      )}
      {/* Verify the arithmetic yourself. Every number here is read from chain
          state: the sum of the revealed allocations must equal the matching pool,
          give or take the dust that integer division leaves behind. It is a small
          check, but it is the difference between "the round says it paid out
          correctly" and "you watched it add up". */}
      {phase !== undefined && phase >= 2 && pool !== undefined && rows.every((r) => r.revealed) && rows.length > 0 && (() => {
        const sum = rows.reduce((s, r) => s + r.alloc, 0n);
        const dust = pool > sum ? pool - sum : sum - pool;
        const ok = sum <= pool && dust < BigInt(rows.length + 1);
        return (
          <section style={{
            marginTop: 16, padding: '12px 14px', borderRadius: 8, fontSize: 14,
            background: ok ? '#f2f8f4' : '#fdecea',
            border: `1px solid ${ok ? '#b9dcc6' : '#f5aca6'}`,
          }}>
            <b>{ok ? '✓ Allocations check out' : '⚠ Allocations do not add up'}</b>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
              <li>sum of revealed allocations: {formatEther(sum)}</li>
              <li>matching pool on-chain: {formatEther(pool)}</li>
              <li>
                unallocated remainder: {dust.toString()} wei
                {ok && ' — integer-division dust, at most 1 wei per project'}
              </li>
            </ul>
          </section>
        );
      })()}
      {phase === 3 && split && split !== `0x${'00'.repeat(20)}` && (
        <p style={{ marginTop: 16, fontSize: 14 }}>
          Settled through 0xSplits V2:{' '}
          <a href={explorerAddr(split)} target="_blank" rel="noreferrer">{split.slice(0, 10)}…</a>
        </p>
      )}
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
