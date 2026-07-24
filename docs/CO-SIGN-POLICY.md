# Sovereign co-sign policy — PROPOSED (for review, not yet adopted)

**Status: PROPOSED.** This is a decision rule for review, not an adopted invariant. It names *when* an act
requires the Sovereign's proof-of-human co-sign (at the Signet) versus when the Warden may act alone —
so the answer stops being decided ceremony-by-ceremony and starts falling out of a rule.

## The rule

The Warden may act alone unless the act is one or more of:

- **(a) irreversible** — it cannot be cleanly undone (a published operation, a burned single-use, a key
  rotation, a transfer of custody);
- **(b) crosses a publication boundary** — it makes content or an identifier reach a party beyond this node
  (disclosure to a sphere's members, gossip onto a shared topic, an outward credential);
- **(c) delegates authority to another party** — it grants someone the ability to act or read on the
  Sovereign's behalf (a recognition, a delegation credential, a guardianship edge).

**If any of (a)/(b)/(c) holds, the act requires Sovereign co-sign.** Co-sign is a proof-of-human assertion
from the Sovereign's own Signet — never the governor's, never a stored secret (consistent with the
deny-by-default release ladder and the per-member approver). Reversible, local, non-delegating acts stay
Warden-only, so the Signet is spent on the decisions that actually bind.

Why these three and not "sensitivity": sensitivity already gates *disclosure* inside `decideRelease()`. This
rule is orthogonal — it gates acts by their **bindingness** (can I take it back? does it escape the node?
does it hand power to someone else?), which is where an irreversible or authority-granting mistake is
unrecoverable regardless of how "sensitive" the payload was.

## Resolving the ceremonies we have

| Ceremony | (a) irreversible | (b) publication | (c) delegation | Co-sign? |
|---|---|---|---|---|
| **Publish to a sphere** (with peers) | ✓ (members receive it; can't un-send) | ✓ | — | **Yes** (a+b) |
| **Issue a recognition** | — (revocable) | — (pairwise to the subject) | ✓ (grants the subject standing) | **Yes** (c) |
| **Guardianship transfer** | ✓ (custody moves) | — | ✓ (hands authority to a guardian) | **Yes** (a+c) |
| **Start a DMZ** (ephemeral verify env) | — (torn down cleanly) | — (mediator-less; nothing propagates) | — | **No** — Warden alone |
| **Promote out of a DMZ** | depends on destination | depends on destination | — | **Depends** — see below |

### Promotion out of a DMZ — split by destination (see [`DRAWBRIDGE-GROUNDING.md`](DRAWBRIDGE-GROUNDING.md))

The DMZ is an ephemeral, mediator-less verification environment (Part E). Starting it trips none of the
triggers — it publishes nothing and is reversible — so the Warden starts it alone. **Promotion** is where
the destination decides:

- **into a peerless private store** — stays local, propagates to no one → trips nothing → **Warden-authorized**;
- **into a sphere WITH peers** — the sphere's members will *receive what we import* → this is **publication**
  (trigger b), and often irreversible (a) → **Sovereign co-sign**.

So the same "promote" verb is Warden-only or co-signed **entirely by where it lands** — which is why the DMZ
lifecycle must name its promotion destination explicitly rather than treating promotion as one operation.

## Relationship to existing machinery

This rule does not replace anything; it explains the pattern the ceremonies already follow and gives new
ceremonies a default. It composes with: the release ladder (sensitivity-gated disclosure), the guardianship
threat model ([`guardianship-threat-model.md`](guardianship-threat-model.md) — guardianship is *grantable
but never seizable*, which is trigger (c) with the affected member's co-signature required), and sphere
selection safety (Part E — a publish names its target sphere and refuses on gatekeeper mismatch, so a
co-signed publication can't silently land on the wrong sphere).

**Open questions for review:** (1) Is key rotation (a, irreversible) worth a co-sign, or is it operational
hygiene the Warden should do autonomously? (2) Does an *inward* credential acceptance (accepting a VC issued
to us) count as delegation-in — probably not (c), since it grants *us* nothing over others — but confirm.
(3) Should (b) distinguish "publication to N known members of a sphere" from "gossip to an open topic"? The
table treats both as publication; a finer rule might co-sign only open-topic publication.
