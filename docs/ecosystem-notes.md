# Ecosystem notes — adjacent tech we track (but don't depend on)

Hearthold's identity spine is deliberately **Archon `did:cid` + W3C VC 2.0 + DIDComm v2 + ToIP TRQP**.
That standards coherence is the point — it's what makes Hearthold a reference implementation and keeps
it interoperable with the DIF / ToIP / W3C world. This note records adjacent technologies we've
evaluated: what they offer, and how (if at all) we'd touch them **without** forking off that spine.

## XIDs / Gordian Envelope (Blockchain Commons)

- **What:** [XID-Quickstart](https://github.com/BlockchainCommons/XID-Quickstart), by Christopher Allen
  (co-author of the DID spec). A **XID** is a 32-byte identifier derived from a public key, stable
  through key rotation (DID-like role). A **Gordian Envelope** is a CBOR `subject → predicate → object`
  structure over a Merkle-like hash tree (VC-like role, but a more general signed-document format).
- **Headline feature — elision-first:** any part of any signed envelope can be **holder-side redacted**
  while the signature still verifies, with per-element **salting** to defeat correlation. Selective
  disclosure is the native data model, not a bolt-on (contrast SD-JWT-VC / BBS+).
- **Status:** explicitly **experimental** — the authors state it is not for deployed systems and is not
  security-tested. Not a W3C/DIF/ToIP standard; a parallel ecosystem (`envelope-cli`, Rust).

### Why we care

The **evidence-graph** work (see [evidence-graph.md](evidence-graph.md)) independently arrived at a
special case of Gordian's model. Our **A3 selective disclosure** commits the witnessed group to
**salted per-observation Merkle leaves** and reveals a chosen subset against the signed root
(`core/evidence.ts`: `assembleEvidence` / `revealLeaves` / `verifyRevealedLeaf`). That is a
purpose-built version of Gordian's salted-hash-tree elision.

### How we'd engage — mine, don't adopt

1. **Elision design reference.** Harden A3 against Gordian's maturity: eliding *structure* (whole
   sub-trees) not just leaves, nested elision, and their correlation-resistance analysis.
2. **Bridge / export (optional spike).** Our evidence graph is already a signed tree with disclosable
   leaves; it could be *exported as* a Gordian Envelope, or a Gordian-signed attestation could be
   consumed as an `issued` leaf in our composite evidence — extending reach to the Blockchain Commons
   world without adopting the stack.
3. **Reading.** Allen's essays (progressive trust, data minimization, "SSI bankruptcy", fair witness)
   map closely onto the PVM and sharpen our framing; the "fair witness" model parallels our **Witness**.

**Decision:** keep the Archon/W3C/ToIP spine; treat XIDs as a design reference and a possible bridge
target, not a dependency. A competing open standard is a thing to *bridge to*, not to straddle.
