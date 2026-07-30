'use client';
// Reads revealed per-project allocations after settlement, and offers the
// donor a "decrypt my contribution" button routed through the Snap sandbox.
import { useEffect, useState } from 'react';
import { formatEther, createWalletClient, custom } from 'viem';
import { sepolia } from 'viem/chains';
import { ADDRESSES, roundAbi, PHASES, pub, tx, connectWallet, explorerAddr, acceptsContributions } from '../lib/lirih';
import { connectSnap, decryptMine } from '../lib/snap';
import { Alert, Check, Ext, Spinner } from './icons';
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
      // Batch through Multicall3 rather than issuing N+5 sequential eth_calls.
      // Multicall3 is already deployed on Sepolia and viem knows its address, so
      // this needs no contract change and works against rounds already live. The
      // sequential version was slow and is what got this project rate-limited by a
      // public RPC provider mid-run.
      const base = { address: ADDRESSES.round, abi: roundAbi } as const;
      const [ph, dl, poolAmt, s, n] = await pub.multicall({
        contracts: [
          { ...base, functionName: 'phase' },
          { ...base, functionName: 'contributionDeadline' },
          { ...base, functionName: 'matchingPool' },
          { ...base, functionName: 'settledSplit' },
          { ...base, functionName: 'projectCount' },
        ],
        allowFailure: false,
      });
      setPhase(Number(ph));
      setDeadline(Number(dl));
      setPool(poolAmt as bigint);
      setSplit(s as `0x${string}`);

      const count = Number(n);
      const projects = count === 0 ? [] : await pub.multicall({
        contracts: Array.from({ length: count }, (_, i) => ({
          ...base, functionName: 'projects' as const, args: [BigInt(i)],
        })),
        allowFailure: false,
      });
      setRows((projects as unknown as any[][]).map((p, i) => ({
        id: i, payout: p[0], alloc: p[5] as bigint,
        revealed: p[6] as boolean, name: (p[8] as string) ?? '',
      })));
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
    <section style={{ marginTop: 'var(--s7)' }}>
      <h2>Results {phase !== undefined && <span className="pill">{PHASES[phase]}</span>}</h2>
      {error && (
        <div role="alert" className="note note-err"><Alert /> {error}</div>
      )}
      <div className="card">
      <table>
        <thead><tr><th>Project</th><th style={{ textAlign: 'right' }}>Matching (revealed)</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                {r.name || `project ${r.id}`}
                <span className="dim mono"> · {r.payout.slice(0, 8)}…</span>
              </td>
              <td className="num">
                {r.revealed
                  ? <span className={r.alloc > 0n ? 'accent' : 'dim'}>{formatEther(r.alloc)} mUSDC</span>
                  : <span className="dim">sealed</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {phase !== undefined && phase < 3 && (
        <section className="card">
          <h3>Advance the round — anyone can do this</h3>
          <p className="dim" style={{ fontSize: '0.9rem' }}>
            After the deadline every remaining step is fully determined, so none of
            them is gated on an operator. If the organiser disappears, any donor can
            push the round through and release the funds. You just pay the gas.
          </p>
          <button disabled={advancing || acceptsContributions(phase, deadline ?? 0)} onClick={advance}>
            {advancing ? 'working…'
              : phase === 0 ? '1 · Finalize tally'
              : phase === 1 ? '2 · Compute allocations'
              : '3 · Reveal & settle'}
          </button>
          {deadline !== undefined && acceptsContributions(phase, deadline) && (
            <span className="dim" style={{ marginLeft: 'var(--s3)', fontSize: '0.85rem' }}>
              contributions close {new Date(deadline * 1000).toLocaleString()}
            </span>
          )}
          {advNote && <p className="dim row" style={{ fontSize: '0.85rem', marginTop: 'var(--s3)' }}><Spinner /> {advNote}</p>}
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
          <section className={`note ${ok ? 'note-ok' : 'note-err'}`} style={{ marginTop: 'var(--s4)' }}>
            <strong className="row">{ok ? <><Check /> Allocations check out</> : <><Alert /> Allocations do not add up</>}</strong>
            <ul style={{ margin: 'var(--s2) 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
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
        <p style={{ marginTop: 'var(--s4)', fontSize: '0.9rem' }}>
          Settled through an unmodified 0xSplits V2:{' '}
          <a href={explorerAddr(split)} target="_blank" rel="noreferrer" className="mono">
            {split.slice(0, 10)}… <Ext />
          </a>
        </p>
      )}
      <div className="row" style={{ marginTop: 'var(--s4)' }}>
        <button className="ghost" onClick={decryptContribution}>Decrypt my contribution</button>
        <button className="ghost" onClick={refresh}>Refresh</button>
      </div>
      {note && <p className="dim" style={{ marginTop: 'var(--s3)', fontSize: '0.9rem' }}>{note}</p>}
      {mine !== undefined && (
        <p style={{ marginTop: 'var(--s2)', fontSize: '0.95rem' }}>
          Your contribution to project {projectId}:{' '}
          <strong className="mono accent">{formatEther(mine)} mUSDC</strong>
        </p>
      )}
    </section>
  );
}
