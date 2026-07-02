import { useState } from 'react';
import type { ReactNode } from 'react';
import type { SensitivityName } from '@hearthold/control-types';

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

const SENS_TONE: Record<SensitivityName, string> = {
  PUBLIC: 'sens-public',
  LOW: 'sens-low',
  MEDIUM: 'sens-medium',
  HIGH: 'sens-high',
  SEALED: 'sens-sealed',
};

export function SensitivityChip({ name }: { name: SensitivityName }) {
  return <span className={`chip ${SENS_TONE[name]}`}>{name}</span>;
}

export function DidTag({ did }: { did: string }) {
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
      {copied ? 'copied ✓' : short}
    </code>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
