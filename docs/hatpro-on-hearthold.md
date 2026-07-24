# HATPro on Hearthold — a planned demo use case

A target application of Hearthold, to build once the system is more complete: the **DIF
Hospitality & Travel Profile (HATPro)** "Travel Delay" scenario, with the **Traveler as a
Sovereign** and the Emissary + Warden automating the Traveler Profile.

**Sources:** the Travel Delay demo PDF (DIF H&T WG, Feb 2026, Saucier & GenitriX) ·
`~/Projects/hatpro-archon` (a working HATPro reference impl on Archon) · `archon-trust-registry`
(ToIP TRQP).

## Verdict: yes — and it *completes* the existing hatpro-archon impl

`hatpro-archon` already runs the **credential + prove side** on Archon — `createChallenge →
createResponse → verifyResponse` (our prove flow), HATPro schemas, self-issued profile VCs,
third-party issuer VCs (Over-18, Loyalty), and a **TRQP Trust Registry**. Its own stated gaps are
*exactly* Hearthold's strengths:

| hatpro-archon gap | Hearthold supplies |
|---|---|
| no AI-agent identity / present-on-behalf | the **Emissary** (projects under scoped delegation) |
| no private vault (creds in browser WalletWeb) | the **Warden** (sealed, classified vault = the Profile) |
| transport = dmail (leaky notices) | **DIDComm v2** |
| no human-approval gate | the **Signet** (= HATPro's `confirmAbove` threshold) |
| composition-level disclosure only | finer **selective disclosure** (prove over-18 w/o DOB) |

## Actor & credential mapping

| HATPro | Hearthold |
|---|---|
| **Traveler** (owns the profile) | **Sovereign** |
| **AI Travel Agent (VTA)** — *manages profile* | **Warden** (custodies the vault) |
| **AI Travel Agent (VTA)** — *presents / coordinates* | **Emissary** (projects under delegation) |
| Airline / Hotel / Restaurant | third-party **issuers** + **verifiers** (registry-authorized) |
| Traveler Profile (portable sovereign store) | the **vault** (issued + self-attested leaves) |
| Self-attested prefs (Diet/Room/Accessibility VEC) | **Sovereign self-issued** VC (`witnessed` class) |
| Third-party docs (Travel Doc, Reservations) | **`issued` leaves** (accept-credential) |
| Delegation VRC (scoped: allow/deny/actions/limits/`confirmAbove`) | **scoped delegation** (milestone W) |
| "share only what's needed" | selective disclosure |

The demo's single "AI Agent" splits cleanly into our **Emissary (projects) + Warden (custodies)** —
a refinement, not a mismatch. "Emissary + Warden automate building the profile" = the Emissary
ingests provider-issued credentials from the world → the Warden accepts, classifies, seals, indexes.

## The big thing to ADOPT from hatpro-archon: the Trust Registry

Our `verifyProof` makes the verifier pass `trustedIssuers: [did]` — it must already know whom to
trust. hatpro-archon does it better: the verifier checks a **TRQP / ToIP Trust Registry**
(`issuerAuthorized(issuer, schema)`) — *"does the registry authorize this issuer for this schema?"*
So the verifier trusts a **registry**, and the registry vouches for issuers. That's the
**ecosystem-scale** answer to the issuer-trust problem (the scalable cousin of the sphere bootstrap,
F6). A restaurant trusts the travel registry, not every airline's DID.

## Work items (when we build the travel scenario)

1. **VRC scoped delegation** — enrich delegation to the HATPro shape: `allow`/`deny` credential-type
   patterns, `actions` (present/respond/negotiate/confirm), `limits` (`maxTransaction`,
   `confirmAbove`). `confirmAbove` wires into the Signet. *(extends milestone W)*
2. **Credential ingestion via the Emissary** — the Emissary receives a provider's VC in the world and
   forwards it to the Warden (alongside the witnessed-observation channel).
3. **Trust-registry option in `verifyProof`** — `trustRegistry` alongside `trustedIssuers`; reuse
   `archon-trust-registry`.
4. **Adopt HATPro schemas/vocabulary** — `hatpro-archon/config/schemas.json` + the `HatproProfile`
   data model, via `ensureSchema`.

Reusable from hatpro-archon: the schemas, the `HatproProfile` model, the TRQP registry, and the
challenge→response→verify flow (already 1:1 with ours).
