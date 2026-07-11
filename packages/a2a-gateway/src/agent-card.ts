/**
 * The A2A Agent Card — served at the well-known URI, advertising the CGPR extension.
 *
 * A2A version note: the brief was written against protocol line 0.3; the current released spec is
 * **1.0.0** (a2a-protocol.org). We pin 1.0.0 in one constant and interpret an empty `A2A-Version`
 * request header as this version. The Agent Card path moved to `/.well-known/agent-card.json`.
 */

import { CGPR_EXTENSION_URI, CGPR_SCHEMAS } from '@hearthold/cgpr-types';

/** Pinned A2A protocol version (was 0.3 at brief time; 1.0.0 as of this writing). One constant. */
export const A2A_VERSION = '1.0.0';

/** The well-known path the Agent Card is served at (A2A 1.0.0). */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

/** The A2A message endpoint (JSON-RPC 2.0). */
export const A2A_RPC_PATH = '/a2a';

/** Build the Agent Card advertising the CGPR extension as required for CGPR tasks. */
export function buildAgentCard(opts: { url: string }): Record<string, unknown> {
  return {
    protocolVersion: A2A_VERSION,
    name: 'Hearthold Sovereign Gateway',
    description:
      "A-side endpoint for Consent-Gated Preference Requests. The Sovereign's Warden authors all " +
      'consent; every grant binds to a fresh pairwise DID and is scoped, audience-bound, and single-use.',
    url: `${opts.url}${A2A_RPC_PATH}`,
    preferredTransport: 'JSONRPC',
    version: '0.1.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: CGPR_EXTENSION_URI,
          description:
            'Consent-Gated Preference Requests (CGPR): present a single-use ticket to request a bounded ' +
            'set of preferences; receive a scoped, audience-bound, single-use attestation to a pairwise DID. ' +
            'No subject identifier appears before approval.',
          required: true,
          params: { schemas: Object.keys(CGPR_SCHEMAS) },
        },
      ],
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'cgpr.request',
        name: 'Request preferences (CGPR)',
        description:
          'Submit a CgprRequestArtifact (a broker-issued ticket + the requester’s self-description) to ' +
          'request the Sovereign’s consented preferences. The task reaches input-required while consent is ' +
          'pending, then completes with a CgprGrant or a CgprDecision.',
        tags: ['cgpr', 'privacy', 'preferences'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
  };
}
