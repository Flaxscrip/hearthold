/**
 * The Signet's browser-driven approval gate.
 *
 * Instead of reading the PIN from the terminal (`PromptGate`), the `HttpGate` parks each disclosure
 * as a **pending approval**, pushes it to the Signet Approver app over SSE, and resolves only when a
 * human posts a decision. A correct-PIN approve yields a proof-of-human assertion; a deny (or a
 * timeout) yields null. A wrong PIN leaves the request pending so the human can retry.
 *
 * This is the same `ApprovalGate` seam the Sovereign handler already uses — the GUI simply replaces
 * the terminal as the place a fresh human says yes.
 */

import { randomUUID } from 'node:crypto';

import type { HumanPresenceAssertion } from '@hearthold/core';
import type { PendingApproval, ApprovalHistoryEntry } from '@hearthold/control-types';

import type { ApprovalGate, ApprovalContext } from './signet.js';

type Emit = (type: string, data: unknown) => void;

interface PendingEntry {
  approval: PendingApproval;
  resolve: (a: HumanPresenceAssertion | null) => void;
  timer: NodeJS.Timeout;
}

export class HttpGate implements ApprovalGate {
  /** Wired to the control server's `emit` after the server is created. */
  emit: Emit = () => {};

  private readonly pending = new Map<string, PendingEntry>();
  private readonly history: ApprovalHistoryEntry[] = [];

  constructor(
    private readonly expectedPin: string,
    /** Auto-deny after this long so a never-answered request can't wedge the serve loop. */
    private readonly timeoutMs = 300_000,
  ) {}

  approve(ctx: ApprovalContext): Promise<HumanPresenceAssertion | null> {
    const id = randomUUID();
    const approval: PendingApproval = {
      id,
      requester: ctx.requester,
      challengeDid: ctx.challengeDid,
      schema: ctx.schema,
      receivedAt: new Date().toISOString(),
    };
    return new Promise<HumanPresenceAssertion | null>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.record(id, ctx.requester, 'denied');
        this.emit('approval-timeout', { id });
        resolve(null);
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { approval, resolve, timer });
      this.emit('approval-pending', { approval });
    });
  }

  listPending(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.approval);
  }

  listHistory(): ApprovalHistoryEntry[] {
    return [...this.history].reverse().slice(0, 50);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Resolve a pending approval. Approve requires the correct PIN — a wrong PIN throws and leaves the
   * request pending (retryable). Deny always resolves (null). Unknown id throws.
   */
  decide(id: string, approve: boolean, pin?: string): { decision: 'approved' | 'denied' } {
    const entry = this.pending.get(id);
    if (!entry) throw new Error('no such pending approval (it may have timed out)');

    if (approve) {
      if (this.expectedPin.length === 0 || pin !== this.expectedPin) {
        throw new Error('incorrect PIN');
      }
      const assertion: HumanPresenceAssertion = {
        method: 'pin',
        level: 1,
        timestamp: new Date().toISOString(),
      };
      this.finish(id, entry, 'approved', 'pin', 1);
      entry.resolve(assertion);
      return { decision: 'approved' };
    }

    this.finish(id, entry, 'denied');
    entry.resolve(null);
    return { decision: 'denied' };
  }

  private finish(
    id: string,
    entry: PendingEntry,
    decision: 'approved' | 'denied',
    method?: string,
    level?: number,
  ): void {
    clearTimeout(entry.timer);
    this.pending.delete(id);
    this.record(id, entry.approval.requester, decision, method, level);
    this.emit(decision === 'approved' ? 'approval-approved' : 'approval-denied', { id, decision });
  }

  private record(
    id: string,
    requester: string,
    decision: 'approved' | 'denied',
    method?: string,
    level?: number,
  ): void {
    this.history.push({ id, requester, decision, method, level, at: new Date().toISOString() });
  }
}
