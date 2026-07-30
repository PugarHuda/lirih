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
import { Shell } from '../Shell';
import { explorerAddr } from '../../lib/lirih';

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
  const [view, setView] = useState('donate');
  // Read from chain, not hardcoded: the names live on-chain precisely so the UI
  // cannot pass off a label map as real state, and a round with three projects
  // must not render two.
  const [projects, setProjects] = useState<{ id: number; name: string; payout: `0x${string}`; gave: boolean }[]>([]);

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

  // The project list, and whether this visitor has already given to each. Both
  // are plaintext on-chain — participation is public, only amounts are secret —
  // so this costs no gateway round trip and reveals nothing the events do not.
  useEffect(() => {
    (async () => {
      const base = { address: ADDRESSES.round, abi: roundAbi } as const;
      const n = Number(await pub.readContract({ ...base, functionName: 'projectCount' }));
      if (n === 0) return;
      const rows = await pub.multicall({
        contracts: Array.from({ length: n }, (_, i) => ({ ...base, functionName: 'projects' as const, args: [BigInt(i)] })),
        allowFailure: false,
      });
      const gave = account
        ? await pub.multicall({
            contracts: Array.from({ length: n }, (_, i) => ({ ...base, functionName: 'hasGiven' as const, args: [account, BigInt(i)] })),
            allowFailure: false,
          })
        : [];
      setProjects((rows as unknown as any[][]).map((p, i) => ({
        id: i, name: (p[8] as string) || `project ${i}`, payout: p[0] as `0x${string}`,
        gave: Boolean(gave[i]),
      })));
    })().catch(() => { /* the picker degrades to nothing; Results reports read failures */ });
  }, [account]);

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

  const statsStrip = (
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
  );

  return (
    <Shell
      brand="Lirih"
      tagline="confidential quadratic funding"
      chainLabel="Ethereum Sepolia"
      account={account}
      address={ADDRESSES.round}
      explorer={explorerAddr}
      stats={statsStrip}
      view={view}
      onView={setView}
      views={[
        { id: 'donate', label: 'Donate', disabled: open === false,
          hint: open === false ? 'this round is closed to new donations' : undefined },
        { id: 'results', label: 'Results' },
        { id: 'about', label: 'How it works' },
      ]}
    >
      {view === 'donate' && open === false && round && (
        <div className="note note-info" style={{ marginBottom: 'var(--s4)' }}>
          <strong>This round is closed to new donations</strong> — phase{' '}
          <strong>{PHASES[round.phase] ?? round.phase}</strong>
          {round.phase === 0 && `, deadline passed ${new Date(round.deadline * 1000).toLocaleString()}`}.
          Donating would revert. Open <b>Results</b> to read the allocations, check they add
          up against the on-chain pool, or push the round to settlement yourself.
        </div>
      )}

      {view === 'donate' && (
      <>
      <h2 style={{ marginBottom: 'var(--s3)' }}>Who are you funding?</h2>
      <p className="dim" style={{ fontSize: '0.95rem' }}>
        Quadratic funding is a contest between these projects for the pool above, and
        it counts <strong>donors</strong> rather than money — so choose one, then give.
        Four transactions get you a confidential balance and authorise the round; the
        fifth is the donation, and it is the only one nobody can read.
      </p>

      {/* The projects ARE the interface. A dropdown of ids made the choice
          abstract: you picked "1" and never saw who you were funding. */}
      <div className="projects">
        {projects.length === 0 && <p className="dim">reading the project list…</p>}
        {projects.map((p) => (
          <button
            key={p.id}
            className="project"
            aria-pressed={String(p.id) === projectId}
            onClick={() => setProjectId(String(p.id))}
          >
            <span>
              <span className="name">{p.name}</span>
              <span className="who"> · pays {p.payout.slice(0, 10)}…</span>
            </span>
            <span className="stat-mini">
              {p.gave ? 'SEALED' : '—'}
              <span>your gift</span>
            </span>
          </button>
        ))}
      </div>

      <div className="card">
        <div className="row">
          <label>Amount (mUSDC)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} size={10} aria-label="Amount in mUSDC" />
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

      </>
      )}

      {view === 'results' && <Results projectId={Number(projectId)} />}

      {view === 'about' && (
        <>
          <h2 style={{ marginBottom: 'var(--s3)' }}>How it works</h2>
          <div className="card">
            <h3>Your amount never becomes public</h3>
            <p className="dim" style={{ marginBottom: 0, fontSize: '0.92rem' }}>
              The gateway encrypts it inside its TEE and the transaction carries a 32-byte
              handle. The contract accumulates <span className="mono">Σ√cᵢ</span> and{' '}
              <span className="mono">Σcᵢ</span> per project under encryption, and only the
              final per-project allocation is ever decrypted — by a gateway-signed proof the
              contract verifies itself.
            </p>
          </div>
          <div className="card">
            <h3>Splitting a donation buys nothing</h3>
            <p className="dim" style={{ marginBottom: 0, fontSize: '0.92rem' }}>
              Quadratic funding weights a project by <span className="mono">(Σ√cᵢ)²</span> where
              i ranges over <strong>donors</strong>, not transactions. Rooting each transaction
              would let one donor split a gift across N of them and multiply their own weight by{' '}
              <span className="mono">√N</span>, with no extra addresses at all. Lirih roots each
              donor&apos;s running total instead, which is why a repeat donation costs a second
              encrypted square root — about 1.8× the gas of a first.
            </p>
          </div>
          <div className="card">
            <h3>Nobody has to be trusted to finish</h3>
            <p className="dim" style={{ marginBottom: 0, fontSize: '0.92rem' }}>
              After the deadline every remaining step is fully determined, so none of them is
              gated on an operator. If the organiser disappears, any donor can push the round
              through from the <b>Results</b> panel and release the funds.
            </p>
          </div>
          <div className="card">
            <h3><Lock /> Coercion resistance, and its condition</h3>
            <p className="dim" style={{ marginBottom: 0, fontSize: '0.92rem' }}>
              With the MetaMask Snap installed your viewing key is derived from your secret
              recovery phrase and never leaves the sandbox: you can read your own donation and
              cannot sign anything that proves it to a briber.{' '}
              <strong style={{ color: 'var(--fg)' }}>Without the Snap your EOA holds that role
              and can prove the amount</strong>, so the guarantee does not hold on that path.
              This page says which mode is active rather than choosing quietly.
            </p>
          </div>
        </>
      )}
    </Shell>
  );
}
