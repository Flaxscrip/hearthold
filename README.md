# Hearthold

> A Sovereign First Person's **7th Capital** — their accumulated personal history — made safely *liquid*:
> prove a fact from your data without disclosing the data behind it.

Hearthold is an application layer built on [Archon](https://github.com/archetech/archon) `did:cid`
identity infrastructure. It gives a person a home-bound **custodian** agent for their private data history,
and a world-facing **companion** agent that can request *verifiable evidence* from that history — attesting a
fact to a third party while the raw data never leaves home.

One principle runs through the whole design, drawn from the
[Privacy Is Value Model](https://github.com/mitchuski/cityofmages): **separate the custodian of data from the
agent that acts in the world**, so no single party can reconstruct the whole. Authority to act is never a
role or a standing permission — it is a **signed, scoped, revocable capability object** (Alan Karp's
object-capability model), verified at the point of use.

## The four roles

Each is a `did:cid` with its own Keymaster wallet, custodied independently of the Archon node.

| | Role | Holds |
|---|---|---|
| **Warden** 🛡️ | Home **Keeper** — custodian & enforcer, a local-only AI that reasons on-device. Stores the vault, classifies artefacts, serves evidence, and is the **reference monitor** every disclosure crosses. | The full private vault |
| **Emissary** 👁️ | **Companion** — observes local context and submits it home; later invokes a capability to request evidence and presents it to third parties. | A scoped, revocable delegation |
| **Sovereign** 🔑 | The **principal**, held by the **Signet** 2nd-factor app. Signs the Warden's policy (Ruleset) and co-signs sensitive disclosures with a proof-of-human assertion. | The root of authority |
| **Verifier** ✅ | A third party that requests and checks a proof. Trust rests on the **issuer's signature**, never the Warden's word. | Nothing — it only verifies |

The Warden enforces; the Sovereign authorizes the rules; the Emissary acts under delegation; the Verifier
trusts only signatures. Control plane (Sovereign) is separated from data plane (Warden) throughout.

## Authority is a signed object, not a role

Hearthold implements object-capability **invocation** to Karp's four criteria — a capability can be *held*,
*attenuated*, *invoked*, and *revoked*:

- **Mint** — the Sovereign issues a root capability to an agent (Signet-gated).
- **Attenuate & delegate** — a holder delegates a **narrower** slice onward (a multi-hop chain). Attenuation is
  monotonic *by construction*: a delegate can only shrink authority, never widen it, so over-reach is
  unrepresentable — there is no confused deputy.
- **Invoke** — the holder presents the chain; the owner's Warden verifies it end-to-end (attenuation,
  delegator-binding, per-hop revocation, human gate) and mints issuer-attested evidence.
- **Revoke** — a per-hop kill-switch; revoking any ancestor kills its whole subtree at the next invocation.

A governing Sovereign can *watch* the resulting authority graph in real time — the delegation forest and the
message flow — seeing **who holds what and who invoked what, never the content**. See
[docs/invocation.md](docs/invocation.md), [docs/multihop-delegation.md](docs/multihop-delegation.md), and
[docs/invocation-dashboard.md](docs/invocation-dashboard.md).

## The core loop

```
Emissary ──observe──► seal in-band ──► Warden unseals → classifies on-device → stores (sealed at rest)

Prove something ──► Emissary INVOKES a held capability ──► Warden verifies the capability chain,
steps up (PIN / Sovereign co-sign) for sensitive content ──► mints a signed EVIDENCE GRAPH
──► Emissary presents it ──► a Verifier checks it against the issuer DIDs
```

Disclosure is **issuer-attested**: the Warden derives and signs the fact, carrying provenance as content
hashes ([docs/evidence-graph.md](docs/evidence-graph.md)). Hearthold never emits a reputation score — only a
verifiable, decomposable evidence graph. Every disclosure crosses a deny-by-default release ladder, and
sensitive content requires the owner's fresh proof-of-human at their Signet.

## Layout

```
packages/
  core/          @hearthold/core — shared library: identity, security model, wire protocol,
                 DIDComm transport, capabilities/attenuation, evidence graph, pairwise DIDs, KB
  warden/        home Keeper — control plane, on-device classifier seam, vault store, enforcement
  emissary/      world-facing companion — observe/submit + invoke/present
  sovereign/     the principal + Signet gate (proof-of-human / AgentGate)
  verifier/      third-party proof checker
  registry/      trust registry / directory
  a2a-gateway/   edge adapter translating A2A ⇄ internal DIDComm (holds no secrets)
  agent-mcp/     an MCP server exposing each agent's control plane to a restricted AI
  cgpr-types/    Consent-Gated Preference Request schemas
  control-types/ shared control-plane DTOs
apps/            Vite front-ends: emissary, kb-portal, signet-approver, warden-console
docs/            architecture, security-model, invocation, evidence-graph, capabilities-governance,
                 standards-alignment, PLAN, ROADMAP …
scripts/         end-to-end + demo flows (run with node --experimental-strip-types)
```

## Build

Requires **Node ≥ 22**. TypeScript monorepo (npm workspaces + project references, ESM throughout).

```bash
npm install
npm run build      # tsc --build across all packages
```

There is no unit-test runner; verification is via end-to-end scripts in `scripts/*.ts` that exercise real
flows against a live Archon node (Drawbridge on `:4222`, with the `didcomm` profile). See
[docs/manual-testing.md](docs/manual-testing.md) for the full two-terminal walkthrough.

```bash
export HEARTHOLD_PASSPHRASE='any-dev-pass'
npm run e2e                 # the spine: delegation handshake + submit → store → receipt over DIDComm
npm run e2e:prove-didcomm   # the full prove flow with the Signet step-up
```

## Status

Live and tested end-to-end: identity provisioning; the delegation handshake and observe → store → receipt
loop over **Archon DIDComm v2**; **on-device classification** (local Ollama, fail-safe to `SEALED`); the
issuer-attested **evidence-graph prove flow** with the Signet step-up; and the full **object-capability
invocation** layer — mint-root, multi-hop attenuated delegation, point-of-use verification, per-hop
revocation, and the real-time authority watch — verified live across a multi-agent family. See
[docs/ROADMAP.md](docs/ROADMAP.md) and [docs/invocation.md](docs/invocation.md).

## Design docs

- [docs/architecture.md](docs/architecture.md) — components, identities, transport, data flow
- [docs/security-model.md](docs/security-model.md) — sensitivity × authorization × disclosure modes
- [docs/invocation.md](docs/invocation.md) — the object-capability invocation & attenuation model
- [docs/evidence-graph.md](docs/evidence-graph.md) — the proof object: shape, hashing, verification
- [docs/capabilities-governance-tbac.md](docs/capabilities-governance-tbac.md) — Hearthold vs. the
  enterprise TBAC governance agenda (Janssen / Linux Foundation)
- [docs/standards-alignment.md](docs/standards-alignment.md) — alignment with IETF / IAM standards
- [docs/PVM-MAPPING.md](docs/PVM-MAPPING.md) — mapping to the Privacy Is Value Model

## Attribution

Hearthold builds on [Archon](https://github.com/archetech/archon) and on the **Privacy Is Value Model** /
**City of Mages** work ([mitchuski/cityofmages](https://github.com/mitchuski/cityofmages)), from which it
takes the principle of separating the custodian of data from the agent that acts in the world.

## License

MIT.
