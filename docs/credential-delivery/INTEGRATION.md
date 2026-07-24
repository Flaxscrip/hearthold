# Cross-node credential delivery — integration & the harness seam

Hearthold-side artifacts for Aegis's two-node harness. Aegis owns the isolated substrate; this is what to
call from it. Nothing here is isolation-aware — it speaks only "credential."

## The two primitives (`@hearthold/core`)

```ts
import { deliverCredential, makeCredentialDeliveryHandler } from '@hearthold/core';

// Issuer side — package VC + schema ops, deliver over DIDComm, await the ack.
const ack = await deliverCredential(issuerHandle, issuerIdName, transport, subjectDid, credentialDid, {
  // includeIssuerOps: true,   // opt-in refreshable throwaway; needed only where the subject's gatekeeper
                               // can't resolve the issuer to verify the import (see FINDINGS / escalation)
});
// ack: { type:'hearthold/credential-delivery-ack', accepted, reason?, ingestedArtefactId? }

// Subject side — a RequestHandler; import shipped ops → accept → optional KB-ingest → ack.
const handler = makeCredentialDeliveryHandler(subjectHandle, subjectIdName, {
  reopen: () => openKeymasterFresh(role, config, passphrase),        // daemon reload-before-write
  onAccepted: async (h, credDid) => (/* ingestCredentialToPartition(...) */ undefined),  // VC→KB bridge
});
await transport.serve(handler, { pollMs: 1000 });
```

`deliverCredential` ships **only the immutable VC + schema ops** by default (the cache rule); the subject
resolves the issuer **fresh**. Import is **best-effort** on the subject: on a shared-registry node the VC is
already resolvable and the handler short-circuits to the native accept, so the same code passes on both
shared-registry and no-shared-registry deployments.

## The two runnable entrypoints (the seam)

Thin CLIs over the primitives, configured entirely by environment
(`HEARTHOLD_GATEKEEPER_URL`, `HEARTHOLD_REGISTRY`, `HEARTHOLD_DATA_ROOT`, `HEARTHOLD_PASSPHRASE`) exactly like
the e2e scripts. Point `HEARTHOLD_DATA_ROOT` at each agent's wallet dir and `HEARTHOLD_GATEKEEPER_URL` at the
node it runs against.

| Side | Command |
|---|---|
| **Subject** (node B) — run first, leave serving | `node --experimental-strip-types scripts/serve-credential-delivery.ts [--subject-role sovereign]` |
| **Issuer** (node A) — the PHASE-4 line | `node --experimental-strip-types scripts/deliver-credential.ts <subjectDid> <credentialDid> [--issuer-role warden] [--schema <did>] [--include-issuer-ops]` |

`deliver-credential.ts` prints the ack JSON and exits `0` iff the subject accepted — so the harness can
assert on its exit code.

## Mapping onto `deploy/two-node/harness-credential-exchange.sh`

The POC did the whole exchange from one driver (`pass-card-didcomm.sh "$ISSUER" "$SUBJECT_DID" "$CRED_DID"
"$SUBJECT"`). The Hearthold model splits it into a **serving subject** + a **delivering issuer**:

1. **Before PHASE 4**, start the subject handler on node B (background), against node B's gatekeeper with
   node B's subject wallet:
   ```sh
   HEARTHOLD_GATEKEEPER_URL=<nodeB> HEARTHOLD_DATA_ROOT=<subject-wallet> \
     node --experimental-strip-types scripts/serve-credential-delivery.ts &
   ```
2. **Replace the PHASE-4 seam line** with the issuer delivery on node A:
   ```sh
   HEARTHOLD_GATEKEEPER_URL=<nodeA> HEARTHOLD_DATA_ROOT=<issuer-wallet> \
     node --experimental-strip-types scripts/deliver-credential.ts "$SUBJECT_DID" "$CRED_DID"
   ```
   Add `--include-issuer-ops` only if node B's gatekeeper can't resolve the issuer to verify the import
   (the interim throwaway; drop it once the core peer-fallback fix lands — see `MACTERRA-ESCALATION.md`).

The identities: `--issuer-role`/`--subject-role` pick which Hearthold wallet the CLI opens (default
`warden`/`sovereign`, matching `e2e-credential-delivery.ts`). If Aegis's containers custody the issuer/subject
under different names, either provision them as those roles or import `@hearthold/core` directly from a small
harness glue and call the two primitives — the CLIs are a convenience over exactly that.

## Verification already done

- `npm run e2e:credential-delivery` — 11/11 live on `flaxlap.local:4222` (`registry=local`): deliver → accept
  → ack, KB-ingest hook, idempotent re-delivery, opt-in throwaway path, `use-id` guard, default ships no
  issuer. Single node, so it proves the **mechanism**; the true no-shared-registry path is the harness's job.
