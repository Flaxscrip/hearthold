# Roadmap — the invocation / capability workstream

Supersedes the stale build plan in `docs/invocation.md §8` (the old attenuation-chain phases, pre-VC-rearchitecture).

## The user model

Invocation makes the Emissary a **borne, scoped, revocable delegate** rather than an ambient session cookie.
Lifecycle: **grant → invoke → step-up → revoke.** Posture: a *standing capability* for routine facts (the
Emissary acts autonomously), with an *automatic Signet step-up* for anything at or above `requiresHumanAt`.

## Phases

- **Phase 1 — grant + invoke spine.** ✅ `sovereign capability:grant`, `emissary invoke`, the reusable
  `invokeEvidence` helper, and a third party verifying the Warden-issued graph. (`e2e-invocation-spine`)
- **Phase 1.5 — keyless invoke-shim.** ✅ Emissary `POST /api/invoke` + `/api/accept-capability`, Sovereign
  `POST /api/authorize-capability` (Signet-gated grant); the `Invoke*`/`Authorize*` contract published in
  `@hearthold/control-types`. Unblocks Sevenfold's keyless Table. (`e2e-invoke-shim`)
- **Phase 2 — CGPR threshold.** ✅ CGPR autonomy is now a single configurable knob, `cgprAutonomousAtOrBelow`
  (env `HEARTHOLD_CGPR_AUTONOMOUS_AT`, default **LOW**): a disclosure ≤ the threshold clears autonomously, above it
  steps up to the Sovereign's Signet. Stricter than the internal `requiresHumanAt` by default; configurable both
  ways. Replaced the fixed STANDING release ladder in `CgprService`, the same move `requiresHumanAt` made on the
  invocation path. (`e2e-cgpr-threshold`)
- **Phase 3 — per-actor MCP servers.** ✅ (first slice). `@hearthold/agent-mcp` is now role-configured
  (`--role warden|sovereign|emissary|verifier`, or `full` = the original agent-as-principal set): each role
  exposes only its actor's verb set as a façade over the control-plane routes. Retired the stale
  `hearthold_forge` (→ removed `/api/forge`) for `hearthold_invoke` (→ `/api/invoke`) — closing an audit-4
  standing finding — and added `grant_capability`, `accept_capability`, `delegate`, and a keymaster-direct
  `verify_card`. (`smoke-agent-mcp-roles`) Deferred: the Verifier's full challenge/response verify (needs a
  DIDComm request/present, not just a resolve-and-check); the MCP still can't bypass the monitor or human gate.
- **Phase 4 — permissions center.** ✅ The Sovereign records each grant (`CapabilityGrantStore`), lists it with
  its state (active/expired/revoked), and revokes it by flipping the status bit — which the Warden's
  revocation-by-default check refuses at the next invocation. CLI (`sovereign capabilities` /
  `capability:revoke`), control routes (`GET /api/capabilities`, `POST /api/revoke-capability`, and
  `authorize-capability` now records), MCP verbs (`list_capabilities`, `revoke_capability`), and the Table
  mirror contract in control-types. Also fixed a multi-wallet bug this exposed: authorization schema DIDs are
  NOT content-addressed across wallets, so the issuer now mints against the verifier's schema DID
  (`config.authorizationSchemaDid` / `HEARTHOLD_AUTHORIZATION_SCHEMA_DID`). (`e2e-permissions-center`: grant →
  list → invoke → revoke → deny.)
- **Phase 5 — onboarding + Emissary-as-delegator.** Baseline grant wired into device setup alongside
  `warden delegate`; multi-hop attenuation (the retained `attenuation.ts` / `capability-chain.ts` primitive) so
  the Emissary can attenuate-and-hand-off a further-narrowed capability to a third party.

## Phase 3 — per-actor MCP servers (detail)

**Goal.** Everything is now clean per-actor capabilities behind APIs and CLI verbs. Expose each actor's surface
as MCP tools so **AI agents can drive Hearthold actors directly** — the agent-facing realization of the
agent-family model (human-parented AI-agent Sovereigns, agents coordinating over Archon instead of a human
relaying notes).

**Shape.** Generalize the existing `@hearthold/agent-mcp` (today one custodian augment over Archon's
`@didcid/mcp-server`, bound to a single identity) into a **role-configured server** — `--role
warden|sovereign|emissary|verifier` binds that actor's identity and exposes its verb set. Every tool is a
**façade over the control-plane routes + the reusable helpers** (`invokeEvidence`, `issueScopeCapability`, …),
never a reimplementation, so the security invariants come for free.

| Actor | Role | Representative verbs (wrapping existing paths) |
|---|---|---|
| **Warden** | custodian / enforcer | status, vault-list (owner-scoped), `delegate`, `recall`, triage/admit, revoke |
| **Sovereign / Signet** | authorizer | `grant-capability`, `sign-ruleset`, `revoke-capability`; **approve/deny step-ups only for AI-agent Sovereigns** |
| **Emissary** | invoker / companion | `submit`, `invoke` (forge), `accept-capability`, `project` |
| **Verifier** | checker | `request-proof`, `verify` |

**The load-bearing invariant — MCP is a façade, not a bypass.** Every tool routes through the same reference
monitor and the same human gate:

- An Emissary `invoke` still triggers the owner's Signet consent for a sensitive claim — the human (or an
  AI-agent Sovereign's AgentGate) approves, never the MCP caller.
- A Sovereign `approve` tool is meaningful **only for an AI-agent Sovereign** (AgentGate self-approval within a
  parent-signed allowance). A **human** Sovereign's approval never routes through an MCP tool — it stays at the
  Signet. PVM separation intact: the MCP exposes the *ask*, never the authority to self-grant.
- Grants/invocations remain revocable, ceiling/kind-bound, and consent-gated exactly as they are today; the MCP
  cannot widen any of it.

This is the same principle as the invoke-shim (Phase 1.5): a lower-trust caller submits an *intent*; the
wallet-holding, capability-bound actor runs the ceremony. The MCP layer is that pattern, generalized to every
actor and pointed at AI agents.
