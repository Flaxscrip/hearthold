# Hearthold security & privacy posture — layered audit plan

**Status:** OPENING the review (2026-07-27). Driven by flaxscrip; Hearthold dev AI is the first contributor;
network/deployment layers delegate to **Aegis AI** (built the isolated container work + the deployment-layer
gatekeeper seal). Goal: **secure and private BY DEFAULT at every layer**, with each layer's owner named.

The thesis we're testing: Hearthold's **application/protocol** layer is strong (deny-by-default release
ladder, PVM separation, pairwise DIDs, B6/DMZ, co-sign, require-session). The exposure is **below** it — a
default config or a transport/network misconfig can turn a metadata/LOW disclosure into real exposure while
every app-layer proof still holds. Defense-in-depth means the safe posture must be automatic at *each* layer,
not resting on one bind flag or an operator remembering an env var.

## The layer map (the spine of the audit)

| # | Layer | What lives here | Primary owner |
|---|---|---|---|
| L1 | **Identity & key custody** | wallet passphrase, key-at-rest, rotation, Signet 2nd-factor, ephemeral keys | Hearthold + operator |
| L2 | **Application / disclosure** | `decideRelease()` ladder, classification (fail-safe SEALED), selective disclosure, pairwise DIDs, co-sign, guardianship | Hearthold |
| L3 | **Control-plane HTTP** | Warden `:4310`, Signet `:4311`, Emissary `:4312`, portal `:4313` — auth, bind host, CORS, sessions | Hearthold |
| L4 | **Gatekeeper / Archon HTTP** | DID resolve/deref, admin routes, import, L402 | Archon (macterra) + deployment |
| L5 | **Gossip / registry** | hyperswarm topics, "holding is republishing", registry choice, anchoring | Hearthold defaults + Archon + deployment |
| L6 | **Deployment / network** | `internal:true`, egress isolation, loopback bridges, the deploy-layer gatekeeper seal, Tor fallback | **Aegis** + operator |

## The near-term deliverable: a secure-by-default config table

The fastest, highest-value output. For every config default, is the safe value the default? First pass
(grounded against `packages/core/src/config.ts` + `control-server.ts`):

| Knob | Current default | Secure/private by default? | Note / candidate change |
|---|---|---|---|
| `HEARTHOLD_REGISTRY` | was `hyperswarm` → **now `local`** | **YES (fixed)** | **RESOLVED at the Hearthold layer** (`config.ts` + `.env.example`): `local` is DB-only, never gossiped, so private data can't propagate regardless of the node's topic. The keymaster's `defaultRegistry` = this, so it flows through every op (issuance included) — the sandbox already ran the full credential flow offline on `local`. Publishing is a deliberate opt-in. Archon's reference node stays public `hyperswarm`; **we do not change Archon** — Hearthold just doesn't inherit its default. |
| Node `ARCHON_PROTOCOL` topic | Archon default `/ARCHON/v0.8-beta` (public) | N/A by default | Only matters if you **opt into** `hyperswarm`. Then the node's topic decides reach: a private random topic (`openssl rand -hex 32`, as Aegis mints) = a private channel; the shared default = the public network. This is deployment/node config (Aegis/operator), documented in the Hearthold deployment docs, not enforced in Archon. |
| `HEARTHOLD_CONTROL_HOST` | `127.0.0.1` | YES | Loopback-only default (added this session). Keep; Signet must stay loopback *always*. |
| `HEARTHOLD_REQUIRE_SESSION` | derived (on for multi-member) | YES | Safe-by-construction; lockout warning now fires at startup. |
| CORS on the control plane | was `Access-Control-Allow-Origin: *` | **YES (fixed)** | **RESOLVED** in `startControlServer`: reflects only an allow-listed origin (loopback any-port + `HEARTHOLD_CONTROL_ALLOW_ORIGIN` extras), **refuses a cross-origin browser request server-side** (403, anti-CSRF), and **refuses a rebound `Host`** (403, anti-DNS-rebinding — which CORS alone can't stop). Never `*`. Threaded into all four daemons; the public KB-portal Mage allow-lists its own `publicUrl` origin. `e2e:control-cors` (10/10). |
| `HEARTHOLD_DOCKER_NETWORK` (compose) | was hardcoded `archon_default` → **now required, no default** | **YES (fixed)** | `archon_default` is the generic name a regular Archon compose creates (an EGRESS bridge shared with regular nodes); Hearthold silently joining it = public-net + shared exposure. Now the compose **refuses to start** until the operator names the ISOLATED node network (`internal:true`) deliberately. Aegis coordination: their tooling sets it (they already use per-node names like `aegisb_default`). |
| Classifier unavailable | fail-safe → `SEALED` | YES | On-device, fails safe. Keep. |
| `sessionTtlMs` | 30 min, absolute | YES (probably) | Absolute expiry, never slid. Confirm TTL is right for the threat model. |
| `ephemeralRegistry` | = `registry` (so `hyperswarm` by default) | inherits L5 | Ephemeral challenge/response DIDs gossip if `registry` does; ties to the `local`-default decision. |
| Wallet passphrase | `HEARTHOLD_PASSPHRASE` (env) | audit | How is it sourced/handled? env in cleartext, per-process. Review at-rest + prompt options. |

Completing + deciding this table is the concrete goal of the first working session.

## Per-layer audit questions (what each deep-dive answers)

- **L1 — custody.** Passphrase at rest & sourcing; are private keys ever in a browser (they must not be —
  confirm the Table stays keyless, keys in the Signet)? Rotation story (rotation-safety proven; is it
  operationalized?). ephemeralRegistry consistency.
- **L2 — disclosure.** Is *every* egress path through `decideRelease()` (the PVM-BOUNDARIES B-suite formalized
  some of this — extend it)? Any classification bypass? Do error/"not available" responses stay uniform (no
  existence leak — the G-grade obsidian pattern)? Metadata in evidence graphs (pairwise linkage excluded)?
- **L3 — control-plane HTTP.** The CORS/CSRF surface above; is the session token ever loggable (must not be);
  are all scoped routes actually behind `effectiveViewer` (require-session); is the Signet daemon loopback-
  locked in code, not just deployment; portal `:4313` exposure.
- **L4 — gatekeeper HTTP.** The **read-gating gap**: unauthenticated `GET /api/v1/did/:did` → 200 and
  `/1.0/identifiers` open by design (`DRAWBRIDGE-GROUNDING.md` finding #1). Decide what Hearthold may *assume*
  about the gatekeeper's transport auth, and what must be sealed below (Aegis). Confirm import stays
  admin-gated + DMZ-confined (B6).
- **L5 — gossip/registry.** The `hyperswarm` default (above); "holding is republishing" (importing a foreign
  DID re-broadcasts it — B6 addresses the DMZ case, audit the rest); per-node topic as the only isolation
  mechanism; registry hygiene guardrails (assert-`local` in tests already exists — generalize to a runtime
  guard?).
- **L6 — deployment/network (Aegis).** `internal:true` + egress isolation as the default; the loopback
  bridges; the **deploy-layer gatekeeper guard** (403 for import/admin/enumerate/bulk-export) — generalize it
  into a documented, default-on posture; Tor onion fallback trust; how a misconfig (a bridge added,
  `internal:true` relaxed) is detected.

## Cross-cutting (spans layers)

- **Interest leakage:** resolving a DID reveals *which* DIDs we care about — metadata leaves even when
  content doesn't (`DEPLOYMENT.md`). Map where this matters.
- **Existence leaks:** "not available" must be indistinguishable from "refused" (G-grade). Audit uniformly.
- **Logging discipline:** tokens/keys/seeds never logged; activity metadata is itself a disclosure (SSE
  audience filtering already does this — verify no path bypasses it).
- **Timing / side channels:** lower priority; note, don't chase yet.

## Ownership & delegation

- **Hearthold (this AI):** L1–L3 + L5 *defaults*, and the *assumptions* each higher layer makes about the
  lower ones. Owns the secure-by-default config table and the threat-model doc.
- **Aegis AI:** L6 (deployment/network) + the network-seal complement to our type/app guarantees.
  **DELIVERED (2026-07-27):** all four asks closed and **Sentinel** (`deploy/sentinel/sentinel.sh`) is the
  live L6 instrument — active-probe drift detection across dims 1–6, with a signed, tamper-evident posture
  attestation. The L6 secure-by-default rows are in `~/isolation/aegis/AEGIS-L6-AUDIT-ROWS.md` (folded below).
  **First live sweep of the rebuilt deployment (`AEGIS-SENTINEL-REPORT-megaflax.md`): 35 PASS · 27 WARN ·
  0 FAIL → AT RISK, but 0 proven exposures.** The *provisioned* Hearthold nodes (`aegis`, `aegisb`, and the
  `archon_default` net running warden/sovereign/emissary/verifier) are clean — `internal:true`, egress
  `ENETUNREACH`, **registry `local` (our L5 default proven live)**, 64-char admin keys, passphrase set, control
  plane + Signet loopback-only, gatekeeper seal proven (sphere `enumerate=403 import=403`). The AT RISK is
  driven entirely by *dev-grade* study nodes that bypass `setup-node.sh` (sample `measure-key`/`measure-pp`,
  a stock bulk-gossip mediator, a blank-key ephemeral DMZ gatekeeper on loopback) — Aegis-side follow-ups,
  not our posture. Coordinate via the `~/isolation/aegis` note channel.

### L6 secure-by-default rows (owner: Aegis; from `AEGIS-L6-AUDIT-ROWS.md`, verified live by Sentinel)

| # | Knob / control | Default (Aegis provisioning) | Safe? | Verified by |
|---|---|---|---|---|
| L6.1 | network `internal:` | `true` | ✅ egress `ENETUNREACH` | Sentinel dim 1 (egress probe) |
| L6.2 | `HEARTHOLD_DOCKER_NETWORK` | required; `hearthold-up.sh` refuses a non-`internal` net | ✅ | dims 1 & 4 |
| L6.3 | `ARCHON_PROTOCOL` topic | `/aegis-private/$(openssl rand -hex 32)` per install | ✅ never public | dim 5 (when gossip present) |
| L6.4 | `ARCHON_GATEKEEPER_REGISTRIES` | `local` (mirrors our `HEARTHOLD_REGISTRY=local`) | ✅ no gossip | dim 5 (registry-first) |
| L6.5 | gatekeeper seal (guard) | default-on; tailnet publishes only via resolution-only guard | ✅ by construction | dim 3 (resolve 200 / enum 403 / import 403) |
| L6.6 | control bind (`HEARTHOLD_CONTROL_HOST`) | loopback `127.0.0.1` | ✅ | dim 2 (probes our L3 guard) |
| L6.7 | Signet exposure | loopback-only **always** | ✅ | dim 2 (non-loopback ⇒ CRITICAL) |
| L6.8 | `ARCHON_ADMIN_API_KEY` | unique per install | ✅ (provisioned) | dim 6 (blank/weak/sample flagged) |
| L6.9 | mediator (if gossip opted in) | `aegis-secure-mediator` (peer-auth + scoped) | ⚠ stock bulk-gossips | dim 5 (stock vs secure image) |
| L6.10 | misconfig detection | Sentinel (on-demand + `--watch` + signed attestation) | ✅ this row *is* the verifier | — |

The registry-first invariant Aegis named (our refinement #1): **`hyperswarm` is local-only iff `ARCHON_PROTOCOL`
is a private random topic** — `registries=["local"]` ⇒ PASS (topic irrelevant); a gossip registry present ⇒
the topic check bites. So a `local` node is never false-failed on a stale topic, and a gossip node can't hide
a public one. Cross-layer knob that touches us: `HEARTHOLD_DIDCOMM_ENDPOINT` (`transport.ts:81`) overrides the
node's advertised endpoint in-network — set it where a node advertises a non-resolving host (else DIDComm 502).
- **Archon / macterra:** L4 gatekeeper transport auth (the read-gating gap), registry semantics. Escalate,
  don't work around (as with the `verifyOperation` / peer-fallback items).

## Process / phasing

1. **This session (opened):** the layer map + the secure-by-default table + owners. ← you're reading it.
2. **L3 + L5 quick wins (Hearthold):** the two biggest default gaps — CORS/CSRF hardening on the control
   plane, and the `local`-default registry decision (the one with real resolvability trade-offs — needs a
   design call before changing).
3. **Threat model doc** (`docs/threat-model-layers.md`): adversaries per layer (rooted box, malicious web
   origin, a peer on a shared topic, a curious household member, a compromised browser) × what each layer
   guarantees. Extend the PVM-BOUNDARIES suite to encode the new invariants.
4. **Aegis hand-off:** an `HEARTHOLD-ASK-network-defaults` note — generalize the deploy-layer seal + egress
   defaults; report their posture back to fold into the table.
5. **Per-layer deep dives** (L1, L2, L4) as follow-ups.

**Guiding rule for every decision:** the default must be the safe one, and the safe posture must be automatic
at that layer — never "safe only if the operator remembers a flag or the deployment stays perfect."
