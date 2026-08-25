# Hearthold Agent MCP — a features manual, by role

`@hearthold/agent-mcp` lets an AI agent operate a Hearthold actor through **tools**, not hand-rolled keymaster
scripts. It **augments** Archon's `@didcid/mcp-server` (configure both side by side): the agent gets the ~80
`archon_*` keymaster primitives from that package and the `hearthold_*` verbs below from here — both bound to
the **same identity**.

Every tool acts **"as me"** (the identity the instance is bound to). Nothing here reimplements a keymaster
primitive: the identity/read tools compose the Archon keymaster the shared runtime already holds, and the rest
are thin **façades over the actor's own control-plane routes**.

## The one invariant — a façade, not a bypass

The MCP never widens what a Hearthold actor can do. Every verb routes through the same reference monitor and
the same human gate as the browser UIs and the CLIs:

- `invoke` still steps up to the owner's **Signet** for a sensitive claim (the tool call blocks until consent).
- `decide` / approve is meaningful **only for an AI-agent Sovereign** (its AgentGate self-approves within a
  parent-signed allowance). A **human** Sovereign's approval is entered at the Signet, never through a tool.
- Grants and invocations stay ceiling-, kind-, and revocation-bound; a tool cannot loosen any of it.

## Binding an instance

Identity is **configuration, not per-call plumbing**. Run **one instance per actor**, each bound to that
actor's wallet, and pick the role:

```bash
HEARTHOLD_WALLET_PATH=…/emissary/wallet.json \
HEARTHOLD_GATEKEEPER_URL=http://gatekeeper:4224 \
HEARTHOLD_REGISTRY=local \
HEARTHOLD_PASSPHRASE=… \
HEARTHOLD_MCP_ROLE=emissary \
HEARTHOLD_EMISSARY_CONTROL_URL=http://127.0.0.1:4312 \
  hearthold-agent-mcp            # boots: "[hearthold-agent-mcp] role=emissary · bound as did:cid:… — 5 tools"
```

| Variable | Purpose |
|---|---|
| `HEARTHOLD_WALLET_PATH` | the actor's wallet (the bound identity). `ARCHON_WALLET_PATH` also accepted |
| `HEARTHOLD_GATEKEEPER_URL` | the Archon node (`ARCHON_NODE_URL` fallback) |
| `HEARTHOLD_REGISTRY` | `local` in dev (`ARCHON_DEFAULT_REGISTRY` fallback) |
| `HEARTHOLD_PASSPHRASE` | unlocks the agent key (`ARCHON_PASSPHRASE` fallback) |
| `HEARTHOLD_MCP_ROLE` | `warden` \| `sovereign` \| `emissary` \| `verifier` \| `full` (default `full`); or `--role <r>` |
| `HEARTHOLD_WARDEN_CONTROL_URL` | needed by the **warden** role's façade verbs |
| `HEARTHOLD_SIGNET_CONTROL_URL` | needed by the **sovereign** role's façade verbs |
| `HEARTHOLD_EMISSARY_CONTROL_URL` | needed by the **emissary** role's façade verbs |
| `HEARTHOLD_CONTROL_TOKEN` | optional bearer for a session-guarded control plane |

`full` (the default, back-compat) is the original agent-as-principal set — every verb, for an AI that runs its
own whole stack. The keymaster-direct verbs (`whoami`, `read_card`, `verify_card`) work with no control URL.

### Invariant: the role must match the bound identity (`role → wallet`)

`HEARTHOLD_WALLET_PATH` **must** be the identity that plays the chosen `HEARTHOLD_MCP_ROLE` for this agent —
`role=warden` binds the agent's **warden** identity, `role=sovereign` its **sovereign** identity, and so on.
The spawner (deploy launcher) enforces this by resolving the wallet **from** the role:

```
role=warden  →  identities/agents/<agent>/warden/wallet.json
role=sovereign → identities/agents/<agent>/sovereign/wallet.json
```

This is a **security** contract, not a style rule. Household / KB **membership lives on the agent's Warden
identity** (the Warden DID is what the read group holds). A warden-role instance accidentally bound to the
**Sovereign** wallet mints — via `hearthold_session` — a bearer that authenticates as the Sovereign; a
household Warden's visibility is `ownerOf(a) = a.owner ?? sovereignDid`, so that session matches `ownerOf` for
**every unowned artefact** and **silently over-discloses while rendering healthy**. (Caught pre-render on
2026-08-25 only because `hearthold_session` returns the bound **DID**, never a name.) Admitting the Sovereign
to the household instead is out-of-bounds — it *is* the over-disclosure, never the fix. Bind the Warden
identity for member-auth.

---

## Shared verbs (every role)

| Verb | Args | What it does |
|---|---|---|
| `hearthold_whoami` | — | Which identity am I bound as — DID, wallet name, registry. Proves the binding. *(keymaster-direct)* |
| `hearthold_read_card` | `did` | Resolve + decrypt a card addressed to me, auto-picking the format (held credential, or sealed message/JSON). *(keymaster-direct)* |

---

## Role: **Emissary** — the invoker / companion

The world-facing agent. Observes context and proves facts under its Sovereign-granted authority.
Needs `HEARTHOLD_EMISSARY_CONTROL_URL`.

| Verb | Args | What it does |
|---|---|---|
| `hearthold_contribute` | `kind`, `text`, `attachment?` | Submit an observation to my home vault (born-obsidian → triage). → Emissary `/api/submit` |
| `hearthold_invoke` | `claim`, `kind`, `target?`, `reveal?` | **Prove a fact** by presenting my scope capability — the Warden mints issuer-attested evidence. **Blocks** while a sensitive claim steps up to my Signet. No recipient arg: the audience is designated by the capability. → Emissary `/api/invoke` |
| `hearthold_accept_capability` | `credentialDid` | Hold a Sovereign-granted scope capability so it can be presented on invoke. → Emissary `/api/accept-capability` |

---

## Role: **Sovereign / Signet** — the authorizer

The principal. Grants and revokes disclosure authority, and (for an AI-agent Sovereign) decides step-ups.
Needs `HEARTHOLD_SIGNET_CONTROL_URL`.

| Verb | Args | What it does |
|---|---|---|
| `hearthold_grant_capability` | `emissaryDid`, `kinds?`, `ceiling?`, `target?`, `days?` | Grant an Emissary a **revocable** scope capability to prove facts. Signet-gated — the human (or AgentGate) sees exactly what authority is granted. → Signet `/api/authorize-capability` |
| `hearthold_list_capabilities` | — | **My permissions center** — the capabilities I've granted, each with holder, scope, and state (active / expired / revoked). → Signet `/api/capabilities` |
| `hearthold_revoke_capability` | `credentialDid` | Revoke a grant — flips its status bit so the Warden refuses it at the **next** invocation (revocation-by-default). Immediate. → Signet `/api/revoke-capability` |
| `hearthold_pending_approvals` | — | Approvals pending at my Signet (for an agent that parents its own sub-agents). → Signet `/api/snapshot` |
| `hearthold_decide` | `id`, `approve`, `pin?` | Decide a pending approval. **AI-agent Sovereigns only** — a human's approval is entered at the Signet, not here. Decline is fail-closed, no PIN. → Signet `/api/approve` |

---

## Role: **Warden** — the custodian / enforcer

Holds the vault, admits observations, answers recall, and delegates submit authority.
Needs `HEARTHOLD_WARDEN_CONTROL_URL`.

| Verb | Args | What it does |
|---|---|---|
| `hearthold_recall` | `query`, `maxSensitivity?` | A draft answer over my witnessed history, gated by my ceiling. → Warden `/api/recall` |
| `hearthold_triage` | — | My born-obsidian triage queue — proposals not yet admitted. → Warden `/api/triage` |
| `hearthold_confirm_triage` | `artefactId`, `sensitivity` | Admit a triaged proposal at a chosen sensitivity (0 PUBLIC … 4 SEALED). → Warden `/api/triage/confirm` |
| `hearthold_delegate` | `emissaryDid`, `kinds?` | Delegate **submit** authority to an Emissary. Separate from `grant_capability` (prove authority) by design. → Warden `/api/delegate` |
| `hearthold_list_inbound` | — | Cards passed to me, verified but not yet accepted. → Warden `/api/card/inbound` |
| `hearthold_pass_card` | `toDid`, `cardDid`, `readable?` | Pass a card I hold to another DID (optionally recipient-readable). → Warden `/api/card/pass` |
| `hearthold_accept_card` | `credentialDid` | Accept an inbound card into my vault. → Warden `/api/card/accept` |
| `hearthold_decline_card` | `credentialDid` | Decline an inbound card (fail-closed). → Warden `/api/card/decline` |

---

## Role: **Verifier** — the checker

A third party that checks Hearthold-issued evidence. Keymaster-direct — no control plane.

| Verb | Args | What it does |
|---|---|---|
| `hearthold_verify_card` | `credentialDid`, `trustedIssuer?` | Verify a credential I was handed (e.g. a Warden-minted evidence graph): check the issuer's signature and, if `trustedIssuer` is given, that it was issued by the one I trust. Trust rests on the **issuer's signature**, never a presenter's word. *(keymaster-direct)* |

> **By design, not a gap:** `verify_card` resolves and checks a credential I already hold — a keymaster-direct
> read, which is what the augment does well. A **live present-to-me** verify (challenge a holder for a fresh
> presentation over DIDComm) needs the process to be a DIDComm *participant* (publish an endpoint, own a receive
> lifecycle) and pull in Hearthold's transport — which the agent-mcp deliberately avoids (it augments Archon, it
> doesn't depend on Hearthold internals). That flow lives in the `verifier` CLI today; if we want it here, the
> clean path is a verifier control-plane the MCP façades (like the other roles), not a DIDComm lifecycle inside a
> stateless tool call.

---

## Notes

- **Consent blocks the call.** `invoke` (and any grant that steps up) returns only once the Signet resolves —
  the calling agent sees a `granted` result or a `denied` reason (e.g. `consent declined at the Signet`,
  `capability is revoked`). Design the agent to tolerate a blocking approval, like a human clicking "approve."
- **One schema, many issuers.** In a multi-wallet deployment, set `HEARTHOLD_AUTHORIZATION_SCHEMA_DID` (the
  Warden's canonical HearthholdAuthorization schema) so the Sovereign issues against the DID the Warden's
  challenge requests — see `docs/invocation.md`.
- **Deployment.** Aegis provisions the bound family (wallets, isolation-safe gatekeeper) — the gatekeeper is
  in-network only, so bind from a container on that network. See the family deployment notes.
- **Family roster env (`HEARTHOLD_FAMILY_ROSTER`).** The family directory — a JSON array of
  `{ name, role?, did }`, sourced from the parent-signed `roster.json` — is read by **two** surfaces: the MCP
  `hearthold_family` verb *and* the Warden control route **`GET /api/roster`** (which the Table's Constellation
  reads for DID→name + identity→mailbox resolution). **Set it in BOTH the MCP launcher env AND the Warden
  daemon env.** A node that sets it only for the MCP process returns `members: []` from `/api/roster` (the
  Constellation renders raw DIDs, no names). `roster.json` may hold either mailbox (Warden) DIDs directly, or
  stable identity (Sovereign) DIDs once each agent has published its mailbox pointer (`sovereign
  publish-mailbox`, Q2 — `core/mailbox-pointer.ts`), which the resolver follows.
