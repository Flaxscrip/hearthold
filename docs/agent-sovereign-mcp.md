# Agent-as-Sovereign MCP (`@hearthold/agent-mcp`)

An AI agent that IS a Sovereign should live its Sovereign life through **tools**, not hand-rolled keymaster
scripts. `@hearthold/agent-mcp` gives it that surface — and it **augments Archon's `@didcid/mcp-server`
(David's package); it does not rewrite it.**

## The principle: identity is configuration, never per-call plumbing

The friction that motivated this was never a missing verb (`decrypt` exists everywhere) — it was *"which
Sovereign am I, in which registry?"* A card sent to the family `sevenfold` agent couldn't be read while
logged in as the *node* Sovereign. So the binding is the whole game:

> **One MCP server instance per bound identity.** Configure once — wallet · gatekeeper · registry ·
> passphrase — and every tool acts implicitly "as me."

We **reuse Archon's binding verbatim**: `createArchonRuntime(McpServerConfig)` from `@didcid/mcp-server`
opens the bound keymaster; we add only the Hearthold custodian verbs on top.

## Augment, not rewrite — a sibling server

Two MCP servers, one bound identity, no duplication:

- **`@didcid/mcp-server`** → the `archon_*` keymaster primitives (`archon_decrypt_did`, `archon_resolve_did`,
  `archon_send_didcomm`, …). Configured as its own server. **Untouched.**
- **`@hearthold/agent-mcp`** → the `hearthold_*` custodian verbs (below). Reuses `createArchonRuntime` for the
  binding; exposes only what Archon doesn't. **This package.**

`hearthold_read_card` and `hearthold_whoami` *compose* the Archon keymaster the shared runtime already holds
— they never reimplement a primitive. Everything else is a thin facade over the agent's own
Warden/Signet/Emissary control planes.

## Binding (env, HEARTHOLD_* first, ARCHON_* fallback)

```
HEARTHOLD_WALLET_PATH        the bound agent wallet          (→ McpServerConfig.walletPath)
HEARTHOLD_GATEKEEPER_URL     the isolation-safe gatekeeper   (→ nodeUrl; Aegis provisions this)
HEARTHOLD_REGISTRY           local                           (→ defaultRegistry)
HEARTHOLD_PASSPHRASE         operate the agent key
HEARTHOLD_WARDEN_CONTROL_URL / _SIGNET_CONTROL_URL / _EMISSARY_CONTROL_URL   for the facade verbs
```

**Security (Aegis):** a passphrase per instance is fine for an AGENT key the agent must operate; a HUMAN
parent Sovereign's key belongs off-box on their device — never bake one into a server.

## Tools (mirror the Table's `DataSource` verbs — one control surface, two clients)

Keymaster-direct (work from the binding alone):
- **`hearthold_whoami`** — my DID · name · identity registry (the binding, made legible).
- **`hearthold_read_card(did)`** — resolve + decrypt a card AS ME, **auto-picking the format**: a held
  credential (`getCredential`), else a sealed message/JSON (`decryptMessage`, which subsumes `decryptJSON` —
  JSON is a stringified message). The exact read that used to need a six-env-var docker script.

Control-plane facades (need the relevant `*_CONTROL_URL`):
- `hearthold_list_inbound` · `hearthold_accept_card` · `hearthold_decline_card` · `hearthold_pass_card`
- `hearthold_recall` · `hearthold_forge` · `hearthold_triage` · `hearthold_confirm_triage`
- `hearthold_contribute` (via the Emissary) · `hearthold_pending_approvals` · `hearthold_decide`

Each `hearthold_*` name maps 1:1 to a Table `DataSource` verb, so an agent and the human Table reason about
the same surface. Where the clients legitimately diverge — the agent has **no login** (identity is bound),
signs **autonomously within its allowance** (escalation, not a PIN, is what waits on a human), and reads its
own mail (`read_card`) rather than vault faces (`getCardFace`) — those are by design.

## The agent-autonomy nuance

For a HUMAN Sovereign the Signet PIN-gates every sensitive act. For an AGENT Sovereign, its own key signs
autonomously **within its parent-signed allowance/Ruleset**, and only **escalates** to the parent's Signet
when governance demands (over-limit / sensitive / multifactor — the spend model). So the MCP is the
*requesting* side; the parent's Signet the *deciding* side.

## Status

- **Shipped** — the package, the reused binding, `hearthold_whoami` + `hearthold_read_card` (the binding proof
  + the read that hurt), the facade verbs, the low-level MCP server (JSON-Schema, no zod coupling).
  `npm run e2e:agent-mcp` proves binding + read_card (both formats) live and the facades against a mock.
- **Next** — `hearthold_request_spend` (`authorizeSpend`; needs a Warden spend route) once it lands; confirm
  the control-plane session model for a bound agent (single-Sovereign default viewer vs a bound token);
  Sevenfold co-designs the payloads against the `DataSource` seam; Aegis provisions the bound family
  identities + the isolation-safe gatekeeper access each instance binds to.
