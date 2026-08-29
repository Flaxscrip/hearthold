# The Doorman — the Emissary web-authenticator skill (`auth:web`)

> **Status:** implemented + e2e-verified live. Module: `packages/emissary/src/modules/doorman.ts`.
> Entrypoint: `emissary doorman [kbId]` (mounts the Emissary module runtime). Warden half:
> `KbService.authorizeCheck` + the `hearthold/kb-authorize-check` message. Tests:
> `packages/emissary/test/doorman.test.ts` (8) + `scripts/e2e-doorman.ts` (`npm run e2e:doorman`).

## The problem it solves

A Warden bound to a **sealed / private node** (`registry: local`) is isolated by construction — the posture
the data plane wants. But it can't admit an external member. It can put David on the guest list
(**authorize** — `addGroupMember`) but it can't check his ID at the door (**authenticate** — resolve his DID
to verify his challenge/response signature), because David's identity lives on a registry the sealed node has
no peer for. Challenge/response login run *by the Warden* (`KbService.startLogin`/`completeLogin`) dies at
`verifyResponse(davidResponse)`: the sealed node can't resolve him.

The wrong fix is to teach the Warden — the custodian, the reference monitor — to reach a public resolver.
That softens the boundary Hearthold exists to enforce: *separate the custodian of data from the agent that
acts in the world.* The right fix is to put the door where the world-facing agent already stands.

## The design: authentication moves to the Emissary, authorization stays at the Warden

```
David ──HTTP──▶ Doorman  (auth:web skill on the Emissary, a PUBLIC node)
                  1. createChallenge()   ← the EMISSARY's own keymaster
                  2. verifyResponse()    ← the EMISSARY resolves David (it's public; it holds no vault)
                  3. authorize? ──DIDComm──▶ Warden (SEALED, local)
                                              authorizeCheck(subjectDid) = testGroup(readGroup, davidDid)
                                              — a pure DID-STRING membership test, no resolution
                  4. serveShared() ──▶ the doorman's own shared-scope read session ──▶ answer to David
```

The split is exact and rests on one fact the code map confirmed: **authorization is a pure string test.**
`GroupTrustRegistry.authorize` calls `keymaster.testGroup(group, entity_id)` — it needs the *group* resolvable
(the Warden's own, on its own node) and the member as a bare DID string. It never resolves the member's DID
document. So:

- **Authentication** (needs a challenge David can resolve + resolving David back) happens at the **public
  Emissary**, which faces the world anyway and has no vault to lose.
- **Authorization** (just "is this DID in the group") stays at the **sealed Warden**, which needs nothing but
  the string.

Two things a sealed custodian could never do alone become possible together, without the custodian ever
reaching a public resolver.

## What the doorman serves — and the trust boundary

The doorman serves the KB's **shared corpus only** (`serveShared`, pinned `scope:'shared'`), from its own
held read session — never any member's private partition.

Because the sealed Warden cannot authenticate David itself, it **trusts the Emissary's assertion** that a DID
was authenticated. That is a real trust delegation, new in the posture — so it is bounded the object-capability
way. The doorman's only authority is a **read membership** on the one KB (revocable: `removeGroupMember`). The
blast radius of a fully compromised doorman is therefore *"this one KB's gated shared corpus leaks to whoever
the attacker claims is authenticated"* — never the vault, never write, never a private partition, never another
KB. The membership probe (`kb-authorize-check`) is itself **gated**: only a caller already read-authorized on
the KB (the doorman holds that authority) gets a truthful verdict; anyone else is told `false`, so it is not a
membership oracle a stranger can query.

The Sovereign shuts it all by revoking the doorman's read authority.

**Watch-points (per the standing security instruction):**
- The doorman must stay pinned to `scope:'shared'`. Serving a private partition on an Emissary-asserted
  identity would widen the blast radius to "any member's private data."
- The doorman's read authority is the whole trust root — keep it a **single-KB, read-only** grant, revocable,
  and never let it accrue write or a second KB.
- **Future hardening (trustless):** David hands over his content-addressed DID document + operation chain; the
  Warden verifies the signature offline (did:cid is a hash of its genesis — the op-chain is self-certifying) and
  trusts the Emissary for *nothing*. A deeper build; noted, not yet done.

## Registry / sphere requirement

The doorman authenticates the visitor, so the **Emissary must be pointed at a node that can resolve the
visitors' sphere** (a public Archon node for `hyperswarm` / a chain identity). That is in-posture: the Emissary
is public by design and holds no vault. The Warden stays on `local`. Deployment wires the two on their
respective nodes; the software just uses each agent's own keymaster + node.

## Running it

```sh
export HEARTHOLD_WARDEN_DID=<the KB Warden's did:cid>
export HEARTHOLD_DOORMAN_KB=agency         # the KB to guard (or pass as: emissary doorman agency)
export HEARTHOLD_PORTAL_PUBLIC_URL=https://agency.example   # baked into the login callback
emissary doorman
```

The doorman needs its own **read membership** on the KB (its corpus-serving identity and the probe gate):
`grantAuthorization(warden, readGroup, emissaryDid)`. Grant read to each external member the same way; they
then authenticate through the doorman with no deferral.

## Verification

- Unit: `packages/emissary/test/doorman.test.ts` — 8 hermetic tests (authn+authz both required before a
  session; unauthorized-but-signed refused at the gate, never reaches `serveShared`; session lifecycle).
- Live e2e: `scripts/e2e-doorman.ts` — real `did:cid` identities against a live node + Ollama; the Emissary
  mints+verifies the challenge, the Warden authorizes via `testGroup`, David reads the shared corpus, Mallory
  is refused, the probe is gated. Passed live on the flaxlap node.

## Relationship to the agency KB

This is the durable path for David's private "agency" KB (`deploy/agency/INSTALL-agency.md`). The sealed KB
Warden grants David read; the doorman on a public-facing Emissary authenticates him through the normal
challenge/response wall and serves the shared corpus — retiring the `--owner-only` deferral that existed only
because the sealed node couldn't resolve David.
