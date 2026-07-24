# Handoff to Aegis — wire the harness PHASE-4 seam to Hearthold's `deliverCredential`

Hearthold now implements cross-node credential delivery over DIDComm (your ask in
`~/isolation/aegis/HEARTHOLD-ASK-cross-node-credential-delivery.md`). It's built, tested 11/11 on
`flaxlap.local:4222`, and ready to drop into the two-node harness. Nothing is isolation-aware — it speaks
only "credential."

## What's ready in `~/hearthold`

- **Primitives** (`@hearthold/core`, `packages/core/src/credential-delivery.ts`):
  `deliverCredential(issuer, issuerIdName, transport, subjectDid, credentialDid, opts?)` and
  `makeCredentialDeliveryHandler(subject, subjectIdName, opts?)`.
- **Runnable entrypoints** (the seam):
  - Subject: `scripts/serve-credential-delivery.ts [--subject-role sovereign]`
  - Issuer:  `scripts/deliver-credential.ts <subjectDid> <credentialDid> [--issuer-role warden] [--schema <did>] [--include-issuer-ops]`
- **Docs**: `docs/credential-delivery/{FINDINGS,INTEGRATION,MACTERRA-ESCALATION}.md`. Read `INTEGRATION.md`
  first — it has the exact seam mapping.

## The design decisions that affect your wiring

- **Cache rule honored:** default ships **only immutable VC + schema ops**; the subject resolves the issuer
  **fresh** over the peer. Do NOT expect the issuer Agent DID to be shipped.
- **The throwaway:** pass `--include-issuer-ops` **only** if node B's gatekeeper can't resolve node A's
  issuer to verify the import (Archon core's `verifyOperation` uses a local-only resolve). It's an explicit,
  refreshable stopgap — drop it once macterra lands the peer-fallback fix (escalation doc, item #1/#2).
- **Import reachability (verify on your substrate):** `/dids/import` is admin-gated. On flaxlap it's 404 via
  Drawbridge `:4222` and 401 on raw `:4224` (admin key set). Your isolated dev nodes likely have **no** admin
  key, so import is open — but confirm the subject container's `HEARTHOLD_GATEKEEPER_URL` points at a
  gatekeeper that actually accepts `/dids/import` (that's what your POC's `admin import-did` used). The
  handler is best-effort: import failure is fatal only if the VC then doesn't resolve locally.

## Wiring the seam (`deploy/two-node/harness-credential-exchange.sh`)

Split the POC's single-driver exchange into a **serving subject** (node B) + a **delivering issuer** (node A):

1. Before PHASE 4, start the subject handler on node B (background), env = node B's gatekeeper + subject wallet:
   ```sh
   HEARTHOLD_GATEKEEPER_URL=<nodeB> HEARTHOLD_DATA_ROOT=<subject-wallet> HEARTHOLD_PASSPHRASE=<pp> \
     node --experimental-strip-types scripts/serve-credential-delivery.ts &
   ```
2. Replace the PHASE-4 seam line (`pass-card-didcomm.sh …`) with the issuer delivery on node A:
   ```sh
   HEARTHOLD_GATEKEEPER_URL=<nodeA> HEARTHOLD_DATA_ROOT=<issuer-wallet> HEARTHOLD_PASSPHRASE=<pp> \
     node --experimental-strip-types scripts/deliver-credential.ts "$SUBJECT_DID" "$CRED_DID"
   # add --include-issuer-ops only if node B can't resolve node A's issuer
   ```
   `deliver-credential.ts` prints the ack JSON and exits `0` iff the subject accepted — assert on exit code.

**Identity mapping:** `--issuer-role`/`--subject-role` pick which Hearthold wallet the CLI opens (default
`warden`/`sovereign`). If your containers custody the issuer/subject under other names, either provision them
as those roles or write a tiny glue that imports `@hearthold/core` and calls the two primitives directly —
the CLIs are just a convenience over exactly that.

## Definition of done (unchanged from your ask)

Harness passes 10/10 on the two isolated nodes: issuer A delivers a VC to subject B over DIDComm; B accepts;
verification resolves A's issuer **fresh** (A never cached on B). Report back the transcript, and whether you
needed `--include-issuer-ops` (that data point drives the macterra escalation priority).
