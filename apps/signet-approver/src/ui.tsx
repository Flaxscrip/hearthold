import { useState } from 'react';
import type { ReactNode } from 'react';

export function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {right}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Pill({ tone, children }: { tone: 'live' | 'off' | 'warn'; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

/** A DID, truncated in the middle; click or double-click to copy the full value. */
export function DidTag({ did, label }: { did: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const short = did.length > 24 ? `${did.slice(0, 14)}…${did.slice(-6)}` : did;
  const copy = () => {
    void navigator.clipboard?.writeText(did);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <code
      className={`did${copied ? ' copied' : ''}`}
      title={`${did}\n(click or double-click to copy the full DID)`}
      onClick={copy}
      onDoubleClick={copy}
    >
      {copied ? 'copied ✓' : (
        <>
          {label ? `${label} ` : ''}
          {short}
        </>
      )}
    </code>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
