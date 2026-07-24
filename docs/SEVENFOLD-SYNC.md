# Hearthold → Sevenfold sync

Core/backend changes since the last sync (`2afd1ae..fba5d5f`). Most of this batch is orthogonal to the
family-session Table — your session-aware control-plane plan, the rewrap handshake
([`phase2-rewrap-handshake-spec.md`](phase2-rewrap-handshake-spec.md)), and the guardianship padlock are all
**unchanged and still the reference**. But a few things touch what the Table shows or does. Actionable items
first.

## 1. Vocabulary: "Guild" → "Sphere" (find/replace in user-facing text)

PVM's word "Guild" was purged from the product. **No control-plane DTO changed** — your API integration is
unaffected — but any UI label, copy, or example credential type you author should switch:
`GuildMembership` → `SphereMembership`, "guild" → "sphere". The mapping (see [`PVM-MAPPING.md`](PVM-MAPPING.md)):

- **Sphere** — a collective/issuer you belong to (PVM's *G*).
- **partition** — a gated compartment of your own knowledge (PVM's *S*).
- They are **different** and must never be merged in UI or prose — "publish to a sphere" ≠ "read from a
  partition."
- Not renamed: the fictional game-of-42 "Drake Gamers Guild" (a gaming-clan proper noun) — leave it.

## 2. "world-public" does NOT mean "the public"

Local-first is the default deployment ([`DEPLOYMENT.md`](DEPLOYMENT.md)): there is **no publication step**. In
the partition ladder, `world-public` means "anyone I've connected with," not the internet — don't render it as
"published to the world." And the real access control is **serve-time**: a document is handed over only when
someone asks and the release gate decides. Never present "unpublished" as the safety property; the serve-time
gate is.

## 3. Co-sign triggers (PROPOSED — wire the hooks, flag as under review)

[`CO-SIGN-POLICY.md`](CO-SIGN-POLICY.md): Sovereign co-sign is required when an act is **(a) irreversible,
(b) crosses a publication boundary, or (c) delegates authority**. The Table's ceremonies map:

| Ceremony | Triggers | Co-sign? |
|---|---|---|
| Publish to a sphere (with peers) | a + b | Yes |
| Issue a recognition | c | Yes |
| Guardianship transfer | a + c | Yes |
| Start a DMZ | none | No — Warden alone |

Proposed, not adopted — build the hook, don't hard-commit the copy.

## 4. Publishing names its target sphere (surface it; never publish ambiently)

New `packages/core/src/sphere.ts`: a publish must name the `Sphere` it targets, and Hearthold refuses if the
active gatekeeper isn't that sphere (fail closed). So any "publish / share" affordance in the Table should
show **which sphere** it lands on. Reads stay ambient — this is publish-only.

## FYI — not Table-facing

- **DMZ / B6.** Cross-node credential *verification* now happens in an ephemeral, peerless "DMZ," never the
  node's own gatekeeper; B6 (gatekeeper purity) is closed three ways and witnessed live on separate
  gatekeepers ([`dmz/RESULTS.md`](dmz/RESULTS.md)). Only relevant if the Table ever surfaces "accept a
  credential from another node" — that flow verifies in a DMZ and keeps a minimal, goal-dependent *keep
  closure*, not a live import.
- **`encryptJSON` is encrypt-for-sender** ([`LEDGER.md`](LEDGER.md)) — a Sovereign can always decrypt what
  they sent; no send-and-forget. Don't imply "sent = gone" anywhere.

## Net for you

No API break, no plan change. Swap Guild→Sphere in copy, fix the `world-public` label, and keep the
co-sign / sphere-target hooks in mind for publish affordances. Everything else is core plumbing that slots
*under* your Table, not into it.

## What landed (commit range `2afd1ae..fba5d5f`)

- Cross-node credential delivery over DIDComm + partition-ladder cleanup (`2afd1ae`)
- Guild→Sphere rename; rotation-safety + PVM-boundaries suites; deployment/co-sign/PVM-mapping docs (`e6a39d9`)
- Sphere selection safety; DMZ session + keep closure (B6 closed by type); ledger note (`463a50d`)
- DMZ target isolation (peerless assertion at open) + Aegis's live Path A/B runs (`db540f8`, `fba5d5f`)
