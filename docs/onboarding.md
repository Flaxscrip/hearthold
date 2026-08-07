# Onboarding an Emissary — the two grants (Phase 5, Part A)

Bringing a new Emissary online is **two deliberate grants**, one from each authority, kept separate by design
so submit-authority and disclosure-authority are granted — and revoked — independently:

```
1. SUBMIT   warden delegate <emissaryDid> [kinds=…]
              → the Warden issues a delegation VC (default: the text kinds; image is never granted by default).
              The daemon self-provisions it on next challenge-request; the Emissary can then `contribute`.

2. PROVE    sovereign capability:grant <emissaryDid> [ceiling=LOW] [kinds=…] [days=90]
              → the Sovereign issues a revocable scope capability. Baseline defaults: ceiling LOW, any kind,
              90-day expiry — a routine-facts grant, bounded by the LOW ceiling. Then: emissary accept <cap>.
```

The Emissary now holds both grants: it can **submit** observations and **invoke** to prove routine facts.
Anything above the baseline (a higher ceiling, a specific audience, a longer life) is a separate, deliberate
grant — never the default.

## Sensible baseline

- **Ceiling LOW.** The baseline grant proves only routine facts autonomously; MEDIUM+ steps up to the Signet
  automatically (`requiresHumanAt`), and external CGPR requests are stricter still (`cgprAutonomousAtOrBelow`,
  default LOW).
- **Revocable by default.** Every grant carries a status pointer; `sovereign capability:revoke <cap>` (or the
  Signet's permissions center) kills it at the next invocation.
- **Per-audience later.** For a specific counterparty, grant a narrower **pairwise** capability scoped to that
  audience rather than widening the baseline.

## UI-driven onboarding

The same two gestures over the control plane (for the Table's "add a device" flow):

```
warden control (:4310)   POST /api/delegate               { emissaryDid, kinds? }   (session-gated + co-signed)
signet control (:4311)   POST /api/authorize-capability   { emissaryDid, ceiling?, kinds?, days? }   (Signet-gated)
emissary control (:4312) POST /api/accept-capability      { credentialDid }
```

Multi-wallet deployments: set `HEARTHOLD_AUTHORIZATION_SCHEMA_DID` (the Warden's canonical schema) so the
Sovereign issues against the DID the Warden's challenge requests — see `docs/invocation.md`.
