# Hearthold — KB Spaces (shared + per-member private partitions)

**Status:** design (2026-07-11). Generalizes the shared Knowledge Portal so that, alongside the shared
DB, **each Sovereign registered in a KB gets a private DB scoped to them.**

Enables: a **Family DB** (household-shared knowledge + a private DB per family member); a **custodial
HATPro DB** (org/custodial-shared + a private traveler-profile DB per traveler — which the A2A/CGPR
gateway then discloses preferences *from*). This is the generic version of the "Design 1 / Design 2"
sketch discussed earlier.

## The abstraction

A **KB space** (e.g. `family-kb`) is one named collection of **partitions**:

- exactly **one shared partition** — all members read; write per policy (today's shared KB), and
- **one private partition per member** — only that member reads/writes.

A private partition is *"just another KB whose group has exactly one member"* — so the whole existing
multi-KB machinery is reused (a `kb`-tagged index scope + a `GroupTrustRegistry` read/write group + a
Ruleset assurance policy). Four things are added: auto-provisioning, the visible set, union recall, and a
contribute scope.

### Partition model (location-abstract — decided)

Every partition records **where it lives**, so the same pattern serves both the operator-trusted local
model *and* the future operator-private federated model with no rewrite:

```ts
interface Partition {
  spaceId: string;                 // parent space
  id: string;                      // the index `kb` tag / scope id
  role: 'shared' | 'private';
  owner?: string;                  // the member's Sovereign DID (private partitions only)
  readGroup: string;              // GroupTrustRegistry group DIDs
  writeGroup: string;
  location:
    | { kind: 'local' }                        // on this Warden (Phase 1 — all partitions)
    | { kind: 'remote'; wardenDid: string };   // on the OWNER's own Warden (Phase 2 — operator-private)
}
```

## The four mechanics

1. **Membership auto-provisions the private partition.** `warden kb-grant <sovDid> --kb <space>` also
   creates that member's private partition (`writeGroup`/`readGroup` = `{sovDid}` only, location `local`,
   inheriting the space policy) when the space has member partitions enabled. A Warden-side map records
   `(spaceId, ownerDid) → partition` (like the pairwise-DID store — private, never on the wire).

2. **The visible set is derived server-side from the authenticated session DID** — never from client
   input. On a session-request the Warden computes *this caller's* visible set:

   ```
   visibleSet(did, space) = [ shared partition if `did` ∈ members ]  ++  [ their private partition, if any ]
   ```

   A member cannot ask to read another member's partition: authorization is a per-partition group check,
   and the set is computed from the session DID, not the request body.

3. **Recall unions the visible set.** Today recall filters `kb === oneId`; it becomes `kb ∈ visibleSet` —
   a one-line generalization of the existing index-tag filter (Phase 1, all-local). Each citation carries
   which partition it came from, so answers stay legible ("from your private notes" vs "family-shared").

4. **Contribute takes a `scope`** (`shared` | `private`) that targets the shared partition or the caller's
   own private one, with a **per-space default** (decided): personal-profile spaces (HATPro traveler,
   family personal) default `private`; a public FAQ space defaults `shared`. Promotion private→shared is an
   explicit, consented "publish" gesture — never automatic.

## Privacy: it is a retrieval-scoping property, not model isolation

The local model is **stateless per query** (no cross-query memory, no fine-tuning), so **one Ollama serves
every member safely** — *provided one rule holds*: the recall pipeline computes the visible set from the
**authenticated DID**, filters the index to it, and only *then* re-unseals plaintext for the model. A
member's private content can never enter another member's query context because it is filtered out before
the model sees anything. That single enforcement point — *visible set from the session, never from the
client* — is the whole game. Per-partition encryption keys (the Warden touches a partition's key only
during that member's session) are worthwhile defense-in-depth, not a guarantee.

## Trust boundary (honest)

- **Private-from-peers: cryptographically enforced** (group membership + server-side scoping). Another
  member cannot read your partition.
- **Private-from-operator: not provided in Phase 1.** The Warden must unseal private content to index and
  answer over it, so a host-root operator can read the keys and thus the content. This is inherent to
  local-AI RAG — whoever runs the AI that answers your private questions can read them.
- **Phase 2 (operator-private) via federation:** a member's private partition lives on **their own**
  Warden (`location.kind = 'remote'`); the space federates — recall unions the community Warden's shared
  partition with the member's remote private partition (a DIDComm recall request; the remote Warden runs
  its own recall over its private data and returns citations/snippets, so raw private content and
  embeddings never leave the owner's device). Same pattern, different partition location.

## Invariant, restated

The old "guild brain ≠ personal vault" bends here, so state it precisely: **partitions never leak across
the visibility boundary without an explicit, consented promotion.** The shared partition is nobody's 7th
Capital; a private partition is a *scoped* personal space within the space (not the member's whole Warden
vault); private→shared is always a deliberate act.

## Implementation sketch

- **Config (per space):** `memberPartitions: boolean`, `defaultScope: 'shared' | 'private'`. A plain
  existing shared KB = a space with `memberPartitions: false` (fully backward-compatible; no private
  partitions until grants provision them).
- **`KbService`: single-`kbId` → space-aware.** `handle(req, sessionDid)` resolves the visible set, then:
  *query* → union recall over the visible set; *update* → resolve the target partition by `scope`, then
  seal + classify + index with `kb = partition.id`. Authorization checks the DID against the **target
  partition's** group.
- **Partition store (Warden-side):** `(spaceId, ownerDid) → Partition`, provisioned on grant; carries
  `location` (the federation seam).
- **Recall:** `recall(query, { partitions: Partition[], k })` — Phase 1 filters the local index by
  `kb ∈ localPartitionIds`; Phase 2 adds a `remote` branch that issues a federated recall over DIDComm.

## Phasing

- **Phase 1 — all-local (operator-trusted):** partition model + per-space config + auto-provision on grant
  + visible-set resolution + union recall + scoped contribute. Ships the Family DB and the custodial
  HATPro DB. `e2e:kb-spaces` — two members, each sees shared + their own private, neither sees the other's.
- **Phase 2 — federation (operator-private):** the `remote` partition location + federated recall over
  DIDComm to the owner's Warden. Design 2, without a rewrite.
- **Phase 3 — CGPR tie-in:** the A2A/CGPR gateway discloses a traveler's preference **from their private
  partition** in the custodial HATPro space — the custodial DB becomes the vault the gateway serves.
