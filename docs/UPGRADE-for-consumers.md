# Upgrade guide — consumers of the invocation branch

Hearthold's `feat/invocation` branch (tip `378a9b7`) closed three security audits on the
capability/invocation layer. This guide is the source of truth for the three teams building on
Hearthold as a base: **Aegis** (infrastructure), **Sevenfold** (UI / control plane), and **HATPro**
(DIF Hospitality & Travel Profile, A2A + CGPR).

**Sequencing.** Aegis plans and lands the merge first; Sevenfold and HATPro upgrade only after the
merge is in and the config posture is known (see below). Each section is a self-contained prompt you
can hand to the corresponding AI.

Canonical references in this branch: `docs/invocation.md` (design, as shipped), `docs/UPGRADE-legacy-removal.md`
(what was removed and what replaces it), `docs/attributions.md` (what we build on Archon and what the
invocation layer adds).

---

## Read this first — two secure-default flips change behavior for EXISTING state

The branch is not a pure code merge. Two defaults change how already-issued state and existing flows behave:

- **`requireRevocableCapabilities` defaults `true`** → a capability already issued *without* a
  `credentialStatus` pointer is now **denied at invocation**. `issueScopeCapability` auto-allocates a
  status when passed `config`, so newly-minted capabilities are fine; anything minted the old way is not.
- **`requiresHumanAt` defaults `MEDIUM`** → an existing MEDIUM+ evidence disclosure now **requires a
  reachable Signet** to obtain a signed consent discharge, or it fails closed (denied).

Both are env-tunable, which is the staged-rollout escape valve:

```
HEARTHOLD_REQUIRE_REVOCABLE=false        # allow non-revocable capabilities (compatibility)
HEARTHOLD_REQUIRES_HUMAN_AT=SEALED       # only SEALED requires the Signet step-up (compatibility)
```

Recommended path: merge in the **compatibility posture** above, verify green, then flip to the secure
defaults deliberately — after capabilities are re-issued with a status and the Signet is confirmed
reachable, or as an explicit go/no-go. This ordering is Aegis's to own.

---

## → Aegis (infrastructure / deployment) — merge first

```
Hearthold's feat/invocation branch (tip 378a9b7) closed three audits on the capability/
invocation layer. Before Sevenfold and HATPro upgrade, produce and execute a MERGE PLAN to
bring feat/invocation into <your deploy base>. Plan first, then upgrade infra.

PHASE 1 — MERGE PLAN (write it, then we review before executing)
Scope the diff feat/invocation vs <base>. Conflict/awareness hotspots:
  core:    prove.ts, protocol.ts, invocation-monitor.ts, config.ts, capability-vc.ts,
           single-use.ts, transport.ts
  warden:  handler.ts, evidence.ts, delegations.ts, control.ts, index.ts, + NEW challenge-store.ts
  sovereign: handler.ts    emissary: control.ts    a2a-gateway: gateway.ts, ticket-auth.ts
New public surface consumers depend on: ChallengeStore, makeDidcommDischargeRequester,
issueScopeCapability's `config` param, config.{requiresHumanAt,requireRevocableCapabilities},
the hearthold/{challenge,discharge}-{request,response} messages, ProofResult.challenge,
DisclosedCredential.subject.

CRITICAL — these are behavior changes for EXISTING state, not just new code:
  • requireRevocableCapabilities defaults TRUE → capabilities already issued without a status
    pointer will be DENIED at invocation.
  • requiresHumanAt defaults MEDIUM → existing MEDIUM+ disclosures now REQUIRE a reachable
    Signet or fail closed.
Plan a STAGED rollout using the built-in escape valve: merge in compatibility posture
(HEARTHOLD_REQUIRE_REVOCABLE=false, HEARTHOLD_REQUIRES_HUMAN_AT=SEALED), verify green, then flip
to secure defaults deliberately — either after re-issuing capabilities with a status
(issueScopeCapability now auto-allocates one when passed `config`) and confirming Signet
reachability, or as an explicit go/no-go. Include a rollback (revert-merge) note.

PHASE 2 — INFRA UPGRADE (after the merge lands)
  • Add HEARTHOLD_REQUIRES_HUMAN_AT and HEARTHOLD_REQUIRE_REVOCABLE to every daemon's
    compose/systemd env (staged values first, per Phase 1).
  • MEDIUM+ disclosure now depends on a live, on-branch, DIDComm-reachable Signet — add a
    Warden↔Signet /didcomm reachability probe to health checks.
  • Registry hygiene: issuing a capability now auto-creates a StatusList + allocation record per
    issuer, born on config.registry. Confirm HEARTHOLD_REGISTRY=local is set in every daemon env;
    extend the registry-hygiene self-test to assert these new assets are born local.
  • Custom bootstraps only: if you don't run the shipped `warden serve`/`warden control` bins,
    construct EvidenceService(handle, config, makeDidcommDischargeRequester(transport)) and pass
    `new ChallengeStore(handle, config.registry, config.sovereignDid)` as the last makeWardenHandler
    arg. The shipped bins already wire both.
  • Inherited hardening (awareness): authcrypt-only sender trust (metadata.authenticated); the
    spent-txn ledger is atomic + fails closed on a corrupt file (start from clean state).

VERIFY (gate the merge on green):
  npm run build
  HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local npm run e2e:invocation
  node --experimental-strip-types scripts/e2e-invocation-discharge-didcomm.ts
  node --experimental-strip-types scripts/e2e-daemon-image-submit.ts

READ: docs/UPGRADE-legacy-removal.md, docs/invocation.md §5.3, docs/attributions.md.
```

---

## → Sevenfold (UI / control plane) — after the merge lands

Send only after Aegis confirms the merge is in **and** which posture the flags are in. If Aegis merged
in compatibility posture, the MEDIUM+ consent step-up may not be switched on yet — don't chase a flow
that isn't live.

```
Hearthold's feat/invocation branch (tip 378a9b7) changed the control-plane surface the Table
and the browser apps talk to. Please reconcile the UI against the following.

REMOVED ROUTES (these now 404 — grep your apps for them)
  Warden:   POST /api/forge, POST /api/present
  Emissary: POST /api/prove
The emissary app's "prove" button is the main casualty (apps/emissary). Re-implement it on the
capability path: the Emissary holds a Sovereign-issued scope VC, fetches a Warden challenge
(hearthold/challenge-request), presents it, and sends hearthold/invocation; the Warden returns a
hearthold/evidence-response. See scripts/e2e-invocation-didcomm.ts for the exact client sequence.

NEW UI STATES TO HANDLE
1. Consent step-up on disclosure. A MEDIUM+ evidence disclosure now routes a consent request to
   the owner's Signet and blocks until it's signed (or declines/times out). The UI must show a
   "waiting for approval at your Signet" state and handle a denial gracefully (reason:
   "consent declined at the Signet" / "no discharge channel"). This is deny-by-default.
2. Submit requires a delegated Emissary. POST /api/submit on the emissary daemon now works out of
   the box (the daemon self-provisions its delegation), BUT only after the Emissary has been
   delegated: `warden delegate <emissaryDid>`. Before that, submit returns "not authorized to
   submit yet — no Warden-issued delegation is available." Surface this as a first-run
   "delegate this device" step rather than a raw error.
3. Capabilities/grants now carry a revocation status; if you render capability or grant details,
   expect and (optionally) display a credentialStatus pointer.

DO
- Remove/replace calls to the three deleted routes; re-point the prove UI to the invocation flow.
- Add the consent-pending + consent-declined states to any prove/disclosure surface.
- Add a "delegate this Emissary" onboarding step gating first submit.

VERIFY
- `npm run build` in the affected app; click-through prove + submit against a running
  `warden control` (:4310) + `emissary control` (:4312) on this branch, with the Signet daemon up.

READ: docs/UPGRADE-legacy-removal.md (§2 emissary prove button), docs/invocation.md §5.2 (the
wire shape: presentation + act, no capability body).
NOTE: the multi-Sovereign "family" control-plane/session work is a SEPARATE plan
(docs/plan-under-review.md) — not part of this upgrade.
```

---

## → HATPro (DIF Hospitality & Travel Profile / A2A + CGPR) — after the merge lands

```
Hearthold's feat/invocation branch (tip 378a9b7) wired ticket verification into the A2A gateway
and made capabilities revocable by default. This touches the CGPR path HATPro rides.

A2A / CGPR
1. The CGPR ticket is broker B's signed VOUCH for C. Ticket verification is now demonstrated on
   the real gateway RPC path (not just a standalone helper). If HATPro runs its own gateway,
   opt in:
     const verifyTicket = makeTicketVerifier({ keymaster, trustedBrokers: [brokerDid] });
     // or brokerRegistry: a GroupTrustRegistry, for TRQP-scale broker trust
     startA2aGateway({ ..., verifyTicket });
   and sign tickets with signTicket(broker, brokerName, ticket). Once verifyTicket is set, an
   unsigned ticket or one from an untrusted broker is refused AT THE GATEWAY RPC. The CgprTicket
   schema gained a `proof` field for B's signature — issue tickets through signTicket.
   Reference: scripts/e2e-cgpr-gateway.ts (now signs + verifies) and scripts/e2e-cgpr-ticket-auth.ts.
2. Unchanged invariants you still rely on (verify you don't regress them): no subject DID before
   consent, grants minted to a fresh pairwise DID, the Warden authors the consent text. A2A stays
   at the edge; nothing Archon-specific leaks into the A2A envelope.

CAPABILITIES
3. Revocation by default: if HATPro mints scope capabilities via issueScopeCapability, pass
   `config` so a revocation status is allocated — otherwise the capability is non-revocable and
   the Warden REFUSES it at invocation (config.requireRevocableCapabilities, default true). An
   explicit caveats.status still wins if you manage indices yourself.

DO
- Wire verifyTicket into HATPro's gateway construction and switch ticket issuance to signTicket
  with your broker identity (allowlist or a broker GroupTrustRegistry).
- Audit any issueScopeCapability call sites to pass `config`.

VERIFY
  npm run build
  HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
    node --experimental-strip-types scripts/e2e-cgpr-ticket-auth.ts
  node --experimental-strip-types scripts/e2e-cgpr-gateway.ts   # broker-signed ticket + gateway reject
  # if HATPro has its own hatpro CGPR e2e: run it after wiring verifyTicket.

READ: docs/a2a-cgpr.md, docs/invocation.md §4 (Archon substrate), and packages/a2a-gateway/src/ticket-auth.ts.
```
