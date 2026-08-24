# The Sovereign's Invocation Dashboard — real-time watch (Sevenfold brief)

**Status:** design (2026-08-11; backend note corrected 2026-08-12). A Sevenfold UI workstream over the watch
backend — almost entirely shipped, plus **one** warden emit Aegis added so agent↔agent card-passes surface on
`/api/flow` (see Net). Companion to `invocation.md`, `security-model.md`; the live realization of the
invocation diagram + the attenuation-lattice-walk artifact.

## What it is

The Sovereign's live view of the family's authority graph: **who holds what capability** (the lineage
forest) and **who is exercising it right now** (the flow), rendered in real time. It is the parent-watches-
the-flow principle made concrete — and the one place the Sovereign can pull the **kill-switch**.

## The one invariant that shapes everything

**Envelope + authority only, NEVER content.** Monitoring, not surveillance. The dashboard shows *who → whom*,
*which capability*, *its caveats*, *the kind of act*, and *granted/denied* — it **never** shows the claim, the
task text, or the disclosed data. This isn't a UI preference; the backend already emits envelope-only
(`FlowEvent` carries `witnessKind` metadata, not the claim). The UI must not fetch or render content.

## Data sources (shipped — consume, don't build)

| panel | source | live |
|---|---|---|
| **Lineage forest** | `hearthold_lineage` / `GET /api/lineage` → `LineageNode[]` (`core/lineage.ts:reconstructLineage`) — root grants → attenuated hops, each: holder, caveats {ceiling, kinds, owner, audience, expires, singleUse}, status | SSE `lineage` (hop registered / revoked) |
| **Flow stream** | `hearthold_flow` / `GET /api/flow` → `FlowEvent[]` {from, to, kind, governingCapabilityDid, witnessKind, ts} | SSE `flow` (each invocation / chain-invocation / card-pass, granted/denied) |
| **Kill-switch** | `hearthold_revoke_hop` / `revoke-capability` route (Sovereign-gated) | — |

## The rendering — reuse the visual grammar we already built

Don't invent a new look; this is the **live** version of two artifacts already in the house style:

- **Lineage forest = the descending attenuation graph.** Root grant at the top, attenuated hops descending,
  caveats visibly narrowing (SEALED → MEDIUM → LOW; kinds shrinking; owner scope). This is the
  attenuation-lattice-walk, fed by real hops instead of a scripted chain. A **revoked** subtree dims and
  collapses toward the null/dead state (the same gravity as the lattice-walk's collapse-to-null).
- **Flow = edges lighting up.** As invocations arrive over SSE, the governing capability's edge pulses —
  **granted** in the hearth-copper accent, **denied** in the danger red. A scrolling event log beside the
  graph mirrors the invocation diagram's flow panel, live.
- **Inspector.** Click a node → its caveats, its lineage path (root → here), status, expiry. Click a flow
  event → the act envelope (from, to, kind, capability ref, witnessKind, ts). Never content.

## The one action: the kill-switch

The dashboard is read-only **except** revoke. Selecting a hop → **Revoke** calls `revoke_hop` (a real
authority act, Sovereign-gated at the Signet). On success the subtree goes dark on the next `lineage` frame,
and any in-flight invocation under it fails closed — the visible, immediate expression of per-hop revocation.
This is the Sovereign's power made tangible: cut any capability in the lineage, watch the cone die.

## Scoping (respect the watch owner-scoping)

The forest and flow are **owner-scoped** to the viewing Sovereign — in a multi-member household, the session
member sees only their own scope + what the household config exposes (`governorObservesActivity`, default
false). The visible set is derived **server-side from the authenticated session**, never a client filter —
same rule as the KB/card surfaces. (This is the audit-5 watch owner-scoping item; the dashboard must consume
the scoped feed, not a global one.)

## Build shape

- A Vite/React surface (extend `apps/warden-console` or a new `apps/invocation-dashboard`), talking to the
  Sovereign control plane (`:4311`) — or, once Sevenfold is on the family channel, its own agent surface.
- Two live panels (forest + flow) + inspector + the revoke action. SSE for both feeds; graceful reconnect.
- Theme-aware, house palette (steel neutrals + hearth-copper accent + danger red for denials), matching the
  invocation diagram / lattice-walk so the static explainers and the live tool read as one family.

## Net

**Almost no backend work.** `lineage` + `flow` (+ SSE) and `revoke_hop` shipped in `feat/invocation` — but
the shipped watch emitted only EMISSARY/capability flow: agent↔agent messages (the `hearthold_send`
card-passes) fired nothing, so `/api/flow` never saw the family's comms. Aegis added the one missing emit
(2026-08-12): `POST /api/card/pass` now fires an envelope-only **card-pass `FlowEvent`** to the governing
Sovereign (`parentDid`) — live in the rebuilt `hearthold:invocation` image, with a node-Sovereign watch daemon
standing. So the dashboard = the shipped watch **+ that one emit**, rendered. The Sovereign finally *sees* the
invocation graph AND the family's messages move — and can cut it.
