# @hearthold/a2a-gateway

The Hearthold **A2A boundary adapter** for Consent-Gated Preference Requests (CGPR). A2A at the edge,
Hearthold's wire protocol internally — a *Mage*: it holds no secrets, translates envelopes, and relays to
the Warden. No A2A type reaches `@hearthold/core`.

Serves the A2A **Agent Card** (`/.well-known/agent-card.json`) advertising the CGPR extension, and a
JSON-RPC 2.0 endpoint (`/a2a`) for `message/send` + `tasks/get`. Inbound `CgprRequestArtifact` → validate
ticket → relay to the Warden's CGPR service → complete the task with a `CgprGrant` or `CgprDecision`.

```ts
import { startA2aGateway } from '@hearthold/a2a-gateway';
const gw = startA2aGateway({ port: 4319, publicUrl: 'https://a.example', backend }); // backend = DIDComm relay to the Warden
```

**Pinned:** A2A `1.0.0` (`A2A_VERSION`). **Extension:** `https://hearthold.dev/2026/a2a/cgpr/v1`.

**Try it:** `npm run demo:cgpr` (narrated, prints the `curl` for each step) · `npm run e2e:cgpr` (the seven
conformance checks).

**Trust posture, message samples, flow diagram, known limitations:** see [`docs/a2a-cgpr.md`](../../docs/a2a-cgpr.md).
