'use client';
// The donor path: faucet -> wrap -> authorise -> confidential donate, plus the
// permissionless panel that lets anyone drive a round to settlement.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { parseEther, formatEther } from 'viem';
import { sepolia } from 'viem/chains';
import { encryptDonation } from '../../lib/nox';
import {
  ADDRESSES, roundAbi, cusdcAbi, musdcAbi, tx, explorerTx, connectWallet, pub,
  readRoundStatus, acceptsContributions, PHASES, SQRT_WEIGHT_CAP,
} from '../../lib/lirih';
import { connectSnap, getNoxAddress } from '../../lib/snap';
import { Alert, Ext, Lock, Spinner } from '../icons';
import Results from '../Results';

/// Which key holds the viewer role — the thing that decides whether the
/// coercion-resistance claim actually holds for this donation. Never inferred
/// silently; see donate().
type ViewerMode = 'snap' | 'eoa';

/// A deadline is only useful as a distance. "8/5/2026, 8:34:00 AM" makes you do
/// arithmetic before you know whether you can still donate; "4d 6h" does not.
function Countdown({ to }: { to: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);
  const left = to - now;
  if (left <= 0) return <>closed</>;
  const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  return <>{d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`}</>;
}

export default function App() {
  const [account, setAccount] = useState<`0x${string}`>();
  const [amount, setAmount] = useState('100');
  const [projectId, setProjectId] = useState('0');
  const [status, setStatus] = useState('');
  const [viewerMode, setViewerMode] = useState<ViewerMode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hashes, setHashes] = useState<{ label: string; hash: `0x${string}` }[]>([]);
  const [round, setRound] = useState<{ phase: number; deadline: number }>();
  const [pool, setPool] = useState<bigint>();

  // Read the round's phase before offering to spend anyone's gas on it. A
  // settled round is the NORMAL state of a demo deployment, so this is what most
  // visitors will hit.
  useEffect(() => {
    readRoundStatus().then(setRound).catch((e) =>
      setError(`Cannot read round ${ADDRESSES.round}: ${(e as Error).message.split('\n')[0]}`));
    // The strip degrades to a placeholder if this fails rather than taking the
    // page down; Results is where read failures are reported.
    pub.readContract({ address: ADDRESSES.round, abi: roundAbi, functionName: 'matchingPool' })
      .then((m) => setPool(m as bigint)).catch(() => {});
  }, []);

  const open = round ? acceptsContributions(round.phase, round.deadline) : undefined;
  const overCap = Number(amount) > SQRT_WEIGHT_CAP;

  // Whether this visitor has given to the selected project. Deliberately NOT the
  // amount: that is encrypted, and reading it needs the viewer role and a gateway
  // round trip. Participation is already public — the Contributed event names the
  // donor — so showing it here reveals nothing the chain does not.
  const [gave, setGave] = useState<boolean>();
  useEffect(() => {
    setGave(undefined);
    if (!account) return;
    pub.readContract({
      address: ADDRESSES.round, abi: roundAbi, functionName: 'hasGiven',
      args: [account, BigInt(projectId)],
    }).then((g) => setGave(g as boolean)).catch(() => {});
  }, [account, projectId]);

  const mineLabel = !account
    ? <small>connect to see</small>
    : gave === undefined ? '…'
    : gave ? <><span className="accent">sealed</span> <small>decrypt below</small></>
    : <small>none yet</small>;

  /// One place that disables input mid-flight, and one place that SHOWS failures.
  /// Without it a throw (wrong network, rejection, revert) disappeared into an
  /// unhandled rejection and the page just sat there.
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      setError(/User rejected|denied/i.test(msg) ? 'Cancelled in wallet.' : msg.split('\n')[0]);
      setStatus('');
    } finally { setBusy(false); }
  }

  const track = (label: string) => (hash: `0x${string}`) =>
    setHashes((h) => [...h, { label, hash }]);

  async function wallet() {
    const w = await connectWallet(setStatus);
    setAccount(w.account.address);
    return w;
  }

  async function faucetAndWrap() {
    const w = await wallet();
    const amt = parseEther(amount);
    const me = w.account!.address;
    setStatus('1/4 minting mUSDC…');
    await tx(w, { address: ADDRESSES.musdc, abi: musdcAbi, functionName: 'mint', args: [me, amt], chain: sepolia, account: me }, track('mint'));
    setStatus('2/4 approving the wrapper…');
    await tx(w, { address: ADDRESSES.musdc, abi: musdcAbi, functionName: 'approve', args: [ADDRESSES.cusdc, amt], chain: sepolia, account: me }, track('approve'));
    setStatus('3/4 wrapping to cUSDC — this amount IS public; only what you do next is private…');
    await tx(w, { address: ADDRESSES.cusdc, abi: cusdcAbi, functionName: 'wrap', args: [me, amt], chain: sepolia, account: me }, track('wrap'));
    setStatus('4/4 authorising the round…');
    // Expire the authorisation at the round's own deadline, read from CHAIN —
    // not "an hour from now" by the browser's clock. setOperator is compared
    // against block.timestamp, so a visitor whose clock runs slow was granting an
    // authorisation that had already expired, and the only symptom was
    // `contribute` failing two steps later with nothing pointing at the cause.
    const until = round?.deadline ?? Number(await pub.readContract({
      address: ADDRESSES.round, abi: roundAbi, functionName: 'contributionDeadline',
    }));
    await tx(w, { address: ADDRESSES.cusdc, abi: cusdcAbi, functionName: 'setOperator', args: [ADDRESSES.round, until], chain: sepolia, account: me }, track('setOperator'));
    setStatus('ready to donate');
  }

  /// Permissionless while the round is open — a matching pool can be crowdfunded
  /// rather than fixed by one sponsor at deployment. The contract credits only
  /// what actually arrives, so a fee-on-transfer token cannot inflate it.
  async function fundPool() {
    const w = await wallet();
    const amt = parseEther(amount);
    const me = w.account!.address;
    setStatus('1/3 minting mUSDC…');
    await tx(w, { address: ADDRESSES.musdc, abi: musdcAbi, functionName: 'mint', args: [me, amt], chain: sepolia, account: me }, track('mint'));
    setStatus('2/3 approving the round…');
    await tx(w, { address: ADDRESSES.musdc, abi: musdcAbi, functionName: 'approve', args: [ADDRESSES.round, amt], chain: sepolia, account: me }, track('approve'));
    setStatus('3/3 funding the matching pool — this amount is public by design…');
    await tx(w, { address: ADDRESSES.round, abi: roundAbi, functionName: 'fundPool', args: [amt], chain: sepolia, account: me }, track('fundPool'));
    setStatus('matching pool topped up');
  }

  async function donate() {
    const w = await wallet();
    // Encrypt with the EOA: `fromExternal` requires the proof's owner to be the
    // direct tx sender. The VIEWER is what decides whether coercion resistance
    // holds, so it is never chosen silently — Snap identity means the key lives
    // in the SES sandbox and cannot sign for a briber; the EOA fallback can.
    let viewer = w.account!.address as `0x${string}`;
    let mode: ViewerMode = 'eoa';
    try {
      await connectSnap();
      viewer = (await getNoxAddress()).address;
      mode = 'snap';
    } catch { /* no Snap — fall back, but say so */ }
    setViewerMode(mode);

    setStatus('encrypting your amount inside the Nox gateway TEE…');
    const { handle, handleProof } = await encryptDonation(
      w, parseEther(amount), ADDRESSES.round,
      (i, n) => setStatus(`gateway busy — backing off and retrying (${i}/${n})…`),
    );
    setStatus('submitting — the calldata carries a 32-byte handle, not your amount…');
    await tx(w, {
      address: ADDRESSES.round, abi: roundAbi, functionName: 'contribute',
      args: [BigInt(projectId), handle as `0x${string}`, handleProof, viewer],
      chain: sepolia, account: w.account!.address,
    }, track('contribute'));
    setStatus('done — your amount is encrypted on-chain');
  }

  return (
    <main className="wrap" style={{ paddingTop: 'var(--s6)', paddingBottom: 'var(--s8)' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s5)' }}>
        <Link href="/" className="mono dim" style={{ textDecoration: 'none' }}>← Lirih</Link>
        <span className="pill">{account ? `${account.slice(0, 6)}…${account.slice(-4)}` : 'not connected'}</span>
      </div>

      <h2 style={{ marginBottom: 'var(--s3)' }}>Donate confidentially</h2>
      <p className="dim narrow" style={{ fontSize: '0.95rem' }}>
        Four transactions get you a confidential balance and authorise the round; the
        fifth is the donation itself, and it is the only one nobody can read.
      </p>

      {/* State before actions. Every value is read from the round, so what the
          page offers below and what it reports here cannot disagree. */}
      <dl className="stats">
        <div>
          <dt>Phase</dt>
          <dd className={open ? 'accent' : undefined}>
            {round ? PHASES[round.phase] ?? round.phase : '…'}
          </dd>
        </div>
        <div>
          <dt>{open ? 'Closes' : 'Closed'}</dt>
          <dd>{round ? <Countdown to={round.deadline} /> : '…'}</dd>
        </div>
        <div>
          <dt>Matching pool</dt>
          <dd>{pool === undefined ? '…' : Number(formatEther(pool)).toLocaleString()} <small>mUSDC</small></dd>
        </div>
        <div>
          <dt>Your donation</dt>
          <dd>{mineLabel}</dd>
        </div>
      </dl>

      {open === false && round && (
        <div className="note note-info" style={{ marginBottom: 'var(--s4)' }}>
          <strong>This round is closed to new donations</strong> — it is in phase{' '}
          <strong>{PHASES[round.phase] ?? round.phase}</strong>
          {round.phase === 0 && `, and its deadline passed ${new Date(round.deadline * 1000).toLocaleString()}`}.
          Donating would revert, so the buttons below are disabled. You can still read the
          revealed allocations, check they add up against the on-chain pool, decrypt your own
          contribution, and — if it has not settled — push it to settlement yourself below.
        </div>
      )}

      <div className="card">
        <div className="row">
          <label>Amount
            <input value={amount} onChange={(e) => setAmount(e.target.value)} size={10} aria-label="Amount in mUSDC" />
          </label>
          <label>Project
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project id">
              <option value="0">0 · Clean Water Initiative</option>
              <option value="1">1 · Open Source Maintainers</option>
            </select>
          </label>
        </div>

        {overCap && (
          <div className="note note-warn" style={{ marginTop: 'var(--s3)' }}>
            <Alert /> Matching weight is capped at {SQRT_WEIGHT_CAP.toLocaleString()} mUSDC per
            donor per project. Anything above still escrows and still reaches the project — it
            just earns no further matching. The cap is what keeps the encrypted 41-bit square
            root exact, and it doubles as an anti-whale bound.
          </div>
        )}

        <div className="row" style={{ marginTop: 'var(--s4)' }}>
          <button disabled={busy || open !== true} onClick={() => run(faucetAndWrap)}>
            1 · Faucet + wrap + authorise
          </button>
          <button disabled={busy || open !== true} onClick={() => run(donate)}>
            2 · Donate (encrypted)
          </button>
          {open === true && (
            <button className="ghost" disabled={busy} onClick={() => run(fundPool)}>
              Fund the matching pool
            </button>
          )}
        </div>
        {open === true && (
          <p className="dim" style={{ margin: 'var(--s3) 0 0', fontSize: '0.85rem' }}>
            Topping up the pool is permissionless — it can be crowdfunded rather than fixed by
            one sponsor. That amount is public by design; only donations are secret.
          </p>
        )}
      </div>

      {status && (
        <p className="dim row" style={{ fontSize: '0.9rem' }}>
          {busy && <Spinner />}{status}
        </p>
      )}
      {error && <div role="alert" className="note note-err"><Alert /> {error}</div>}

      {hashes.length > 0 && (
        <ul className="steps card" style={{ marginTop: 'var(--s4)' }}>
          {hashes.map(({ label, hash }) => (
            <li key={hash} className="row" style={{ justifyContent: 'space-between' }}>
              <span>{label}</span>
              <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="mono">
                {hash.slice(0, 12)}… <Ext />
              </a>
            </li>
          ))}
        </ul>
      )}

      {viewerMode && (
        <div className={`note ${viewerMode === 'snap' ? 'note-ok' : 'note-warn'}`} style={{ marginTop: 'var(--s4)' }}>
          {viewerMode === 'snap' ? (
            <><Lock /> <strong>Coercion-resistant.</strong> Your viewing key lives inside the
            MetaMask Snap sandbox. You can read your own donation; you cannot prove it to
            anyone else.</>
          ) : (
            <><Alert /> <strong>Snap not installed.</strong> Your EOA was granted the viewing
            role. The amount is still encrypted on-chain, but that key CAN be used to prove it
            to a third party — so this donation is not coercion-resistant. Install the Snap for
            the full guarantee.</>
          )}
        </div>
      )}

      <Results projectId={Number(projectId)} />
    </main>
  );
}
