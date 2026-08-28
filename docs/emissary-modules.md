# Hearthold — the Emissary as a composable agent (capability modules)

The Emissary began with one job — witnessing observations to the Warden — and has since grown several:
projecting proof requests to the Sovereign, relaying Knowledge Base traffic, and hosting the KB web
portal. Rather than let it become a grab-bag, we give it a shape: a small **runtime** plus **capability
modules** that compose. A deployment is simply a chosen set of modules.

This keeps each capability self-contained and testable, lets one agent be configured for very different
roles, and — importantly — makes an agent's powers **explicit and enumerable** rather than implicit in
its code paths.

## Two directions, one runtime — and the Warden trusts neither

Every module faces one of two ways, and they are **not** the same risk:

- **Inbound (intake / `submit`).** Observe the world and hand it to the Warden — a Web KB reader, a phone
  data intake, a DIDComm inbound reader, a file-system scanner. The runtime seam is `capture`
  (`emissary/src/control.ts`, the `submit` path).
- **Outbound (act / `invoke`).** Present a capability to *do* something in the world — request evidence,
  disclose a fact to a third party (`emissary/src/invoke.ts`; `discloseToForeignVerifier` is an outbound
  act). The security question here is whether the authority — and the `ReleaseContext` behind it — is
  genuine.

The load-bearing rule spans both: **the Warden trusts no Emissary.** Inbound data is *input evidence,
never authority* — classified **on-device, fail-safe to `SEALED`**, and a requester's own description is
never the consent text the human sees (the Warden authors that). Outbound acts carry only a **scoped,
revocable object-capability** and still cross `decideRelease()` at the reference monitor, re-checked at the
point of use. So a module's risk profile governs **blast radius and containment** — an intake module
exposed to hostile input, an outbound module that could over-disclose — but Hearthold's safety does not
rest on the module being honest. That is what lets a high-risk inbound-comms module exist at all: it can
submit garbage (which is sealed and quarantined) but it cannot authorize a disclosure it has no capability
for.

## Skill vs capability module vs object-capability — three layers, not synonyms

The vocabulary around this ("Emissaries? Capabilities? Skills?") collapses three distinct layers. Keep them
separate:

- **Capability module** *(Hearthold — the code).* A self-contained unit on the Emissary runtime that wraps
  one Keymaster capability and declares its DIDComm/HTTP surface + policy. **A deployment is a module
  loadout.** This is the thing you build and enumerate.
- **Object-capability** *(the authority).* The signed, scoped, revocable token a module must hold to touch
  the Warden. Verified at the point of use; attenuation is monotonic; revocation is per-hop, fail-closed.
  A module is code; an object-capability is *permission to run it against a given resource*.
- **Skill** *(AgentPrivacy — the public description).* A content-addressed *card + brief + bodyHash*
  advertising what an agent can do (discovery / reputation — the [skill garden](https://skills.agentprivacy.ai/),
  see `agentprivacy-skills-integration.md`). Their "chain-seal" is trust-on-the-Librarian; the same entry
  carried as a Warden-signed VC is trust-on-the-**issuer**, verifiable offline by anyone.

So "a library of Emissaries" is really a library of **capability modules**, each governed by **Trust
Registry policy** (which may run, for whom, at what assurance), each acting through an **object-capability**,
and optionally advertised to the outside world as a **skill**.

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
| `introspect` | self-describe: identity + enumerable loadout/manifest + bound-node capabilities (`GET /api/introspect`) | **built** (first module) | node-capability discovery |
| `didcomm` | the DIDComm endpoint (send/receive, correlation) | built (base) | DIDComm pack/unpack |
| `capture` | seal + submit observations to the Warden | built | encrypt-to-DID |
| `query` | relay a KB query to the Warden (recall) + its portal face | built | DIDComm relay |
| `proof-relay` | relay proof requests to the Sovereign/Signet | built | challenge/response |
| `auth` | sovereign sign-in — challenge/response login + sessions | built | `createChallenge` / `verifyResponse` |
| `capture:web` | fetch + read web content into the KB (inbound) | planned | `capture` + a web adapter |
| `capture:didcomm-in` | drain inbound DIDComm messages into the KB (inbound) | planned | `capture` + durable-drain reader |
| `capture:phone` | phone / device data intake (inbound) | planned | `capture` + a device adapter |
| `capture:fs` | file-system scanner → derived summary+hash per file → Warden (inbound) | **built** | `capture` + `sealForWarden` |
| `disclose:foreign` | issue + push a signed VC to a non-Archon verifier (outbound) | built (core primitive) | `discloseToForeignVerifier` / `sendCredentialDidComm` |
| `payments` | invoices / zaps | planned | `addLightning`, Lightning |
| `messaging` | direct messages / notifications | planned | `addNostr`, dmail |
| `theming` | name/label mapping for deployer customization (below) | planned | — |

The four `capture:*` rows are the "library of Emissaries" as **inbound module variants** — one `capture`
runtime, different source adapters — each declared in Trust Registry policy with everything-it-submits-is-
untrusted (→ Warden classifies fail-safe `SEALED`). `disclose:foreign` is the sole **outbound** newcomer;
its core primitive shipped (`core/credential-delivery.ts`), and wiring it into a module is the point where a
genuine `ReleaseContext` + pairwise-vs-stable subject choice must be gate-reviewed (see
`blazon-didcomm-disclosure.md`).

**`capture:fs` — the first built `capture:*` variant** (`emissary/src/modules/capture-fs.ts`, CLI
`emissary crawl <dir>`, `e2e:capture-fs`). It walks a directory and, per text file, derives a summary + the
file's structural index (headings / symbol names) + metadata + a `sha256`, seals THAT to the Warden and
submits it as a `WitnessSubmission{kind:'document'}` — **the body bytes never leave the process** (pinned by
`capture-fs.test.ts` and the e2e's decrypt-and-check). It respects the Emissary boundary exactly: it holds a
delegation and submits to the Warden's **personal vault** (born-obsidian, `SEALED`, quarantined until the
Sovereign admits) — it does NOT write a KB space, which needs a member/Sovereign signature. The Warden's
on-device classifier does the sensitivity call; the crawler only proposes. Follow-ups: an Ollama-backed
paraphrasing summarizer behind the same `FileSummarizer` seam; image/PDF adapters; wiring the module into the
live daemon (it runs one-shot today, since `runEmissaryControl` doesn't yet compose `Emissary.routes()`).

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

1. **DONE** — the runtime + module registry now exist as an **additive** seam (`src/module.ts`:
   `CapabilityModule` + `Emissary`), landed alongside the working `runEmissaryControl` (which is untouched)
   rather than extracted from it. `use()` composes and refuses name / route / message-type collisions up
   front; `routes()` and `handler()` feed the merged surfaces to the existing control-server / transport.
   The first module, **`introspect`** (`src/modules/introspect.ts`), ships on it — realizing the
   "explicit and enumerable powers" thesis (`GET /api/introspect` reports the loadout + manifest + node
   capabilities). Covered by `packages/emissary/test/module.test.ts` (registry) and
   `scripts/e2e-emissary-module.ts` (compose + serve, live node).
2. Convert the existing capabilities (`capture`, `query`, `proof-relay`, `auth`) into modules with no
   behaviour change — they already are self-contained, this only formalizes the seam. The durable-drain
   inbound reader (now crash-safe) becomes the `capture:didcomm-in` module.
3. Add new capabilities as modules from the start — beginning with the `auth` module gaining a
   registry-driven assurance step-up (an out-of-band Sovereign approval for higher-stakes actions).
4. Layer in `payments`, `messaging`, and `theming` as the need arises.

No heavy plugin framework for a handful of capabilities — just a clean seam, earned by real modules.
