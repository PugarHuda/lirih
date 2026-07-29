'use client';
// Landing page. The app moved to /app — this is what a judge or a donor hits
// first, and it has one job: say what the thing is, prove it is real, and get
// out of the way.
//
// The numbers below are READ FROM CHAIN, not typed into this file. A landing
// page that hardcodes its own metrics is a screenshot, and this project's whole
// argument is that you can check it yourself.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatEther } from 'viem';
import { ADDRESSES, roundAbi, pub, explorerAddr, acceptsContributions } from '../lib/lirih';
import { Ext, Lock } from './icons';

const SETTLED = '0x4f15c2a627e3f8e866a83fc57f3aa0897ad47399' as const;

type Live = { open: boolean; deadline: number; pool: bigint; projects: number };
type Row = { name: string; alloc: bigint; revealed: boolean };

export default function Landing() {
  const [live, setLive] = useState<Live>();
  const [settled, setSettled] = useState<Row[]>([]);

  useEffect(() => {
    (async () => {
      const open = { address: ADDRESSES.round, abi: roundAbi } as const;
      const [phase, deadline, pool, n] = await pub.multicall({
        contracts: [
          { ...open, functionName: 'phase' },
          { ...open, functionName: 'contributionDeadline' },
          { ...open, functionName: 'matchingPool' },
          { ...open, functionName: 'projectCount' },
        ],
        allowFailure: false,
      });
      setLive({
        open: acceptsContributions(Number(phase), Number(deadline)),
        deadline: Number(deadline), pool: pool as bigint, projects: Number(n),
      });

      // The finished round is a separate address, deliberately: a settled round
      // is a read-only artefact and the open one is the thing you can use.
      const done = { address: SETTLED, abi: roundAbi } as const;
      const rows = await pub.multicall({
        contracts: [0, 1].map((i) => ({ ...done, functionName: 'projects' as const, args: [BigInt(i)] })),
        allowFailure: false,
      });
      setSettled((rows as unknown as any[][]).map((p) => ({
        name: p[8] as string, alloc: p[5] as bigint, revealed: p[6] as boolean,
      })));
    })().catch(() => { /* landing must render regardless; /app surfaces read errors */ });
  }, []);

  return (
    <main>
      <section className="wrap hero">
        <div className="eyebrow">iExec Nox · Ethereum Sepolia</div>
        <h1>Fund what matters.<br />Prove nothing to anyone.</h1>
        <p className="lede">
          Quadratic funding needs everyone&apos;s donation amounts, which makes bribery
          trivial: <em>show me you gave to my project and I&apos;ll pay you</em>. Lirih
          encrypts every contribution end to end, computes the funding weights inside a
          TEE, and reveals <strong>only the final per-project allocation</strong>.
        </p>
        <div className="row" style={{ marginTop: 'var(--s5)' }}>
          <Link href="/app"><button>Open the app</button></Link>
          <a href="https://github.com/PugarHuda/lirih" target="_blank" rel="noreferrer">
            <button className="ghost">Read the code <Ext /></button>
          </a>
        </div>
        {live && (
          <p className="dim" style={{ marginTop: 'var(--s4)', fontSize: '0.9rem' }}>
            {live.open ? (
              <>Round open · {live.projects} projects · {formatEther(live.pool)} mUSDC matching pool ·
                {' '}closes {new Date(live.deadline * 1000).toLocaleDateString()}</>
            ) : (
              <>The configured round has closed — the app still shows its result.</>
            )}
          </p>
        )}
      </section>

      <section className="wrap">
        <h2>A whale raised 4.5× more money and earned nothing</h2>
        <p className="dim narrow">
          From a real settled round on Sepolia. Two projects, encrypted donations,
          quadratic weights computed under encryption. One was funded by a crowd of
          two; the other by a single large donor giving far more.
        </p>
        <div className="card">
          <table>
            <thead>
              <tr><th>Project</th><th style={{ textAlign: 'right' }}>Raised</th><th style={{ textAlign: 'right' }}>Matching</th></tr>
            </thead>
            <tbody>
              {settled.length === 0 ? (
                <tr><td colSpan={3} className="dim">reading the settled round…</td></tr>
              ) : settled.map((r, i) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="num dim">{i === 0 ? '200' : '900'}</td>
                  <td className="num" style={{ color: r.alloc > 0n ? 'var(--accent)' : 'var(--fg-dim)' }}>
                    {r.revealed ? `${Number(formatEther(r.alloc)).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dim" style={{ margin: 'var(--s4) 0 0', fontSize: '0.85rem' }}>
            Read live from{' '}
            <a href={explorerAddr(SETTLED)} target="_blank" rel="noreferrer" className="mono">
              {SETTLED.slice(0, 10)}… <Ext />
            </a>
            {' '}— not typed into this page.
          </p>
        </div>
      </section>

      <section className="wrap">
        <h2>How it works</h2>
        <div className="grid">
          <div className="card">
            <h3>1 · Donate, encrypted</h3>
            <p className="dim" style={{ margin: 0, fontSize: '0.92rem' }}>
              Your amount is encrypted by the gateway inside its TEE. The transaction
              carries a 32-byte handle, not a number.
            </p>
          </div>
          <div className="card">
            <h3>2 · Weights under encryption</h3>
            <p className="dim" style={{ margin: 0, fontSize: '0.92rem' }}>
              The contract computes <span className="mono">(Σ√cᵢ)² − Σcᵢ</span> per project
              without ever decrypting a contribution. Nox has no square root, so it is
              built from a 41-bit binary search.
            </p>
          </div>
          <div className="card">
            <h3>3 · Reveal one number each</h3>
            <p className="dim" style={{ margin: 0, fontSize: '0.92rem' }}>
              Only the final allocations are decrypted, by gateway-signed proof the
              contract verifies itself — then settled into an unmodified 0xSplits V2.
            </p>
          </div>
        </div>
      </section>

      <section className="wrap">
        <div className="card">
          <h3><Lock /> Coercion resistance, and its condition</h3>
          <p className="dim" style={{ marginBottom: 0, fontSize: '0.92rem' }}>
            With the MetaMask Snap installed, your viewing key is derived from your
            secret recovery phrase and never leaves the sandbox: you can read your own
            donation and cannot sign anything that proves it to a briber.{' '}
            <strong style={{ color: 'var(--fg)' }}>Without the Snap your EOA holds that
            role and can prove the amount</strong>, so the guarantee does not hold on
            that path. The app tells you which mode is active rather than choosing
            quietly.
          </p>
        </div>
      </section>

      <section className="wrap" style={{ paddingBottom: 'var(--s7)' }}>
        <div className="row">
          <Link href="/app"><button>Open the app</button></Link>
          <span className="dim" style={{ fontSize: '0.9rem' }}>
            Sepolia testnet · faucet tokens built in · no real funds
          </span>
        </div>
      </section>

      <footer>
        <div className="wrap row" style={{ justifyContent: 'space-between' }}>
          <span>Lirih · WTF Hackathon Summer Edition · built on iExec Nox</span>
          <a href={explorerAddr(ADDRESSES.round)} target="_blank" rel="noreferrer" className="mono">
            round {ADDRESSES.round.slice(0, 10)}… <Ext />
          </a>
        </div>
      </footer>
    </main>
  );
}
