# Hearthold — Feature & Status Summary

*A working identity system that takes the Privacy Is Value Model out of the mathematics and builds it
in `did:cid`. Your accumulated personal history — the **7th Capital** — made safely liquid.*

**Repo:** [github.com/Flaxscrip/hearthold](https://github.com/Flaxscrip/hearthold) (public, MIT) ·
**Runs on:** Archon `did:cid` (verified on node **v0.11.0**) · **Stack:** DIDComm v2 · W3C VC 2.0 ·
ToIP TRQP · local-only AI (Ollama) · **Status:** the full loop — witness → store → **prove** — runs and
is tested end-to-end, a second mode, **recall**, is live, and a shared **Knowledge Portal** (a public
Mage over a private Warden) runs the whole thing multi-party. — *GenitriX, House of Archon*

---

## The two modes — the headline

Hearthold now does two complementary things with the same vault and the same local AI, in opposite
directions. Both *value the 7th Capital*:

| Mode | Direction | Who it serves | It makes your history… |
|---|---|---|---|
| **Prove** | outward, to a third party | a verifier / relying party | **spendable** — verifiable, disclosure-controlled proof |
| **Recall** | inward, to yourself | you (or your local agent) | **usable** — a private, local-AI knowledge base |

*Prove* is the PVM liquidity thesis realized. *Recall* turns Hearthold from a proof system into a
general **archive + retrieval + disclosure** data layer — a sovereign second brain. They compose:
recall an answer for yourself, then wrap it in an evidence graph to prove it to someone.

---

## What's new since the `agentprivacy.ai/hearthold` showcase

That page listed the GUIs and the derived-claim prove flow as *next milestones*. All of that now
exists, plus a good deal more:

- **Three demo GUIs** — thin React consoles over the real agents (below).
- **The full evidence-graph prove side** — the Warden turns witnessed vault data into a signed,
  presentable, disclosure-controlled proof: witnessed graphs, a **Sovereign co-signature that any
  third party can verify**, **composite** proofs that fold in third-party credentials, and
  **selective disclosure** of individual supporting observations.
- **Recall** — a private, local-AI RAG over the vault (the "when is America's anniversary?" case,
  answered on-device).
- **Quality of the proof object** — structured predicates, single-use `txn`, and **ephemeral**
  short-lived proofs.

Every item below is exercised by an automated end-to-end test (`e2e:*`) against a live Archon node.

---

## The three identities (the PVM separation, built)

Each is a `did:cid` with its own independently-custodied Keymaster wallet. **One Sovereign, one
Warden, many Emissaries.**

| PVM archetype | Hearthold role | Does | Never |
|---|---|---|---|
| First Person 🗝️ | **Sovereign** (held by the Signet) | decides, approves with proof-of-human, signs | witnesses routine context, or runs as an always-on server |
| Swordsman ⚔️ | **Warden** (home Keeper, always-on) | custodies the sealed vault, classifies on-device, assembles/derives evidence, recalls | acts in the world, or holds the deciding secret |
| Mage 🧙 | **Emissary** (Companion, per device) | witnesses local context, carries proofs to the world | is the authority, the subject of a claim, or the approver |

The **control plane** (the Sovereign authorizes) is cryptographically separated from the **data plane**
(the Warden executes) — a compromised always-on host cannot author authority.

---

## Capability map

### Identity, transport & storage
- **Wallet-per-agent** custody; an Emissary can migrate devices via `backupId`/`recoverId`.
- **DIDComm v2** transport (authcrypt) — sender-authenticated, **zero registry footprint**; no
  observer learns who talks to whom. Payloads sealed in-band; the relay never sees content.
- **On-device classifier** — the Warden labels each artefact's sensitivity with a local model (Ollama
  `qwen3:8b`), fail-safe to `SEALED`. No content ever leaves the house.
- **Release model** — two independent scales (per-artefact **sensitivity** × per-request
  **authorization tier**) plus a disclosure transform; what leaves is always a *derived* credential,
  never the raw artefact, and **never a score**.

### Prove — the evidence graph and its trust ladder
The Warden assembles supporting artefacts into a Merkle-committed provenance group and mints a signed
Verifiable Credential; the Sovereign presents it; a verifier checks it offline against issuer DIDs.

| Trust class | What backs it | A verifier trusts | Status |
|---|---|---|---|
| **witnessed** | the Sovereign's own observations, Warden-signed | the Warden's signature | ✅ `e2e:evidence` |
| **+ Sovereign co-sign** | a **detached Sovereign signature** on the disclosure (proof-of-human), embedded in the graph | verifies the Sovereign's signature directly — no decryption, tamper-evident | ✅ `e2e:evidence-stepup` / `-direct` |
| **composite (issued)** | a third-party credential (e.g. a lease) folded in alongside | each issuer independently — the *external* party, not just the Warden | ✅ `e2e:evidence-composite` |
| **selective disclosure** | reveal chosen observations against the signed Merkle root | recomputes the leaf, checks the path — sees one fact, not the rest | ✅ `e2e:evidence-selective` |

Two properties that matter for real use: the co-sign for a sensitive disclosure happens on a **direct
Warden↔Sovereign channel** — the Emissary (the world-facing agent) is *never* in the authorization path,
so it can't misdescribe what the human approves (honors the §7.7 "no agent summary" rule). And proofs
are **ephemeral + single-use** — short `validUntil`, one `txn`.

### Recall — the private archive (RAG)
- The Warden embeds each artefact at store time (`nomic-embed-text`) into a **local** index that holds
  **embeddings + metadata only — no plaintext**; content is re-unsealed transiently at recall time, so
  the vault stays sealed at rest.
- `recall(query)` → embed → cosine-rank (with an optional sensitivity ceiling) → re-unseal the top
  matches → a local model answers with citations. **Query, retrieval, and answer never leave the
  device.** Answers are flagged `machine-derived` (fallible; not a verifiable claim on their own).
- Verified live with real local models — e.g. *"When is America's anniversary?"* → *"America's
  anniversary is July 4th, 2026,"* recalled from a witnessed document. `e2e:recall`.

### Trust graph & registry
- The full **DTG credential set** (VRC / VMC / VIC / VPC / VEC / VWC + RCard) issues and verifies
  natively on `did:cid` (VC 2.0). `e2e:dtg-set`.
- A **ToIP TRQP v2.0 trust registry** over Archon groups — *outward* (which issuers a verifier trusts)
  and *inward* (an Emissary's autonomy ceiling). Interoperates with an independent TRQP deployment.
  `e2e:trust-registry` / `-inward-registry` / `interop:registry`.

### The GUIs
Three self-contained Vite/React apps, one per world-facing actor, driving the real agents over a
localhost control API + live event stream. The browser never touches Keymaster (DIDComm stays in
Node), so they stay thin and dependency-light.

- **Warden Console** — identity/status, the live vault (sensitivity-chipped), delegations, classifier.
- **Signet Approver** — the proof-of-human moment: a pending-approval queue with PIN approve/deny; it
  shows the **Warden-authored** disclosure description, never the requesting agent's words.
- **Emissary** — witness an observation, and **Prove a claim** end-to-end (claim → Signet approval →
  a granted, inspectable evidence graph).

---

## Why this matters for "restricted AI agents"

The **Warden is a restricted AI agent by construction** — exactly the category with commercial demand:

- **local-only** — it physically cannot exfiltrate (no cloud model, ever);
- **governed** — it acts only within a scoped, revocable delegation, and below a registry-set ceiling;
- **fail-safe** — anything unclassified is `SEALED`; sensitive disclosure requires a fresh human
  co-sign it cannot forge;
- **accountable** — everything it emits is a verifiable, decomposable evidence graph, never a black-box
  score.

Hearthold is a working reference implementation of a privacy-preserving, human-in-the-loop restricted
agent — archiving, recalling, *and* proving, all sovereign.

---

## Honest status & what's next

**Solid today:** the witness→store→prove loop (all four trust classes), the Sovereign/Signet co-sign,
recall R1, the trust registry + DTG set, and the three GUIs — each end-to-end tested.

**Next / in progress:**
- **Recall** — structured fact/entity/date extraction, a recall GUI surface, a real vector store.
- **Knowledge Portal** — a shared, authorized Knowledge Base a community can query and update through a
  **public Emissary portal** in front of a **private Warden** (the projector pattern, inverted); authenticate
  via Archon challenge/response, authorize via a trust-registry group. A hosted, multi-party demo — see
  [knowledge-portal.md](knowledge-portal.md). *(The natural driver for a sphere-manager GUI.)*
- **Proof-of-human** beyond PIN (level 1) — biometric / face-liveness / FIDO2 behind the same gate.
- **Per-device Emissaries** with kind-scope enforcement (one Sovereign, many Emissaries).
- **Sovereign-signed Warden policy** (lift access-control config into a signed document the Warden
  verifies / fails safe).

**Known boundary (stated plainly):** a rooted, *running* Warden can still exfiltrate what it can
currently decrypt; closing that needs SEALED-to-Sovereign encryption or a TEE. The separation of
control from data means such a compromise still cannot *change policy* or forge a Sovereign co-sign.

---

## Provenance — how to check the claims

The repo is public and the assertions above are backed by an automated end-to-end suite — **19/19
passing against Archon node v0.11.0** (a clean upgrade from v0.10.0 with zero regressions). Run
`npm run e2e:*`: `delegation`, `submission`, `smoke:didcomm`, `issued`, `prove`, `prove-didcomm`,
`projector`, `dtg-set`, `trust-registry`, `inward-registry`, `interop:registry` (against an
independent TRQP deployment), `evidence`, `evidence-stepup`, `evidence-direct`, `evidence-composite`,
`evidence-selective`, `recall`, `kb`. Design details live in `docs/` (architecture, evidence-graph,
security-model, sovereign-signet, trust-graph-and-delegation, standards-alignment, knowledge-portal).
