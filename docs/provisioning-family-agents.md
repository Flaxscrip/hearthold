# Runbook — governing the family agents (repoint + parent-signed allowances)

Moves the three family agents (**Sevenfold, Aegis, Hearthold**) from *ungoverned root* to the decided
topology (flaxscrip, 2026-08-28): **each is its OWN Sovereign, governed by the node sovereign as PARENT**
(see [`family-agent-sovereign-topology`] and `agentgate-allowance.md`). It closes two live symptoms on the
`b2b25fa` deploy at once:

1. every emissary's `sovereignDid` points at the **node** sovereign, not its own → Sevenfold's bind-by-DID
   guard excludes the agent's own signet as foreign;
2. every agent-signet is an **ungoverned root** self-approver (`controlAllowance.bound:false`) — the
   AgentGate.permit enforcement shipped but no allowance is provisioned, so the gate is open.

They must land **together** (Aegis's sequencing note) — an emissary repointed to a Sovereign whose signet
has no matching allowance, or vice-versa, leaves two answers to "who is my Sovereign" in one Trinity.

## Identities (from Aegis's live probe — Aegis holds the full DIDs)

| agent | its OWN Sovereign DID | emissary currently points at (wrong) |
|---|---|---|
| sevenfold | `…jvo5bvkcl23vqq` | `…lbedh4sjij3ufa` (node) |
| hearthold | `…7vy33gyyx34jzq` | `…lbedh4sjij3ufa` (node) |
| aegis | `…ybvmfyl3hkltc4nq` | `…lbedh4sjij3ufa` (node) |

Parent (node sovereign, the human PIN gate at `:4361`): `…lbedh4sjij3ufa`.

## DECISION FOR FLAXSCRIP — the control-act authority table (gates everything)

For each agent, what may it **self-approve** (`control.selfApprove`)? Every control act *omitted* escalates
to the node sovereign's Signet (proof-of-human). Acts: `grant-capability`, `mint-root-capability`,
`authorize-capability`, `revoke-*`, … each with an optional `resourcePrefix`.

**Recommended conservative start (secure-by-default; widen deliberately per demonstrated need):**
- **All three: empty `selfApprove` initially** → pure deny-by-default. Every control act escalates to the
  node sovereign. This immediately CLOSES the open gate with the least authority, and turns the honest
  banner from "root, self-approves everything" to "child, bound, self-approves nothing yet."
- Then widen one agent at a time as a real need appears (e.g. grant Aegis `grant-capability` within its own
  infra resource prefix), each widening a fresh parent-signed supersession.

Confirm the scope per agent before Step 1 — this is the one governance call; the rest is mechanical.

## Step 1 — sign + anchor an allowance per agent  ·  OWNER: flaxscrip (node-sovereign wallet)

For each agent, with the **node sovereign** wallet (the parent). Reference: `scripts/e2e-agent-allowance.ts`
lines 72–89.

```ts
const allowanceCaps: ControlAllowance = { selfApprove: [ /* the DECIDED acts for this agent */ ] };
const rulesetBody: Ruleset = {
  actor: '<AGENT own Sovereign DID>',   // e.g. …jvo5bvkcl23vqq for sevenfold
  actorKind: 'sovereign',
  version: 1, previous: null,
  capabilities: { control: allowanceCaps },
  ceiling: 0, status: 'active',
};
const signed = await signRuleset(nodeSovereign, rulesetBody);      // PARENT signs — a self-signed one is refused
const allowanceAsset = await nodeSovereign.keymaster.createAsset([signed], { registry });
// → allowanceAsset (a did:cid) becomes HEARTHOLD_CONTROL_ALLOWANCE_ASSET for that agent
```

Output: **3 allowance asset DIDs** (one per agent). I can turn this into a turnkey
`scripts/provision-agent-allowance.ts` you run against the node-sovereign wallet — say the word.

## Step 2 — repoint + wire, redeploy all three together  ·  OWNER: Aegis (deploy config)

Per agent, set on its services (Aegis maps to the compose):
- **Warden + Emissary**: `HEARTHOLD_SOVEREIGN_DID = <agent own Sovereign DID>` — the repoint (fixes the
  emissary misconfig; the Warden reads the same var).
- **Agent-signet**: `HEARTHOLD_PARENT_DID = …lbedh4sjij3ufa` and
  `HEARTHOLD_CONTROL_ALLOWANCE_ASSET = <that agent's allowance DID from Step 1>`. (The signet IS the
  Sovereign via its wallet identity, so it doesn't take `HEARTHOLD_SOVEREIGN_DID`.)

Already in place from #38: `HEARTHOLD_GATE_MODE=agent` and `HEARTHOLD_CONTROL_HOST=0.0.0.0` on the signets.

Redeploy the three agents **together**.

## Step 3 — verify

- Each **agent-signet** `GET /api/status` → `controlAllowance.bound: true`, `parentDid` = node,
  `selfApprove` = the decided acts (empty ⇒ present but no acts, `bound:true`).
- Each **emissary** status → `sovereignDid` = its OWN Sovereign (no longer the node).
- **Sevenfold's Table** → composes (signet identity == `sovereignDid`), renders "AI Sovereign ·
  proof-of-agent · **governed** (child, bound)"; no longer root, no `didcommOnly`.
- `npm run e2e:agent-allowance` still green — the model-level regression guard for within/above/deny/forged.

## Rollback

Aegis's per-deploy rollback tag (`hearthold:*-rb-<sha>-pre`). Provisioning is additive config + new signed
assets; reverting the env + redeploying returns to the prior (root) posture, which the honest banner still
describes truthfully.
