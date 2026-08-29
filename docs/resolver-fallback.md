# Public-resolver fallback — the identity/data split

> **Status:** implemented. Opt-in, default off. `HEARTHOLD_RESOLVER_FALLBACK_URL` /
> `config.resolverFallbackUrl`. Core: `packages/core/src/resolver-fallback.ts` (pure) wired in
> `packages/core/src/keymaster.ts`. Tests: `packages/core/test/resolver-fallback.test.ts`.

## The tension

A Warden bound to a **sealed / private node** (`registry: local`, no off-node peers) gives you isolation by
construction: a DID it anchors never resolves off-node, and no foreign DID resolves *in*. That is exactly the
posture the security model wants for the **data plane**.

But it collides with a real need on the **identity plane**. Access rights in Hearthold are trust-registry
group membership (`docs/trust-registry` model): the Warden can `addGroupMember(group, someDid)` and later
`testGroup(group, someDid)` — pure authorization, no resolution required. **Authentication is different.** When
that member actually shows up — a challenge/response login, a capability invocation, any signature to verify —
the Warden must **resolve their DID document** to check the signature. If the member's identity lives on a
registry the sealed node has no peer for (David's is on `BTC:mainnet`), the sealed node returns *not-found*, and
the Warden can authorize a member it can never authenticate. It can put David on the guest list but can't check
his ID at the door.

Full isolation is a legitimate choice. But "sealed forever, resolve nobody external" is not the only point on
the dial, and forcing every deployment to it means every deployment that ever admits an outside member has no
answer. Hence: **let the Sovereign opt in to a public resolver, for identity resolution only.**

## The split this makes explicit

| plane | what moves | where it lives | this feature |
|---|---|---|---|
| **Data** | vault artefacts, evidence, KB passages | the bound node, sealed | **never touched** |
| **Identity** | DID *documents* (public keys, service endpoints) | content-addressed, public by design | **may federate, opt-in** |

A `did:cid` document is **not secret** — it is content-addressed public-key material, published so that anyone
can verify the holder's signatures. Reading one discloses nothing about the subject's data. Treating identity
resolution as a private-node-only operation conflates the two planes; this feature separates them.

## What it does

`withResolverFallback(primary, fallback)` decorates the bound-node gatekeeper the keymaster resolves through:

1. **Local-first.** Every `resolveDID` tries the **primary (bound node) first**. If it returns a document, that
   is the answer — a DID the sealed node already resolves **never leaves it**. The fallback is consulted *only*
   on not-found or error.
2. **Verified.** The fallback resolves with `{ verify: true }` — the gatekeeper client cryptographically
   validates the returned document against its own genesis. The public resolver is an **availability** provider,
   not a trust root: `did:cid` is content-addressed, so a correct document is self-certifying regardless of who
   served it.
3. **No substitution.** After the fallback returns, the resolved `didDocument.id` is re-checked against the
   requested DID. A mismatch throws (`refusing a substituted identity`) — a malicious or buggy resolver cannot
   answer "resolve David" with someone else's document.
4. **Resolution only.** The Proxy overrides **`resolveDID` and nothing else**. `exportDIDs`, anchoring,
   `processEvents`, and (structurally-forbidden) import all stay on the primary. `handle.gatekeeper` is still
   the bound node. Only identity *lookup* federates; nothing is ever *written* to the fallback.
5. **Off by default.** No `resolverFallbackUrl` ⇒ `withResolverFallback` returns the primary **unchanged**.
   Full isolation is the default and costs nothing.

## Why this stays inside the security posture

- **The data plane is untouched.** No vault content, no evidence, no KB passage crosses this path. It resolves
  public DID documents and returns them; that is its entire surface.
- **It is a deliberate egress, chosen by the Sovereign.** Turning it on means the node will make outbound
  resolution requests to the configured resolver — a real (small) information leak: *which DIDs this node looks
  up*, to that one resolver. A full-isolation Sovereign leaves it off and loses nothing. A Sovereign who wants
  to admit external members turns it on with eyes open, choosing a resolver it trusts for availability.
- **Trust still rests on signatures, not on the resolver.** `{verify:true}` + the id-match check mean the
  fallback can be unavailable or wrong but **cannot forge an identity**. It can refuse to answer (denial of
  availability); it cannot substitute one (denial of integrity is caught).
- **Authorization is unchanged.** Group membership is still the sealed node's own state. This feature only lets
  the Warden *authenticate* a member it has *already authorized* — it grants no new authority.

**Watch-point (per the standing security instruction):** this is an egress toggle. The place to keep honest is
(a) it stays **default-off** and Sovereign-configured, never silently defaulted on, and (b) it never grows
beyond `resolveDID` — the moment any *write* (export/import/publish) is routed to the fallback, the data/identity
split is broken. The type keeps that honest today (only `resolveDID` is proxied; `PrivateGatekeeper` forbids
import at compile time), but any future change to the wrapper should preserve both.

## Usage

```sh
# Sovereign opts in: resolve external identities via a public Archon node, data stays sealed.
export HEARTHOLD_RESOLVER_FALLBACK_URL=https://archon.technology
```

Unset ⇒ full isolation (the default). When set, a Warden on a sealed `local` node can resolve — and therefore
authenticate — an external member (e.g. David on `BTC:mainnet`) whose grant it holds, without exposing any data.

## Relationship to the agency KB

This is the general form of the problem hit deploying David's private "agency" KB on the sealed megaflax node
(`deploy/agency/INSTALL-agency.md`): the sealed node could grant David read but couldn't resolve
`cypher@4tress.org` to complete the challenge/response login. The `--owner-only` build defers David's grant; this
feature is the durable path — with a resolver fallback configured, the sealed KB Warden can resolve and admit
David through the normal challenge/response wall, no deferral needed.
