# Ledger — non-obvious Archon/Hearthold facts we paid to learn

A running list of things that surprised us and would surprise the next reader, each with how we found it.
Short, blunt, and stated plainly where the intuitive reading is wrong.

## `encryptJSON` is ENCRYPT-FOR-SENDER

`keymaster.encryptJSON(data, recipientDid)` (and `encryptMessage`) seals the payload so that **both the
recipient AND the sender** can decrypt it — not the recipient alone. The phrase "encrypted to the recipient"
naturally implies send-and-forget: that once sealed, the sender can no longer read it. **That is false here.**

Consequences, stated plainly:

- **There is no send-and-forget.** A Sovereign can always decrypt anything they sent. Every sealed message a
  node emits stays readable by that node's own key, indefinitely.
- **Key compromise exposes the outbox, not just the inbox.** Compromising a Sovereign's key reveals every
  message they ever *sent* (via `encryptJSON`), in addition to everything sent *to* them. Threat-modelling
  "what does losing this key leak" must include the sent-history, not only received mail.
- **A pairwise artifact has two readers by construction**, the sender and the named recipient. "Only the
  recipient can open it" is true only against *third* parties — never against the author.

Where this bites in our code: the mesh answer is `encryptJSON(signed, presenterDid)` (`mesh.ts`), so B (the
answering Warden) retains read access to every answer it ever returned. That is fine — B authored the fact —
but it is a property to design around, not against.

**How we found it.** The first draft of the PVM-BOUNDARIES **B4 (pairwise disclosure)** check tested
"a non-recipient cannot decrypt" using the *sender* (B's Warden) as the non-recipient — and it came back
RED, because the sender *could* decrypt its own output. The invariant (a party that is neither sender nor
recipient cannot open the artifact) is real and holds; the test had to use a genuinely unrelated third party.
See [`pvm-boundaries/RESULTS.md`](pvm-boundaries/RESULTS.md). The RED was a mis-framed test, but it surfaced a
real Archon property worth writing down.
