/**
 * `witness control` — the Witness app's backing daemon.
 *
 * Runs the real Witness with a single receive loop that owns the mailbox, so there is no
 * receive contention:
 *   - **Submit** is fire-and-forget — the app POSTs an observation, the daemon seals it and sends a
 *     `WitnessSubmission` to the Warden, and the Warden's receipt arrives back through the *same*
 *     loop and is pushed to the app over SSE (the async, offline-capable witnessing model).
 *   - **Project** — an inbound proof-request is relayed to the Sovereign/Signet and the result is
 *     carried back to the verifier; the outcome is pushed to the app. Active only when a Sovereign
 *     DID is configured.
 */

import { randomUUID } from 'node:crypto';

import {
  ensureIdentity,
  sealForWarden,
  DidCommTransport,
  IDENTITY_NAME,
  PROTOCOL_VERSION,
  startControlServer,
  type HearthholdConfig,
  type KeymasterHandle,
  type HearthholdMessage,
  type WitnessSubmission,
  type SubmissionReceipt,
  type EvidenceRequest,
  type EvidenceResponse,
} from '@hearthold/core';
import {
  SENSITIVITY_NAMES,
  type SensitivityName,
  type WitnessStatus,
  type WitnessSnapshot,
  type ReceiptRecord,
  type ProjectionRecord,
  type ProofRecord,
  type SubmitRequest,
  type ProveRequest,
} from '@hearthold/control-types';

const bareDid = (s: string | undefined): string => String(s ?? '').split('#')[0] ?? '';
const sensName = (s: number): SensitivityName => SENSITIVITY_NAMES[s] ?? 'SEALED';

export async function runWitnessControl(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  port: number,
): Promise<void> {
  const id = await ensureIdentity(handle, config);
  const name = IDENTITY_NAME.witness;
  const transport = new DidCommTransport(handle, name, config.nodeUrl);
  await transport.ready();

  const receipts: ReceiptRecord[] = [];
  const projections: ProjectionRecord[] = [];
  const proofs: ProofRecord[] = [];
  type PendingReq =
    | { type: 'submit'; kind: string; at: string }
    | { type: 'prove'; claim: string; kind: string; at: string };
  const pending = new Map<string, PendingReq>();
  const sovereignDid = config.sovereignDid;

  const status = (): WitnessStatus => ({
    identity: { role: 'witness', name: id.name, did: id.did },
    nodeUrl: config.nodeUrl,
    wardenDid: config.wardenDid,
    sovereignDid,
    serving: true,
  });

  const snapshot = (): WitnessSnapshot => ({
    status: status(),
    receipts: [...receipts].reverse().slice(0, 50),
    projections: [...projections].reverse().slice(0, 50),
    proofs: [...proofs].reverse().slice(0, 50),
  });

  const server = startControlServer({
    port,
    routes: {
      'GET /api/status': () => ({ status: status() }),
      'GET /api/snapshot': () => snapshot(),
      'POST /api/submit': async ({ body }) => {
        const { kind, text } = (body ?? {}) as SubmitRequest;
        if (!kind || !text) throw new Error('kind and text are required');
        const wardenDid = config.wardenDid;
        if (!wardenDid) throw new Error('HEARTHOLD_WARDEN_DID is not set on the Witness daemon');
        const ciphertext = await sealForWarden(handle, wardenDid, JSON.stringify({ text }));
        const thid = randomUUID();
        const submittedAt = new Date().toISOString();
        const submission: WitnessSubmission = {
          type: 'hearthold/witness-submission',
          version: PROTOCOL_VERSION,
          kind: kind as never,
          observedAt: submittedAt,
          ciphertext,
        };
        pending.set(thid, { type: 'submit', kind, at: submittedAt });
        await handle.keymaster.sendDidComm({ type: submission.type, thid, body: submission }, wardenDid, {
          name,
        });
        // Provisional receipt; the loop emits the final 'stored' record (same id) when the Warden replies.
        const receipt: ReceiptRecord = { id: thid, kind, status: 'submitted', at: submittedAt };
        return { receipt };
      },
      'POST /api/prove': async ({ body }) => {
        const { claim, kind, from, to, structured, validForMinutes } = (body ?? {}) as ProveRequest;
        if (!claim || !kind) throw new Error('claim and kind are required');
        const wardenDid = config.wardenDid;
        if (!wardenDid) throw new Error('HEARTHOLD_WARDEN_DID is not set on the Witness daemon');
        const thid = randomUUID();
        const at = new Date().toISOString();
        const request: EvidenceRequest = {
          type: 'hearthold/evidence-request',
          version: PROTOCOL_VERSION,
          claim,
          disclosureMode: 'ATTESTATION',
          spec: { kind: kind as never, from, to, structured },
          ...(sovereignDid ? { subjectDid: sovereignDid } : {}),
          ...(validForMinutes ? { validForMinutes } : {}),
        };
        pending.set(thid, { type: 'prove', claim, kind, at });
        await handle.keymaster.sendDidComm({ type: request.type, thid, body: request }, wardenDid, { name });
        // Provisional; the loop emits the resolved record (same id) when the Warden replies. A sensitive
        // claim will not resolve until the Sovereign approves it in the Signet — this is intentional.
        const proof: ProofRecord = { id: thid, claim, kind, status: 'requesting', at };
        proofs.push(proof);
        return { proof };
      },
    },
    onListening: (p) =>
      process.stdout.write(
        `Witness control on http://127.0.0.1:${p}\n  did:  ${id.did}\n  node: ${config.nodeUrl}\n` +
          `  warden:    ${config.wardenDid ?? '(set HEARTHOLD_WARDEN_DID to submit)'}\n` +
          `  sovereign: ${sovereignDid ?? '(set HEARTHOLD_SOVEREIGN_DID to project)'}\n` +
          `  mailbox serving; app API live. (Ctrl-C to stop)\n`,
      ),
  });

  let running = true;
  const loop = async (): Promise<void> => {
    while (running) {
      let inbound: Awaited<ReturnType<typeof handle.keymaster.receiveDidComm>> = [];
      try {
        inbound = await handle.keymaster.receiveDidComm({ name });
      } catch {
        inbound = [];
      }

      for (const m of inbound) {
        const fromDid = bareDid(m.metadata?.sender);
        const wrapped = m.message as { thid?: string; body?: HearthholdMessage };
        const body = wrapped?.body;
        const thid = wrapped?.thid;
        if (!body?.type) continue;

        // Inbound proof-request → relay to the Signet (loop suspended while awaiting → sole drainer).
        if (body.type === 'hearthold/proof-request' && sovereignDid) {
          let reply: HearthholdMessage;
          try {
            reply = await transport.request(sovereignDid, body, { timeoutMs: 120_000 });
          } catch (err) {
            reply = {
              type: 'hearthold/error',
              version: PROTOCOL_VERSION,
              reason: `Witness could not reach the Sovereign: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          if (fromDid && thid) {
            await handle.keymaster
              .sendDidComm({ type: reply.type, thid, body: reply }, fromDid, { name })
              .catch(() => undefined);
          }
          const declined =
            reply.type === 'hearthold/error' &&
            /declin/i.test((reply as { reason?: string }).reason ?? '');
          const outcome: ProjectionRecord['outcome'] =
            reply.type === 'hearthold/proof-presentation' ? 'relayed' : declined ? 'declined' : 'error';
          const rec: ProjectionRecord = {
            id: thid ?? randomUUID(),
            requester: fromDid,
            outcome,
            humanProof:
              reply.type === 'hearthold/proof-presentation'
                ? Boolean((reply as { humanProof?: unknown }).humanProof)
                : undefined,
            at: new Date().toISOString(),
          };
          projections.push(rec);
          server.emit('projection', { projection: rec });
          continue;
        }

        // Warden's reply to one of our requests (a submission receipt, or a prove result).
        if (thid && pending.has(thid)) {
          const p = pending.get(thid);
          pending.delete(thid);

          if (p?.type === 'prove') {
            const now = new Date().toISOString();
            let rec: ProofRecord;
            if (body.type === 'hearthold/evidence-response') {
              const r = body as EvidenceResponse;
              rec =
                r.status === 'granted'
                  ? {
                      id: thid,
                      claim: p.claim,
                      kind: p.kind,
                      status: 'granted',
                      credentialDid: r.credentialDid,
                      structured: r.graph?.structured,
                      evidence: r.graph?.evidence,
                      approved: r.graph?.approved,
                      validUntil: r.graph?.validUntil,
                      issued: r.graph?.issued,
                      trustClass: r.graph?.trustClass,
                      at: now,
                    }
                  : { id: thid, claim: p.claim, kind: p.kind, status: 'denied', reason: r.reason, at: now };
            } else {
              rec = { id: thid, claim: p.claim, kind: p.kind, status: 'denied', reason: `unexpected reply ${body.type}`, at: now };
            }
            const idx = proofs.findIndex((x) => x.id === thid);
            if (idx >= 0) proofs[idx] = rec;
            else proofs.push(rec);
            server.emit('proof', { proof: rec });
            continue;
          }

          const kind = p?.kind ?? 'unknown';
          let rec: ReceiptRecord;
          if (body.type === 'hearthold/submission-receipt') {
            const r = body as SubmissionReceipt;
            rec = {
              id: thid,
              kind,
              status: 'stored',
              sensitivityName: sensName(r.assignedSensitivity),
              at: r.storedAt,
            };
          } else {
            rec = {
              id: thid,
              kind,
              status: `refused: ${(body as { reason?: string }).reason ?? body.type}`,
              at: new Date().toISOString(),
            };
          }
          receipts.push(rec);
          server.emit('receipt', { receipt: rec });
          continue;
        }
        // Anything else on our mailbox is ignored.
      }

      if (running) await new Promise((r) => setTimeout(r, 1500));
    }
  };
  void loop();

  const shutdown = (): void => {
    running = false;
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
