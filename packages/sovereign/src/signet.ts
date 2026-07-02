/**
 * The Signet — the first proof-of-human gate.
 *
 * Presenting a proof *is* the external disclosure, so the Sovereign must approve it. The Signet is
 * the seam where proof-of-human is checked: an `ApprovalGate` is shown what is about to be
 * disclosed and to whom, and returns a `HumanPresenceAssertion` only if a fresh human approves.
 *
 * This first cut ships a PIN method (assurance level 1). Stronger methods — biometric, camera
 * face-liveness — are additional providers behind the same interface (see docs/sovereign-signet.md),
 * and the gate is where the proof-of-human level scales with sensitivity.
 */

import type { HumanPresenceAssertion } from '@hearthold/core';

export interface ApprovalContext {
  /** The verifier the disclosure would go to. */
  requester: string;
  /** The challenge being answered (what is disclosed). */
  challengeDid: string;
  /** The requested schema, if the verifier named one — shown as disclosure context. */
  schema?: string;
}

export interface ApprovalGate {
  /** Approve a disclosure: return a human-presence assertion, or null to deny. */
  approve(ctx: ApprovalContext): Promise<HumanPresenceAssertion | null>;
}

const pinAssertion = (): HumanPresenceAssertion => ({
  method: 'pin',
  level: 1,
  timestamp: new Date().toISOString(),
});

/**
 * Non-interactive PIN gate — approves iff the supplied PIN matches the expected one. Used in tests
 * and headless flows (the human "entered" `supplied`).
 */
export class PinGate implements ApprovalGate {
  constructor(
    private readonly expected: string,
    private readonly supplied: string,
  ) {}

  async approve(_ctx: ApprovalContext): Promise<HumanPresenceAssertion | null> {
    if (this.expected.length > 0 && this.supplied === this.expected) return pinAssertion();
    return null;
  }
}

/** Always denies — a safe default when no Signet PIN is configured. */
export class DenyGate implements ApprovalGate {
  async approve(): Promise<HumanPresenceAssertion | null> {
    return null;
  }
}

/** Interactive gate — shows the request on the terminal and reads the Signet PIN from stdin. */
export class PromptGate implements ApprovalGate {
  constructor(private readonly expected: string) {}

  async approve(ctx: ApprovalContext): Promise<HumanPresenceAssertion | null> {
    process.stdout.write(
      `\n🔑 Signet — a disclosure needs your approval\n` +
        `   verifier:  ${ctx.requester.slice(0, 40)}…\n` +
        `   challenge: ${ctx.challengeDid.slice(0, 40)}…\n` +
        `   Enter Signet PIN to approve (blank to deny): `,
    );
    const pin = await readLine();
    if (pin.length > 0 && this.expected.length > 0 && pin === this.expected) {
      process.stdout.write('   ✓ approved.\n');
      return pinAssertion();
    }
    process.stdout.write('   ✗ denied.\n');
    return null;
  }
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', (d: Buffer) => {
      process.stdin.pause();
      resolve(d.toString().trim());
    });
  });
}
