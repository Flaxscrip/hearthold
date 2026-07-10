# Hearthold — the Emissary as a composable agent (capability modules)

The Emissary began with one job — witnessing observations to the Warden — and has since grown several:
projecting proof requests to the Sovereign, relaying Knowledge Base traffic, and hosting the KB web
portal. Rather than let it become a grab-bag, we give it a shape: a small **runtime** plus **capability
modules** that compose. A deployment is simply a chosen set of modules.

This keeps each capability self-contained and testable, lets one agent be configured for very different
roles, and — importantly — makes an agent's powers **explicit and enumerable** rather than implicit in
its code paths.

## The shape

- **Emissary runtime (base).** A `did:cid` identity, a DIDComm endpoint, a serve loop, an HTTP
  control/portal server, and a module registry. It knows nothing about any specific capability — it just
  hosts modules and routes traffic to them.
- **Capability module.** A self-contained unit that registers: (a) the DIDComm message types it handles,
  (b) any HTTP routes it exposes, (c) the Keymaster capability it wraps, and (d) its own policy/config.
  Modules don't reference each other; they compose only through the runtime.
- **A deployment is a module loadout.** The KB portal Emissary loads `auth` + `query`; a capture-focused
  Emissary loads `capture` + `proof-relay`. Same runtime, different powers.

## Module interface (sketch)

```ts
interface CapabilityModule {
  name: string; // plain and specific: "auth", "query", "capture", "proof-relay", …
  messageHandlers?: Record<string, (msg, fromDid) => Promise<Reply | null>>; // DIDComm
  httpRoutes?: Record<string, HttpHandler>; // for web-facing modules
  init?(ctx: WitnessContext): Promise<void>; // access to identity, transport, config
}

class Emissary {
  use(module: CapabilityModule): this;
  serve(): Promise<void>; // runs DIDComm + HTTP, dispatching each message/route to its module
}

// e.g. the KB portal:  new Emissary(id, transport).use(auth).use(query).serve()
```

## Modules — today and planned

| Module | What it does | Status | Underlying Keymaster capability |
|---|---|---|---|
| `didcomm` | the DIDComm endpoint (send/receive, correlation) | built (base) | DIDComm pack/unpack |
| `capture` | seal + submit observations to the Warden | built | encrypt-to-DID |
| `query` | relay a KB query to the Warden (recall) + its portal face | built | DIDComm relay |
| `proof-relay` | relay proof requests to the Sovereign/Signet | built | challenge/response |
| `auth` | sovereign sign-in — challenge/response login + sessions | built | `createChallenge` / `verifyResponse` |
| `payments` | invoices / zaps | planned | `addLightning`, Lightning |
| `messaging` | direct messages / notifications | planned | `addNostr`, dmail |
| `theming` | name/label mapping for deployer customization (below) | planned | — |

Each capability has a reference implementation in the Archon web/react-native wallet, so building a
module is: wrap a proven Keymaster capability, give it a DIDComm and/or HTTP face, and attach its policy.

## Capabilities as governed policy

Which modules an Emissary may run — and for whom, and at what assurance — is **Trust Registry policy**, not
hardcode. This extends the registry's authorization answer from a bare boolean to
`{ authorized, requiredAssurance }`, evaluated per `(action, resource)`. Governance declares an agent's
capabilities and the assurance each action demands; the Emissary runtime enforces it (e.g. escalating to
an out-of-band Sovereign approval when policy requires a higher tier). This is the authorization spine
for accountable agent identity: an agent's powers are declared and auditable, and each consequential
action can require a fresh human authorization.

## Theming — customization without forking

The core uses **neutral, technical names** for its components and labels. A **theming** module maps those
names to a deployer's own vocabulary, so the same code serves different domains — a research group's
shared knowledge base, a privacy product with its own lexicon — without forking the implementation. The
agent core stays neutral and reference-quality; the vocabulary is a configuration layer applied at the
edges (labels, UI copy, public-facing terms). Theming lives mainly at the front-end/face layer; the
protocol and the module names underneath do not change.

## Front-ends are separate faces

Browser apps — such as the KB portal UI — are **faces** over the web-facing modules: a different runtime,
no keys, no identity, talking to a module's HTTP routes. They are not modules themselves. Theming applies
here too. Keeping faces separate from the agent runtime is what let the KB portal drop all key handling
and shrink to a thin client.

## Path (incremental, not a framework)

1. Extract the runtime + module registry from the current Emissary.
2. Convert the existing capabilities (`capture`, `query`, `proof-relay`, `auth`) into modules with no
   behaviour change — they already are self-contained, this only formalizes the seam.
3. Add new capabilities as modules from the start — beginning with the `auth` module gaining a
   registry-driven assurance step-up (an out-of-band Sovereign approval for higher-stakes actions).
4. Layer in `payments`, `messaging`, and `theming` as the need arises.

No heavy plugin framework for a handful of capabilities — just a clean seam, earned by real modules.
