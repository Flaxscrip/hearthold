# Archon-core escalation — cross-node credential delivery

From building Hearthold's cross-node credential delivery (`docs/credential-delivery/FINDINGS.md`). Each item
is a small, well-scoped Archon-core change. Line references are against
`~/archon/services/gatekeeper/server/src`. Ordered by leverage.

---

## 1. Make the peer fallback carry `didDocumentData` (the big one)

**What.** `resolveFromUniversalResolver` (`gatekeeper-api.ts:784`) — the peer fallback for a non-local DID —
fetches the peer's **standard resolve** `GET /1.0/identifiers/{did}`, which by design returns only the
public triple and **omits `didDocumentData`** (`identifiers-router.ts:134-137`). The method-specific data
*is* exposed, at `GET /1.0/identifiers/{did}/data` (`identifiers-router.ts:213`), but the fallback never
calls it. So a node can resolve a *peer's* asset DID but gets **no encrypted content** — and `versionTime`
is dropped on the fallback path too.

**Why it matters.** For an asset whose payload is the point — a **verifiable credential** — cross-node
resolution returns an empty shell. `keymaster.acceptCredential` re-resolves internally and fails ("did not
encrypted"). Today Hearthold works around this by **shipping the VC's ops in-band** and importing them.

**Ask.** Have `resolveFromUniversalResolver` **also dereference the peer's `/data`** (and thread
`versionTime` / `versionSequence`) so a peer-resolved doc carries `didDocumentData`. Then a subject node
resolves a peer's VC **with its encrypted content**, and `acceptCredential` works cross-node with **zero
import** — and it resolves the issuer **fresh**, honoring the offline-first cache rule for free. This
**eliminates the ops-shipping path entirely** for credential delivery.

*(If content-on-every-fallback is too broad a default, gate it behind an explicit
`?dereference=data`/`Accept` on the fallback, or a resolve option — the point is the capability exists and
the credential path can opt in.)*

---

## 2. Make `verifyOperation`'s controller resolution fallback-capable + `versionTime`-honoring

**What.** If ops-import stays a supported path (it will, for store-and-forward / true-offline), then
importing an asset still needs its **issuer** resolvable. `verifyOperation` resolves the controller with the
**core, local-only** `resolveDID` (`gatekeeper.ts:460`); the peer fallback (`resolveFromUniversalResolver`)
is a **server-layer** wrapper the core **never calls**, and it also **drops `versionTime`**. So importing a
VC currently requires the **issuer to be locally present** — the only reason a correct implementation would
ever ship the issuer Agent DID (violating the cache rule).

**Ask.** Make the controller resolution inside `verifyOperation` **fallback-capable** (consult the peer when
local resolve misses) and **`versionTime`-honoring** (verify the signature against the issuer's key **as of
the operation's time**, not "latest"). Then a node can import + verify an asset against a **freshly-resolved,
never-cached** issuer.

**Interim (in Hearthold today).** `deliverCredential({ includeIssuerOps: true })` ships the issuer as an
explicit **refreshable throwaway** — off by default, never treated as authoritative, re-resolved fresh for
any signature/authcrypt use. It exists only to satisfy this import-time resolve until the fix lands.

---

## 3. `importDIDs` reachability for cross-node delivery (deployment friction)

**What.** `POST /dids/import` is admin-gated (`requireAdminKey`, `gatekeeper-api.ts:1154`). On a hardened
node that means: **Drawbridge (`:4222`) does not proxy it** (→ `404`), and the **raw gatekeeper (`:4224`)**
returns `401` unless the caller has `ARCHON_ADMIN_API_KEY`. So a subject agent that must import an inbound
VC's ops needs admin credentials on its **own** node — a heavy grant for "accept a credential someone sent
me." (Verified live on `flaxlap.local`.)

**Ask (any one).** (a) A **scoped, non-admin capability** to import ops **for DIDs the caller is the subject
of** (or to import into a quarantine the owner then accepts) — importing immutable, content-addressed ops is
not inherently privileged. (b) Or route it through Drawbridge under an agent capability. (c) At minimum,
**document** that cross-node asset delivery requires the subject's gatekeeper client to carry the admin
`apiKey` (`GatekeeperClientOptions.apiKey`). Moot if #1 lands (no import at all).

---

## 4. `use-id` / `setCurrentId` fails silently (small correctness bug)

**What.** `keymaster` `setCurrentId(name)` returns `false` for an unknown name rather than throwing, and the
CLI `use-id <name>` prints `Unknown ID` but **exits `0`**. A typo'd identity then silently proceeds as
whatever id is current — a wrong-signer footgun.

**Ask.** Throw / exit non-zero on an unknown id. Hearthold guards defensively (`listIds()` before every
`setCurrentId`), but the CLI exit-0 will keep biting scripts and other agents.
