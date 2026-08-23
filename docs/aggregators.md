# Aggregators — automated, ingest-only feeders of the 7th Capital

**Status:** design doc (2026-08-10). No code yet. Companion to `security-model.md`, `kb-spaces.md`,
`invocation.md`, `evidence-graph.md`.

## 1. What an aggregator is

An **aggregator** is a specialized **Emissary** whose whole job is to *automatically* feed a Sovereign's
Hearthold from one data source — a filesystem, a phone's GPS history, a photo library, a calendar. It is
not the general world-facing companion; it is a narrow, tireless feeder holding a **limited, revocable,
ingest-only** delegation.

The product thesis: give a person real access to their own **7th Capital** — the private history that is
theirs but today lives scattered and surveilled across other people's clouds. Aggregators are how that
history actually *arrives* at the Home Hearthold, where the Sovereign owns it, queries it privately, and
can prove facts from it without disclosing it.

**The gold mine is GPS location history** (§7): a private, on-device replacement for the surveilled
location timeline — plus verifiable movement proofs (tax residency, proof-of-residence, alibi) that no
existing product can offer.

## 2. Reuse map — aggregators are mostly assembly, not invention

Almost every piece already exists:

| Need | Existing seam |
|---|---|
| Authorized to feed the vault | Warden-issued **delegation**; submit refuses without one (`emissary/src/control.ts:175`) |
| Kind-scoped grant | Delegations already carry `kinds` (`warden/src/index.ts:228`, `DelegationStore`) |
| "Trusted device, don't hand-confirm every item" | The autofile trust tier bypasses the ingestion quarantine floor (`warden/src/service.ts:70`, `autofile-store.ts`) |
| Provenance of who observed it | Every artefact stamps `metadata.witness = <aggregatorDid>` (`service.ts:120`) |
| On-device, fail-safe classification | The pluggable `Classifier` interface, fail-safe SEALED (`warden/src/classifier.ts:25`) |
| Transactional feed | `SubmissionReceipt` returned per submission (`core/src/protocol.ts:43`, `service.ts:139`) |
| A location kind | `WitnessKind` already includes `'location'` (`core/src/protocol.ts:19`) |
| Custody scoping | `Artefact.owner` + `scope` (`warden/src/store.ts:18`); partitions / KB spaces (`kb-spaces.md`) |
| Scoped, revocable authority object | The invocation/attenuation capability layer (`invocation.md`) |

**What is genuinely new:** (a) the *ingest-only* role restriction (§3); (b) the **Space** organizing unit
(§4); (c) the phone↔home **sync-and-prune** custody flow (§5); (d) a per-source **connector** seam (§6);
and (e) source-specialized **derivation** — for GPS, stay-points/visits and a location-aware sensitivity
model (§7).

## 3. The core invariant: aggregators are ingest-only

Today an Emissary does *both* halves — `submit` (feed in) **and** `invoke` (request evidence out)
(`emissary/src/invoke.ts`). An aggregator holds **only the submission delegation, never a disclosure
capability.**

> The component with the firehose — your entire GPS trace — is a **one-way valve inward**. It can feed the
> vault; it cannot query it, cannot disclose, cannot be turned into a confused deputy. Disclosure still goes
> the normal route: the Warden's release ladder, the human gate, pairwise DIDs.

This *strengthens* PVM: maximal source access, minimal Hearthold authority. In capability terms the grant is
`{ direction: ingest, kinds: [...], rate, retention }`, revocable by the kill-switch (`invocation.md`).
**Enforcement is structural:** the aggregator role is issued a submission delegation and *no* invocation
capability, and the Emissary daemon in aggregator mode refuses the `invoke` path outright — not by policy,
by not holding the key to it.

## 4. The Space model — one Warden, many source-domains

A **Space** is a *source-scoped data domain under a single Warden's custody.* Phone-GPS is one Space;
Phone-Photos another; the filesystem another. All share the **one Home Warden** (the custodian never
fragments) but each Space carries its own:

- **aggregator DID + ingest delegation** (kind-scoped, revocable, independently);
- **kind-namespace** (e.g. `location`, with sub-kinds `location/fix`, `location/visit`, `location/trajectory`);
- **sensitivity policy** (GPS defaults far higher than, say, public bookmarks);
- **retention & compaction policy** (raw fixes prune aggressively; derived visits persist);
- **derived indexes** (the queryable substrate, §7);
- **isolation for the visible set** — a Space is a partition; recall/forge over it is scoped server-side,
  exactly as `kb-spaces.md` derives the visible set from the authenticated session, never from request content.

Implementation-wise a Space layers on the existing primitives: a partition/space + `Artefact.owner/scope`
+ a kind-scoped delegation. "Space" is the *user-facing* name for that bundle. (Term note: "Sphere" is now
**reserved** for the Archon *publication target* — the `(Gatekeeper URL, registry)` operations anchor onto
(`core/sphere.ts`; see [`terminology.md`](terminology.md)). This app-layer bundle was briefly called a
"Sphere"; it is now called a **space** so the reserved word is never overloaded at the app layer.)

## 5. Custody & sync — raw moves home, sealed + receipted, over a private underlay

**Decision (flaxscrip):** the raw data **moves to the Home Hearthold**. Owning the 7th Capital means
consolidating it where the Sovereign controls it — not leaving the durable archive on the phone or in a
vendor cloud. The phone is a **thin, prunable relay**, not the custodian.

This is also the better security posture against the *realistic* threat. Phones are the most lost, stolen,
and rooted devices in the system; keeping the full trace on the phone maximizes exposure exactly where it's
weakest. Instead:

1. The phone connector buffers source data locally (a rolling window only).
2. On a **cadence** (e.g. every N minutes / on Wi-Fi / on charge), it batches the buffer, **signs** it (its
   aggregator DID) and **seals** it to the Warden's key (`sealForWarden`, `payload.ts`), and submits over the
   existing DIDComm submission path — which returns a `SubmissionReceipt` per batch (`service.ts:139`).
3. **Prune-after-receipt:** the phone deletes buffered raw only once the Warden has acked it stored. Loss of
   the phone exposes at most the un-synced window, never the archive.
4. The **Home Warden is the single custodian**: it holds the sealed raw archive, classifies, derives, and is
   the only place the vault can be queried — through the release ladder.

**Transport layering (reconciles "address by DID" with "over Tailscale"):**
- **DIDComm v2 is the trust boundary.** The payload is sealed to the Warden's DID end-to-end; agents still
  address each other by `did:cid`, never by URL (`transport.ts`). Confidentiality/integrity do **not** depend
  on the network.
- **Tailscale (WireGuard) is the private *underlay*** that lets the phone reach the home node without exposing
  it publicly, and keeps even the sync *metadata* (that a sync happened, the endpoints) off the open internet.
  Defense in depth beneath the sealed DIDComm, not a substitute for it.

**On-device pre-derivation is an optimization, not a boundary.** The phone MAY compact before sync (drop
stationary duplicate fixes, coalesce a dwell into one candidate visit) purely to cut bandwidth — but the raw
(sealed) still lands home so the Warden can re-derive with better models later. The privacy boundary is the
*seal + receipt + home custody*, not "did raw leave the phone."

## 6. The connector seam

One small, pluggable interface on the Emissary/aggregator side:

```
SourceConnector:
  subscribe()/poll() -> normalized SourceRecord[] -> artefacts of a declared kind
  declares: emitted kind(s) · default sensitivity floor · native platform · compaction hint
  does NOT classify · does NOT disclose · does NOT derive authority — it normalizes + submits
```

Filesystem indexer, GPS, photos, calendar, email, wearables each become a connector emitting a Space's
kinds. The Warden classifies + custodies + derives, unchanged. Connectors are the only platform-specific
code; everything downstream is shared.

## 7. GPS — the gold mine, in depth

### 7.1 The derivation pipeline (Home Warden, on-device)
```
raw fixes (sealed archive)
  → stay-point clustering (dwell ≥ t within radius r)
  → visits (place + arrival/departure + dwell)
  → places (recurring stay-points: home, work, gym, clinic…)
  → trajectories (trips between places)
  → the queryable INDEX  ── recall & evidence run over THIS, never the raw trace
```
Artefact granularity = **per visit / per trip, not per fix.** Compaction is mandatory: a fix every few
seconds is not 86,400 artefacts/day.

### 7.2 Location-aware sensitivity, fail-safe
The classifier gains a location specialization: geofences around **home / health / place of worship /
political or protest sites** auto-elevate to **SEALED**; an unrecognized place fails safe to SEALED; a
mundane midday café can be LOWer. Sensitive-place inference must fail *toward* protection.

### 7.3 Two value propositions
- **Private recall (the popular app):** your own location timeline — "where was I last March, what's my
  commute, how often the gym" — served on-device from the derived index, the data never leaving your Warden.
  A Google-Timeline replacement whose whole pitch is that *you* hold it.
- **Verifiable movement proofs (the differentiator, the Archon showcase):** issuer-attested facts *without*
  the trace, via the evidence graph + selective disclosure:
  - **Tax residency** — "in-country ≥ 183 days in FY" without the itinerary.
  - **Proof-of-residence** — "resident of district D" for KYC/services without your address history.
  - **Alibi / negative location** — "was NOT within radius of X at time T."
  - **Insurance telematics** — "drove < N miles," "never sped in the school zone," without the routes.
  - **Loyalty / attendance** — "visited N partner stores," "attended the event."
  Machine-witnessed (`metadata.witness = gps-aggregator`) location is *stronger* evidence than a human
  assertion — the provenance is in the graph.

### 7.4 The hard one: negative proofs
"I was *not* there" is provable but needs more than selective reveal: it requires a **completeness
commitment** over the window (the Warden commits to the full trace, then proves the absence against that
commitment) so a verifier knows nothing was hidden. Design this deliberately; don't hand-wave it. It's also
the most valuable class (alibi, "didn't enter the restricted zone").

## 8. Honest residuals

- **Source-level compromise is outside Hearthold's boundary.** A malicious OS-level connector could exfiltrate
  at the source, before ingestion — the same class as the rooted-governor residual (`security-model.md`). What
  Hearthold guarantees: the aggregator's authority *inside* Hearthold is ingest-only, kind-scoped,
  provenance-stamped, and revocable; the archive is sealed to the Warden and derived on-device; the phone is a
  prunable relay, not a durable store.
- **The phone's un-synced window** is the residual exposure on device loss — bounded by the sync cadence and
  prune-after-receipt, and it should be encrypted at rest on the phone too.
- **Derivation quality** (stay-point/place inference, sensitive-place geofencing) is a correctness surface;
  errors bias toward SEALED by policy.

## 9. Invariants (don't trade these away)

- **Ingest-only.** An aggregator holds a submission delegation and *no* disclosure capability. Structural.
- **No disclosure without the ladder.** Aggregators never emit evidence; every disclosure crosses
  `decideRelease()` with the human gate and pairwise DIDs, unchanged.
- **On-device.** Classification and derivation run on Hearthold-controlled devices; raw content is only ever
  sealed-in-transit and sealed-at-rest; nothing leaves for a third party.
- **Deny-by-default ingestion.** Untrusted submissions quarantine (SEALED) until the Space's aggregator is
  autofile-trusted; a missing classifier fails everything to SEALED.
- **Revocable per Space.** Killing a Space's aggregator delegation stops the feed immediately and severs
  any authority derived from it.

## 10. Phasing

- **P0 — this doc + the class.** Ingest-only role, Space definition, connector seam, sync/prune protocol,
  sensitivity model. (No behavior change.)
- **P1 — the aggregator role + generic connector.** Ingest-only Emissary mode (refuses `invoke`); the
  `SourceConnector` seam; **filesystem indexer** as the simplest first connector (no sensor/custody split).
  e2e: delegate → auto-file → recall → revoke → feed stops.
- **P2 — the GPS vertical.** Location connector; sync-and-prune over sealed DIDComm (+ Tailscale underlay);
  on-device derivation (stay-points → visits → places → index); location-aware sensitivity. e2e: ingest a
  synthetic trace → private recall → SEALED on a clinic geofence.
- **P3 — verifiable movement proofs.** Evidence over the location index: residency-days, was/was-not-at,
  proof-of-residence. Includes the completeness-commitment for negative proofs. The Archon showcase.
- **P4 — more Spaces.** Photos, calendar, wearables reuse P1's seam.

## 11. Open questions

1. **Naming** — resolved: the app-layer bundle is a **space**; "Sphere" is reserved for the Archon publication target (§4).
2. **On-phone pre-derivation** — how much, if any, before sync? (bandwidth vs re-derivability tradeoff, §5)
3. **Negative-proof commitment** — completeness-commitment scheme + window semantics (§7.4).
4. **Sensitive-place geofences** — user-declared, inferred, or both; how to review/correct them (§7.2).
5. **Retention** — default raw-archive retention vs derived-index retention per Space (§4).
6. **Phone platform** — iOS/Android background-location constraints shape the connector and cadence (§6).
