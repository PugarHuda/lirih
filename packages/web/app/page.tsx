'use client';
// Minimal Lirih flow on injected MetaMask (viem, no wagmi sprawl). Demo-grade:
// faucet -> wrap -> authorize round -> confidential donate. Results/reveal are
// driven by the operator script; this page proves the donor path end-to-end.
import { useState } from 'react';
import { parseEther } from 'viem';
import { sepolia } from 'viem/chains';
import { encryptDonation } from '../lib/nox';
import { ADDRESSES, roundAbi, cusdcAbi, musdcAbi, tx, explorerTx, connectWallet } from '../lib/lirih';
import { connectSnap, getNoxAddress } from '../lib/snap';
import Results from './Results';

/// Which key was granted the viewer role — decides whether the coercion-resistance
/// claim actually holds for this donation. Never inferred silently; see donate().
type ViewerMode = 'snap' | 'eoa';

export default function Home() {
  const [account, setAccount] = useState<`0x${string}`>();
  const [amount, setAmount] = useState('100');
  const [projectId, setProjectId] = useState('0');
  const [status, setStatus] = useState('');
  const [viewerMode, setViewerMode] = useState<ViewerMode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hashes, setHashes] = useState<{ label: string; hash: `0x${string}` }[]>([]);

  /// Every button goes through here: one place that disables input while a
  /// multi-transaction flow is mid-flight, and one place that SHOWS failures.
  /// Without it a throw (wrong network, user rejection, revert) disappeared into
  /// an unhandled promise rejection and the page just sat there.
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      setError(/User rejected|denied/i.test(msg) ? 'Cancelled in wallet.' : msg.split('\n')[0]);
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  const track = (label: string) => (hash: `0x${string}`) =>
    setHashes((h) => [...h, { label, hash }]);

  /// Shared with the round-advancing panel — the Sepolia guard lives in
  /// lib/lirih.ts so there is exactly one copy of it.
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
    setStatus('2/4 approving wrapper…');
    await tx(w, { address: ADDRESSES.musdc, abi: musdcAbi, functionName: 'approve', args: [ADDRESSES.cusdc, amt], chain: sepolia, account: me }, track('approve'));
    setStatus('3/4 wrapping to cUSDC (this amount IS public — only what you do next is private)…');
    await tx(w, { address: ADDRESSES.cusdc, abi: cusdcAbi, functionName: 'wrap', args: [me, amt], chain: sepolia, account: me }, track('wrap'));
    setStatus('4/4 authorizing round as operator…');
    const until = Math.floor(Date.now() / 1000) + 3600;
    await tx(w, { address: ADDRESSES.cusdc, abi: cusdcAbi, functionName: 'setOperator', args: [ADDRESSES.round, until], chain: sepolia, account: me }, track('setOperator'));
    setStatus('ready to donate');
  }

  async function donate() {
    const w = await wallet();
    // Encrypt with the EOA (satisfies fromExternal: encrypting wallet == tx
    // sender). The VIEWER is what decides whether coercion resistance actually
    // holds, so it is never chosen silently:
    //   Snap identity -> key lives in the SES sandbox and cannot sign for a
    //     briber, so the donor can read their own amount and prove nothing.
    //   EOA fallback  -> the donor CAN sign to prove their amount to a briber.
    //     Still private on-chain, but NOT coercion resistant. Surfaced in the UI.
    let viewer = w.account!.address as `0x${string}`;
    let mode: ViewerMode = 'eoa';
    try {
      await connectSnap();
      viewer = (await getNoxAddress()).address;
      mode = 'snap';
    } catch { /* snap unavailable — fall back, but say so */ }
    setViewerMode(mode);

    setStatus('encrypting amount inside the Nox gateway TEE…');
    const { handle, handleProof } = await encryptDonation(w, parseEther(amount), ADDRESSES.round);
    setStatus('submitting confidential contribution (calldata carries a 32-byte handle, not your amount)…');
    await tx(w, {
      address: ADDRESSES.round, abi: roundAbi, functionName: 'contribute',
      args: [BigInt(projectId), handle as `0x${string}`, handleProof, viewer],
      chain: sepolia, account: w.account!.address,
    }, track('contribute'));
    setStatus('done — your amount is encrypted on-chain (calldata is a 32-byte handle)');
  }

  return (
    <main style={{ maxWidth: 560, margin: '4rem auto', fontFamily: 'system-ui' }}>
      <h1>Lirih — confidential quadratic funding</h1>
      <p>Your donation amount stays encrypted end-to-end. Only the final per-project allocation is ever revealed.</p>
      <p><b>Account:</b> {account ?? 'not connected'}</p>
      <label>Amount (mUSDC): <input value={amount} onChange={(e) => setAmount(e.target.value)} /></label><br />
      <label>Project id: <input value={projectId} onChange={(e) => setProjectId(e.target.value)} /></label>
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button disabled={busy} onClick={() => run(faucetAndWrap)}>
          1 · Faucet + wrap + authorize
        </button>
        <button disabled={busy} onClick={() => run(donate)}>
          2 · Donate (encrypted)
        </button>
      </div>
      {status && (
        <p style={{ marginTop: 16, color: '#555' }}>
          {busy && <span aria-hidden> ⏳ </span>}{status}
        </p>
      )}
      {error && (
        <p role="alert" style={{
          marginTop: 12, padding: '8px 12px', borderRadius: 6, fontSize: 14,
          background: '#fdecea', border: '1px solid #f5aca6',
        }}>{error}</p>
      )}
      {hashes.length > 0 && (
        <ul style={{ marginTop: 12, fontSize: 13, paddingLeft: 18 }}>
          {hashes.map(({ label, hash }) => (
            <li key={hash}>
              {label}:{' '}
              <a href={explorerTx(hash)} target="_blank" rel="noreferrer">
                {hash.slice(0, 10)}…
              </a>
            </li>
          ))}
        </ul>
      )}
      {viewerMode && (
        <p style={{
          marginTop: 8, padding: '8px 12px', borderRadius: 6, fontSize: 14,
          background: viewerMode === 'snap' ? '#e7f6ec' : '#fff4e5',
          border: `1px solid ${viewerMode === 'snap' ? '#a3d9b1' : '#f0c987'}`,
        }}>
          {viewerMode === 'snap'
            ? '🔒 Coercion-resistant: your viewing key lives inside the MetaMask Snap sandbox. You can read your own donation; you cannot prove it to anyone else.'
            : '⚠️ Snap not installed — your EOA was granted the viewing role. Your amount is still encrypted on-chain, but you CAN sign to prove it to a third party, so this donation is not coercion-resistant. Install the Snap for the full guarantee.'}
        </p>
      )}
      <Results projectId={Number(projectId)} />
    </main>
  );
}
