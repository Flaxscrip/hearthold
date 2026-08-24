# Cross-node credential delivery — Findings

Deliver a verifiable credential from an issuer agent to a subject agent on a **different node that may not
share a registry**, over DIDComm, and have the subject accept (and optionally KB-ingest) it. Built in
`@hearthold/core` as two composable primitives; deployment-agnostic (works identically on a shared-registry
node, where it short-circuits to the native path).

- Implementation: [`packages/core/src/credential-delivery.ts`](../../packages/core/src/credential-delivery.ts)
  — `deliverCredential(...)` (issuer side) + `makeCredentialDeliveryHandler(...)` (subject side)
- Wire type: `hearthold/credential-delivery` (+ `…-ack`) in [`protocol.ts`](../../packages/core/src/protocol.ts)
- Mechanism harness (single node): [`scripts/e2e-credential-delivery.ts`](../../scripts/e2e-credential-delivery.ts)
  — `npm run e2e:credential-delivery` (11/11 live against `flaxlap.local:4222`, `registry=local`)
- True no-shared-registry acceptance: Aegis's `deploy/two-node/harness-credential-exchange.sh` (PHASE-4 seam
  calls this same `deliverCredential`)

## The design in one paragraph

`keymaster.acceptCredential(did)` resolves the VC to decrypt it. Cross-node, Archon's DID resolution carries
only the **public W3C DID document** — never the encrypted `didDocumentData` that *is* the VC content — so a
subject cannot pull + decrypt a VC by reference; `accept-credential` returns "did not encrypted." So the
issuer ships the **content in-band**: the immutable, content-addressed **VC + schema ops** (via the
gatekeeper's public `exportDIDs`), and the subject `importDIDs` + `processEvents` to make the VC locally
resolvable, then `acceptCredential`. authcrypt at the transport layer already authenticates the issuer as
the sender, so there is no separate challenge.

## The `/data` question — is there a pull-by-reference shortcut?

**Investigated, because a pull model would be simpler than shipping ops.** Answer: the endpoint exists but
does **not** help cross-node today, and the finding *sharpens the core escalation* rather than changing the
build.

- There **is** a `/1.0/identifiers/{did}/data` resource that returns `didDocumentData` — the encrypted VC
  content (`identifiers-router.ts:213`). But both it and the standard resolve derive the doc from the *local*
  `resolveDID`. For a VC that lives on the issuer's node, the subject's node resolves it via the **peer
  fallback** — `resolveFromUniversalResolver` (`gatekeeper-api.ts:784`), which fetches the peer's **stripped
  `/1.0/identifiers/{did}`** (`identifiers-router.ts:136` omits `didDocumentData` by design). So the
  subject's `/data` for the issuer's VC returns `{}`. **The peer fallback does not use `/data`.**
- A hand-rolled pull (subject directly `GET`s the *issuer node's* `/data`, deriving its URL from the issuer's
  service endpoint) *would* return the ciphertext — but `keymaster.acceptCredential` re-resolves internally
  (stripped) and would still fail, so we'd have to re-implement accept, which forfeits the native
  `list-credentials` / `view-credential` surface. Not worth it.
- **The real win** (an Archon-core change, escalated to macterra): make the peer fallback fetch the peer's
  **`/data`** (and honor `versionTime`) so cross-node `resolveDID` carries `didDocumentData`. Then
  `acceptCredential` works cross-node with **zero import**, resolving the issuer **fresh** — the cache rule
  for free, and the ops-shipping disappears. See `MACTERRA-ESCALATION.md`.

## The cache rule — what we ship, what we resolve fresh

We ship **only immutable, content-addressed assets**: the VC and its schema. We do **not** ship the issuer's
Agent DID. Identities are **mutable** — keys rotate, services get added — so a cached copy goes **stale** the
moment the issuer updates while disconnected, and a stale issuer **silently** breaks authcrypt (unpack
failures are swallowed at `keymaster.ts:2794`). The subject therefore resolves the issuer **fresh over the
peer** whenever it verifies or authcrypts; the immutable VC/schema are the only things safe to cache.

`opts.includeIssuerOps` is the **only** exception — a documented, **refreshable throwaway**, off by default.
It ships the issuer Agent DID ops **solely** to satisfy the import-time controller resolve on a node that
can't otherwise resolve the issuer (see the blocker below). It is never treated as authoritative: the
imported copy exists for one `importDIDs` call, and any later signature/authcrypt use re-resolves fresh.

## Deployment note — where import is reachable (learned live on flaxlap)

`exportDIDs` (`/dids/export`) is a **public** gatekeeper route. `importDIDs` (`/dids/import`) is
**admin-gated** (`requireAdminKey`), with two consequences we hit on a hardened node:

- **Drawbridge (`:4222`) does not proxy `/dids/import`** → `404` (it fronts didcomm/resolve/capabilities,
  not admin routes). The **raw gatekeeper (`:4224`)** does, but returns **`401`** when `ARCHON_ADMIN_API_KEY`
  is set (flaxlap has it set).
- On a **dev / isolated** node with no admin key configured, admin routes are unprotected — import works
  (this is the Aegis two-node substrate, and what the POC's `admin import-did` relies on).

Because of this, the subject handler treats import as **best-effort**: it attempts `importDIDs` +
`processEvents`, but an import failure is fatal **only** when the VC does not then resolve locally. On a
shared-registry node the VC is already resolvable, so the handler **short-circuits to the native accept**
(satisfying the DoD's "works identically on a shared-registry deployment") even though import is unreachable
there. On the true cross-node node, import is where the VC *becomes* resolvable, so a genuine failure still
surfaces. **For a production cross-node deployment**, the subject's node must expose an import path the
Warden can reach with credentials — i.e. the gatekeeper client needs the admin `apiKey` (a
`GatekeeperClientOptions.apiKey`, not currently threaded through `openKeymaster`) and a URL that routes to
the admin route. This is moot once the core peer-fallback-carries-`didDocumentData` fix lands (no import at
all).

## What the mechanism harness proves (and what it can't)

`e2e:credential-delivery` runs against a **single** node, so it proves the Hearthold **protocol mechanism**:
package → deliver → import(best-effort) → accept → ack; the injected VC→KB bridge hook; idempotent
re-delivery; the `use-id` guard; and the cache rule at the message level (the default ships **no** issuer
throwaway). It does **not** exercise the genuine cross-registry import or the issuer-throwaway necessity —
those bite only when issuer and subject are on nodes with no shared registry, which is exactly what Aegis's
two-node harness covers by wiring its PHASE-4 seam to this `deliverCredential`.

## `use-id` exit-0 guard (defensive, in Hearthold)

`keymaster` `setCurrentId(name)` returns `false` for an unknown name instead of throwing (the CLI even exits
`0` printing "Unknown ID"), so a typo'd identity silently proceeds as whoever is current. Both primitives
check `listIds()` first and fail loud. Also flagged upstream — see `MACTERRA-ESCALATION.md`.
