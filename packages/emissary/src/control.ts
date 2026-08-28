/**
 * `emissary control` — the Emissary app's backing daemon.
 *
 * Runs the real Emissary with a single receive loop that owns the mailbox, so there is no
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
  presentProof,
  DidCommTransport,
  IDENTITY_NAME,
  PROTOCOL_VERSION,
  startControlServer,
  revokeStatusIndex,
  Sensitivity,
  type HearthholdConfig,
  type KeymasterHandle,
  type HearthholdMessage,
  type WitnessSubmission,
  type SubmissionReceipt,
  type ChallengeResponseMessage,
  type ChainGrantMessage,
  type WitnessKind,
  type EvidenceResponse,
} from '@hearthold/core';
import {
  SENSITIVITY_NAMES,
  type SensitivityName,
  type EmissaryStatus,
  type EmissarySnapshot,
  type ReceiptRecord,
  type ProjectionRecord,
  type ProofRecord,
  type SubmitRequest,
  type InvokeRequest,
  type InvokeResponse,
  type AcceptCapabilityRequest,
  type AcceptCapabilityResponse,
  type DelegateCapabilityRequest,
  type DelegateCapabilityResponse,
  type ChainInvokeRequest,
  type RevokeHopRequest,
  type RevokeHopResponse,
  type HeldResponse,
} from '@hearthold/control-types';
import { invokeEvidence } from './invoke.js';
import { HeldChainStore, delegateHeldOnward, chainInvokeEvidence, transferChainGrant, reportHopRegistered, reportHopRevoked, reportFlow } from './chain.js';

const bareDid = (s: string | undefined): string => String(s ?? '').split('#')[0] ?? '';
const sensName = (s: number): SensitivityName => SENSITIVITY_NAMES[s] ?? 'SEALED';

export async function runEmissaryControl(
  handle: KeymasterHandle,
  config: HearthholdConfig,
  port: number,
): Promise<void> {
  const id = await ensureIdentity(handle, config);
  const name = IDENTITY_NAME.emissary;
  const transport = new DidCommTransport(handle, name, config.nodeUrl);
  await transport.ready();

  const receipts: ReceiptRecord[] = [];
  const projections: ProjectionRecord[] = [];
  const proofs: ProofRecord[] = [];
  type PendingReq = { type: 'submit'; kind: string; at: string };
  const pending = new Map<string, PendingReq>();
  const sovereignDid = config.sovereignDid;

  // Invoke-shim queue (Sevenfold's ask): a keyless browser POSTs an INTENT; the daemon runs the full
  // invocation ceremony with its OWN wallet + scope capability. The two request/reply legs must run on the
  // SOLE mailbox drainer (the receive loop) to avoid contention, so the route enqueues and the loop resolves.
  type PendingInvoke = { spec: InvokeRequest; resolve: (r: InvokeResponse) => void };
  const invokeQueue: PendingInvoke[] = [];

  // MULTI-HOP (Phase 5B, item 1): chain-capabilities this Emissary HOLDS + hops it has ISSUED (for revocation).
  // Inbound `hearthold/chain-grant` messages (a Sovereign seeding a root, or a delegator handing a child) land
  // here via the loop. A `chain-invoke` presents a held chain; like the invoke-shim it runs the two request/
  // reply legs on the sole mailbox drainer, so the route enqueues and the loop resolves.
  const held = new HeldChainStore(handle.dataFolder);
  type PendingChainInvoke = { leafVcDid?: string; claim: string; kind: string; reveal?: number[]; resolve: (r: InvokeResponse) => void };
  const chainInvokeQueue: PendingChainInvoke[] = [];

  // Authority-mutating writes (delegate a slice of family authority onward / revoke a hop) are CO-SIGNED by the
  // governing Sovereign BEFORE they run — the structural gate that keeps the keyless routes from being an
  // unauthenticated grab of family authority (audit-5). The co-sign is a request/reply on the sole mailbox
  // drainer, so the route enqueues and the loop performs on approval (AgentGate auto-approves in-scope; human PINs).
  type PendingWrite =
    | { kind: 'delegate'; req: DelegateCapabilityRequest; resolve: (r: DelegateCapabilityResponse) => void; reject: (e: Error) => void }
    | { kind: 'revoke-hop'; childVcDid: string; resolve: (r: RevokeHopResponse) => void; reject: (e: Error) => void };
  const writeQueue: PendingWrite[] = [];

  // The Warden-minted delegation challenge the daemon answers to authorize each submission (audit-3 §1/§5).
  // Reusable within the Warden's TTL, so we fetch it through the loop (the sole mailbox drainer — no receive
  // contention) and cache it; the submit route only answers it with `createResponse`. The Warden also hands
  // back the delegation VC(s) to accept, so the daemon self-provisions its grant here.
  let delegationChallenge: string | undefined;
  let challengeExp = 0;
  const refreshDelegationChallenge = async (): Promise<void> => {
    const wardenDid = config.wardenDid;
    if (!wardenDid) return;
    const reply = await transport.request(
      wardenDid,
      { type: 'hearthold/challenge-request', version: PROTOCOL_VERSION, purpose: 'delegation' },
      { timeoutMs: 30_000 },
    );
    if (reply.type !== 'hearthold/challenge-response') return;
    for (const cid of (reply as ChallengeResponseMessage).acceptCredentials ?? []) {
      await handle.keymaster.acceptCredential(cid).catch(() => undefined); // idempotent; accept our own grant
    }
    delegationChallenge = (reply as ChallengeResponseMessage).challenge;
    challengeExp = Date.now() + 9 * 60_000; // refresh a minute before the Warden's 10-min TTL
  };

  const status = (): EmissaryStatus => ({
    identity: { role: 'emissary', name: id.name, did: id.did },
    nodeUrl: config.nodeUrl,
    wardenDid: config.wardenDid,
    sovereignDid,
    serving: true,
  });

  const snapshot = (): EmissarySnapshot => ({
    status: status(),
    receipts: [...receipts].reverse().slice(0, 50),
    projections: [...projections].reverse().slice(0, 50),
    proofs: [...proofs].reverse().slice(0, 50),
  });

  const server = startControlServer({
    port,
    host: config.controlHost,
    allowOrigins: config.controlAllowOrigins,
    routes: {
      'GET /api/status': () => ({ status: status() }),
      'GET /api/snapshot': () => snapshot(),
      'POST /api/submit': async ({ body }) => {
        const { kind, text, attachment } = (body ?? {}) as SubmitRequest;
        if (!kind) throw new Error('kind is required');
        const wardenDid = config.wardenDid;
        if (!wardenDid) throw new Error('HEARTHOLD_WARDEN_DID is not set on the Emissary daemon');
        // Two payload shapes, one reliable path (this daemon owns the mailbox, so no receive contention —
        // unlike the racy `submit-image` CLI). A binary attachment becomes a NATIVE Archon image asset:
        // the bytes go to the node's content-addressed IPFS (born on contentRegistry = local by construction),
        // and only the tiny asset-DID REFERENCE is sealed to the Warden — never base64 in DIDComm. The Warden
        // get-image's it and captions on-device. Kind-enforcement still applies at the Warden, so only an
        // image-delegated Emissary (e.g. :4313 `--kinds image`) actually lands an image.
        let payload: string;
        if (attachment) {
          if (!attachment.mediaType || !attachment.bytesB64) throw new Error('attachment requires mediaType and bytesB64');
          const bytes = Buffer.from(attachment.bytesB64, 'base64');
          const MAX_BYTES = 8 * 1024 * 1024;
          if (bytes.length === 0) throw new Error('attachment bytes are empty (bad base64?)');
          if (bytes.length > MAX_BYTES) throw new Error(`attachment too large (${bytes.length} bytes > ${MAX_BYTES}); cap is 8 MB`);
          const assetDid = await handle.keymaster.createImage(bytes, { registry: config.contentRegistry });
          payload = JSON.stringify({ assetDid, mediaType: attachment.mediaType });
        } else {
          if (!text) throw new Error('text is required for a non-attachment submission');
          payload = JSON.stringify({ text });
        }
        const ciphertext = await sealForWarden(handle, wardenDid, payload);
        // Present our delegation: answer the Warden's cached challenge. `createResponse` is a node op (no
        // mailbox), so it's safe from this route; the challenge is kept fresh by the loop.
        if (!delegationChallenge) {
          throw new Error(
            'not authorized to submit yet — no Warden-issued delegation is available. Delegate this Emissary (warden delegate <did>) and retry once the daemon has fetched its challenge.',
          );
        }
        const delegationProof = await presentProof(handle, delegationChallenge);
        const thid = randomUUID();
        const submittedAt = new Date().toISOString();
        const submission: WitnessSubmission = {
          type: 'hearthold/witness-submission',
          version: PROTOCOL_VERSION,
          kind: kind as never,
          observedAt: submittedAt,
          ciphertext,
          delegationProof,
        };
        pending.set(thid, { type: 'submit', kind, at: submittedAt });
        await handle.keymaster.sendDidComm({ type: submission.type, thid, body: submission }, wardenDid, {
          name,
        });
        // Provisional receipt; the loop emits the final 'stored' record (same id) when the Warden replies.
        const receipt: ReceiptRecord = { id: thid, kind, status: 'submitted', at: submittedAt };
        return { receipt };
      },

      // The keyless invoke-shim: a browser POSTs an intent; the daemon presents its scope capability and
      // invokes. BLOCKS while the Warden gets the owner's consent for a sensitive claim — the app shows a
      // "waiting for approval at your Signet" state, then receives granted | denied verbatim (§ Sevenfold).
      'POST /api/invoke': async ({ body }): Promise<InvokeResponse> => {
        const req = (body ?? {}) as InvokeRequest;
        if (!req.claim || !req.kind) throw new Error('claim and kind are required');
        if (!config.wardenDid) throw new Error('HEARTHOLD_WARDEN_DID is not set on the Emissary daemon');
        return new Promise<InvokeResponse>((resolve) => invokeQueue.push({ spec: req, resolve }));
      },

      // Accept a Sovereign-granted scope capability into the Emissary's wallet, so it can be presented on
      // invoke. The credential DID comes from the Sovereign's `/api/authorize-capability` grant.
      'POST /api/accept-capability': async ({ body }): Promise<AcceptCapabilityResponse> => {
        const { credentialDid } = (body ?? {}) as AcceptCapabilityRequest;
        if (!credentialDid) throw new Error('credentialDid is required');
        const accepted = await handle.keymaster.acceptCredential(credentialDid).catch(() => false);
        return { accepted: !!accepted };
      },

      // MULTI-HOP: what this Emissary holds + what it has issued onward (for a lineage view / revoke UI).
      'GET /api/held': async (): Promise<HeldResponse> => ({
        held: (await held.list()).map((g) => ({
          leafVcDid: g.handle.issued.vcDid,
          counter: g.handle.issued.counter,
          target: g.handle.capability.invocationTarget,
          ceiling: g.handle.capability.caveats.ceiling,
        })),
        issued: await held.listIssued(),
      }),

      // Delegate an attenuated child of a HELD capability ONWARD to another agent, and transfer it over DIDComm.
      // The child is minted with a fresh revocation status from THIS Emissary's list — revoking it (POST
      // /api/revoke-hop) kills the delegate's subtree. Keyless: the Table/agent-MCP POSTs the intent.
      'POST /api/delegate-capability': async ({ body }): Promise<DelegateCapabilityResponse> => {
        const req = (body ?? {}) as DelegateCapabilityRequest;
        if (!req.holderDid) throw new Error('holderDid is required');
        // Co-signed by the governing Sovereign before it runs (loop-queued — see the drain below).
        return new Promise<DelegateCapabilityResponse>((resolve, reject) => writeQueue.push({ kind: 'delegate', req, resolve, reject }));
      },

      // Present a HELD chain to the Warden and get evidence (the multi-hop analog of /api/invoke). Loop-queued.
      'POST /api/chain-invoke': async ({ body }): Promise<InvokeResponse> => {
        const req = (body ?? {}) as ChainInvokeRequest;
        if (!req.claim || !req.kind) throw new Error('claim and kind are required');
        if (!config.wardenDid) throw new Error('HEARTHOLD_WARDEN_DID is not set on the Emissary daemon');
        return new Promise<InvokeResponse>((resolve) =>
          chainInvokeQueue.push({ ...(req.leafVcDid ? { leafVcDid: req.leafVcDid } : {}), claim: req.claim, kind: req.kind, ...(req.reveal ? { reveal: req.reveal } : {}), resolve }),
        );
      },

      // Revoke a hop THIS Emissary issued onward (its kill-switch over a child) — flips the status bit; the
      // Warden's per-hop check denies the delegate's chain at the next invocation.
      'POST /api/revoke-hop': async ({ body }): Promise<RevokeHopResponse> => {
        const { childVcDid } = (body ?? {}) as RevokeHopRequest;
        if (!childVcDid) throw new Error('childVcDid is required');
        // Co-signed by the governing Sovereign before it runs (loop-queued — see the drain below).
        return new Promise<RevokeHopResponse>((resolve, reject) => writeQueue.push({ kind: 'revoke-hop', childVcDid, resolve, reject }));
      },
    },
    onListening: (p) =>
      process.stdout.write(
        `Emissary control on http://127.0.0.1:${p}\n  did:  ${id.did}\n  node: ${config.nodeUrl}\n` +
          `  warden:    ${config.wardenDid ?? '(set HEARTHOLD_WARDEN_DID to submit)'}\n` +
          `  sovereign: ${sovereignDid ?? '(set HEARTHOLD_SOVEREIGN_DID to project)'}\n` +
          `  mailbox serving; app API live. (Ctrl-C to stop)\n`,
      ),
  });

  let running = true;
  const loop = async (): Promise<void> => {
    while (running) {
      // Keep the delegation challenge fresh from inside the loop (sole mailbox drainer → no receive contention).
      if (config.wardenDid && Date.now() > challengeExp - 60_000) {
        await refreshDelegationChallenge().catch(() => undefined);
      }
      // Drain queued invocations HERE — the ceremony's two request/reply legs run on the sole drainer, so
      // they don't race the loop's own receive. The POST route awaits the promise we resolve.
      while (running && invokeQueue.length > 0) {
        const job = invokeQueue.shift();
        if (!job) break;
        const reply = await invokeEvidence(handle, transport, config.wardenDid ?? '', {
          claim: job.spec.claim,
          kind: job.spec.kind,
          ...(job.spec.target ? { target: job.spec.target } : {}),
          ...(job.spec.reveal ? { reveal: job.spec.reveal } : {}),
        }).catch((e: unknown) => ({ type: 'hearthold/error' as const, version: PROTOCOL_VERSION, reason: e instanceof Error ? e.message : String(e) }));
        if (reply.type === 'hearthold/evidence-response' && reply.status === 'granted') {
          job.resolve({ status: 'granted', credentialDid: reply.credentialDid, schemaDid: reply.schemaDid, ...(reply.graph ? { graph: reply.graph } : {}) });
        } else {
          job.resolve({ status: 'denied', reason: reply.type === 'hearthold/error' ? reply.reason : reply.reason ?? 'denied' });
        }
        // Watch: report the disclosure flow to the governing Sovereign (envelope + authority + outcome, no content).
        if (sovereignDid) {
          const decision = reply.type === 'hearthold/evidence-response' && reply.status === 'granted' ? 'granted' : 'denied';
          await reportFlow(handle, id.name, sovereignDid, { from: id.did, to: config.wardenDid ?? '', kind: 'invocation', witnessKind: job.spec.kind, decision }).catch(() => undefined);
        }
      }
      // Drain queued CHAIN invocations on the sole drainer (challenge-request + invocation legs), same as invoke.
      while (running && chainInvokeQueue.length > 0) {
        const job = chainInvokeQueue.shift();
        if (!job) break;
        const grant = job.leafVcDid ? await held.get(job.leafVcDid) : await held.latest();
        if (!grant) {
          job.resolve({ status: 'denied', reason: 'this Emissary holds no chain capability to present' });
          continue;
        }
        const reply = await chainInvokeEvidence(handle, id.name, transport, config.wardenDid ?? '', grant, {
          claim: job.claim,
          kind: job.kind,
          ...(job.reveal ? { reveal: job.reveal } : {}),
        }).catch((e: unknown): EvidenceResponse | { type: 'hearthold/error'; version: typeof PROTOCOL_VERSION; reason: string } => ({ type: 'hearthold/error', version: PROTOCOL_VERSION, reason: e instanceof Error ? e.message : String(e) }));
        if (reply.type === 'hearthold/evidence-response' && reply.status === 'granted') {
          job.resolve({ status: 'granted', credentialDid: reply.credentialDid, schemaDid: reply.schemaDid, ...(reply.graph ? { graph: reply.graph } : {}) });
        } else {
          job.resolve({ status: 'denied', reason: reply.type === 'hearthold/error' ? reply.reason : reply.reason ?? 'denied' });
        }
        // Watch: report the chain disclosure flow to the Sovereign — under WHICH capability (the leaf) it acted.
        if (sovereignDid) {
          const decision = reply.type === 'hearthold/evidence-response' && reply.status === 'granted' ? 'granted' : 'denied';
          await reportFlow(handle, id.name, sovereignDid, { from: id.did, to: config.wardenDid ?? '', kind: 'chain-invocation', governingCapabilityDid: grant.handle.issued.vcDid, witnessKind: job.kind, decision }).catch(() => undefined);
        }
      }
      // Drain authority-mutating writes: co-sign with the governing Sovereign, then perform on approval.
      while (running && writeQueue.length > 0) {
        const job = writeQueue.shift();
        if (!job) break;
        if (!sovereignDid) {
          job.reject(new Error('no governing Sovereign configured (HEARTHOLD_SOVEREIGN_DID) to authorize this act'));
          continue;
        }
        const action =
          job.kind === 'delegate'
            ? { action: 'delegate-capability', resource: job.req.holderDid ?? '', summary: `Delegate an attenuated slice of family authority to ${job.req.holderDid}` }
            : { action: 'revoke-hop', resource: job.childVcDid, summary: `Revoke a hop this Emissary delegated (${job.childVcDid.slice(0, 24)}…)` };
        let approved = false;
        try {
          const rep = await transport.request(sovereignDid, { type: 'hearthold/action-approval-request', version: PROTOCOL_VERSION, action }, { timeoutMs: 310_000 });
          approved = rep.type === 'hearthold/action-approval-response' && rep.approved;
        } catch {
          approved = false;
        }
        if (!approved) {
          job.reject(new Error('declined by the governing Sovereign'));
          continue;
        }
        try {
          if (job.kind === 'delegate') {
            const { grant, issued } = await delegateHeldOnward({
              issuer: handle,
              issuerName: id.name,
              config,
              held,
              holderDid: job.req.holderDid,
              ...(job.req.ceiling !== undefined ? { ceiling: job.req.ceiling as Sensitivity } : {}),
              ...(job.req.kinds ? { kinds: job.req.kinds as WitnessKind[] } : {}),
              ...(job.req.target ? { target: job.req.target } : {}),
              ...(job.req.leafVcDid ? { leafVcDid: job.req.leafVcDid } : {}),
            });
            await held.putIssued(issued);
            await transferChainGrant(handle, id.name, job.req.holderDid, grant);
            await reportHopRegistered(handle, id.name, sovereignDid, { childVcDid: issued.childVcDid, parentVcDid: grant.handle.capability.parentCapability ?? '', holder: job.req.holderDid, counter: grant.handle.issued.counter }).catch(() => undefined);
            server.emit('delegated', { childVcDid: issued.childVcDid, holder: job.req.holderDid });
            job.resolve({ childVcDid: issued.childVcDid, holder: job.req.holderDid, statusListIndex: issued.statusListIndex });
          } else {
            const hop = await held.getIssued(job.childVcDid);
            if (!hop) {
              job.reject(new Error('no issued hop with that childVcDid — this Emissary did not delegate it'));
              continue;
            }
            await revokeStatusIndex(handle, id.name, hop.statusListCredential, hop.statusListIndex);
            await reportHopRevoked(handle, id.name, sovereignDid, job.childVcDid).catch(() => undefined);
            job.resolve({ revoked: true, childVcDid: job.childVcDid });
          }
        } catch (e) {
          job.reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
      // DURABLE DRAIN (@didcid 0.6.3): read NON-destructively and ack only AFTER the durable handling
      // completes — the same at-least-once upgrade the core transport uses (packages/core/src/transport.ts,
      // scripts/e2e-durable-drain.ts). The one piece of durable state on this reader is an inbound chain-grant
      // (`held.put`); every message is acked once handled EXCEPT a chain-grant whose put failed — that is left
      // on the relay for redelivery (held.put is idempotent by vcDid, so a redelivered grant is harmless).
      let inbound: Awaited<ReturnType<typeof handle.keymaster.receiveDidComm>> = [];
      try {
        inbound = await handle.keymaster.receiveDidComm({ name, ack: false });
      } catch {
        inbound = [];
      }

      const doneNow: string[] = [];
      for (const m of inbound) {
        const id = (m as { id?: string }).id;
        const fromDid = bareDid(m.metadata?.sender);
        const wrapped = m.message as { thid?: string; body?: HearthholdMessage };
        const body = wrapped?.body;
        const thid = wrapped?.thid;
        if (!body?.type) {
          if (id) doneNow.push(id); // poison — ack-drop so it doesn't redeliver forever
          continue;
        }

        // Inbound chain grant: a Sovereign seeding a ROOT, or a delegator handing us a child hop. Persist it so
        // we can invoke (and further-delegate) it. authcrypt already authenticated the sender at the transport.
        if (body.type === 'hearthold/chain-grant') {
          const grant = (body as ChainGrantMessage).grant;
          if (grant?.handle?.issued?.vcDid) {
            // The ONE durable write on this reader. Ack ONLY if it persisted; a failed (or crashed) put leaves
            // the message on the relay for redelivery next pass. held.put is idempotent by vcDid, so retrying
            // a grant that did land is a harmless overwrite — this is what makes the grant crash-safe.
            let stored = false;
            try {
              await held.put(grant);
              stored = true;
            } catch {
              stored = false;
            }
            if (stored) {
              server.emit('chain-grant', { leafVcDid: grant.handle.issued.vcDid, counter: grant.handle.issued.counter, from: fromDid });
              if (id) doneNow.push(id);
            }
            // not stored → leave unacked → retried on a later pass
          } else if (id) {
            doneNow.push(id); // malformed grant, nothing to persist → ack-drop
          }
          continue;
        }

        // Inbound proof-request → relay to the Signet (loop suspended while awaiting → sole drainer).
        if (body.type === 'hearthold/proof-request' && sovereignDid) {
          let reply: HearthholdMessage;
          try {
            reply = await transport.request(sovereignDid, body, { timeoutMs: 120_000 });
          } catch (err) {
            reply = {
              type: 'hearthold/error',
              version: PROTOCOL_VERSION,
              reason: `Emissary could not reach the Sovereign: ${err instanceof Error ? err.message : String(err)}`,
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
          if (id) doneNow.push(id); // at-least-once relay attempted + replied → ack
          continue;
        }

        // Warden's reply to one of our requests (a submission receipt, or a prove result).
        if (thid && pending.has(thid)) {
          const p = pending.get(thid);
          pending.delete(thid);

          const kind = p?.kind ?? 'unknown';
          let rec: ReceiptRecord;
          if (body.type === 'hearthold/submission-receipt') {
            const r = body as SubmissionReceipt;
            // Ack-before-caption: the Warden replies "received & queued" immediately (no sensitivity yet);
            // the born-obsidian artefact + its classification surface via the Table's SSE, not this ack.
            rec = {
              id: thid,
              kind,
              status: r.queued ? 'queued' : 'stored',
              ...(r.assignedSensitivity !== undefined ? { sensitivityName: sensName(r.assignedSensitivity) } : {}),
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
          if (id) doneNow.push(id); // reply consumed by the in-memory waiter → ack
          continue;
        }
        // Anything else on our mailbox: ack-drop so it doesn't redeliver forever.
        if (id) doneNow.push(id);
      }

      if (doneNow.length > 0) {
        await handle.keymaster.ackDidComm(doneNow, { name }).catch(() => undefined);
      }

      if (running) await new Promise((r) => setTimeout(r, 1500));
    }
  };
  // Fetch the delegation challenge once before serving submissions (no loop contention yet) so the first
  // submit isn't refused for a not-yet-fetched challenge; the loop keeps it fresh thereafter. Best-effort:
  // if the Warden is unreachable at boot, the loop retries and submits fail closed until it succeeds.
  await refreshDelegationChallenge().catch(() => undefined);
  void loop();

  const shutdown = (): void => {
    running = false;
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
