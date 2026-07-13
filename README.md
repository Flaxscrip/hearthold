# Hearthold

> A Sovereign First Person's **7th Capital** — their accumulated personal history — made safely *liquid*.

Hearthold is a user application built on [Archon](https://github.com/archetech/archon) `did:cid`
identity infrastructure. It gives a person a privileged, home-bound agent to manage an ever-growing
private data repository, and a mobile companion agent authorized to request **verifiable evidence**
from that history when engaging with the world — proving a fact without spilling the data behind it.

It draws on the [Privacy Is Value Model and City of Mages](https://github.com/Flaxscrip/cityofmages)
work for one principle: **separate the custodian of data from the agent that acts in the world**, so
neither alone can reconstruct the whole.

## The three identities

Each is a `did:cid` with its own Keymaster wallet, custodied independently of the Archon node.

| | Role | Runs | Holds |
|---|---|---|---|
| **Warden** 🛡️ | Home **Keeper** — custodian & enforcer. A **local-only AI**: reasons on-device, nothing transmittable. Stores the vault, classifies, serves evidence. | Always-on, home-bound (e.g. behind Tailscale) | The full private vault |
| **Emissary** 👁️ | **Companion** — witnesses local-only context (location, browsing) and submits it home; later requests evidence and presents it to third parties. | Mobile — CLI now; browser & phone later | Minimal data; a revocable delegation |
| **Sovereign** 🔑 | The **principal**, held by the **Signet** app (a 2nd-factor authenticator). Signs the Warden's access-control policy and co-signs sensitive disclosures with a proof-of-human assertion. | Separate device | The root of authority |

The Warden enforces; the Sovereign authorizes the rules; the Emissary acts in the world under a
scoped, revocable delegation. Control plane (Sovereign) is separated from data plane (Warden).

## The core loop

```
Emissary  ──observe──►  seal in-band  ──►  Warden unseals → classifies → stores (sealed at rest)
                                                                              │
You need to prove something  ──►  Emissary requests evidence  ──►  Warden checks authorization,
steps up (PIN / Sovereign co-sign) for sensitive content  ──►  returns a signed EVIDENCE GRAPH
──►  Emissary presents it; a third party verifies against the issuer DIDs
```

Disclosure is **issuer-attested**: the Warden derives and signs the fact, with provenance carried
as content hashes (see [docs/evidence-graph.md](docs/evidence-graph.md)). Hearthold never emits a
reputation score — only a verifiable, decomposable evidence graph.

## Layout

```
packages/
  core/      shared library: identity, security model, protocol, transport, credentials
  warden/    home Keeper: HTTP service, classifier seam, vault store
  emissary/   Companion CLI: witness capture + evidence requests
docs/
  PLAN.md                phased plan & milestones
  architecture.md        components, identities, transport, data flow
  security-model.md      sensitivity × authorization tiers × disclosure modes
  evidence-graph.md      the proof object: exact shape, hashing, verification
  sovereign-signet.md    the Sovereign DID & Signet app (control plane, proof-of-human)
  standards-alignment.md review vs IETF OAuth transaction-challenge draft (R1–R5)
  manual-testing.md      how to launch & exercise what's built
```

## Status

Working and tested live: identity provisioning, the delegation handshake, the witness → store →
receipt loop over **Archon DIDComm v2** (`Transport` seam in `packages/core/src/transport.ts`),
and **on-device sensitivity classification** (local Ollama model, fail-safe to `SEALED`). Next: the
evidence-graph "prove" flow. See [docs/PLAN.md](docs/PLAN.md) and
[docs/manual-testing.md](docs/manual-testing.md).

## Attribution

Hearthold builds on [Archon](https://github.com/archetech/archon) and on the **Privacy Is Value Model**
and **City of Mages** work — [github.com/Flaxscrip/cityofmages](https://github.com/Flaxscrip/cityofmages)
(upstream [mitchuski/cityofmages](https://github.com/mitchuski/cityofmages), the agentprivacy
collaboration) — from which it takes the principle of separating the custodian of data from the
agent that acts in the world.

## License

MIT.
