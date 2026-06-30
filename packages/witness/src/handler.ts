import {
  PROTOCOL_VERSION,
  presentProof,
  Sensitivity,
  type RequestHandler,
  type Transport,
  type TrustEvaluator,
  type KeymasterHandle,
  type ProofRequestMessage,
  type HearthholdMessage,
} from '@hearthold/core';

/** Registry `resource` label for each sensitivity level (the inward registry authorizes per level). */
const SENSITIVITY_NAME: Record<number, string> = {
  [Sensitivity.PUBLIC]: 'PUBLIC',
  [Sensitivity.LOW]: 'LOW',
  [Sensitivity.MEDIUM]: 'MEDIUM',
  [Sensitivity.HIGH]: 'HIGH',
  [Sensitivity.SEALED]: 'SEALED',
};

/**
 * Standing-delegation autonomy for the projector. When supplied, the Witness consults the Sovereign's
 * **inward** trust registry to decide whether it may present *on its own* for a given disclosure.
 */
export interface ProjectorAutonomy {
  /** The Sovereign's registry of its Witnesses (TRQP over Archon groups). */
  registry: TrustEvaluator;
  /** The Witness's own keymaster handle — used to present autonomously when cleared. */
  witness: KeymasterHandle;
  /** This Witness's DID — the entity evaluated against the registry. */
  witnessDid: string;
  /** Local policy mapping the (public) requested schema to its disclosure sensitivity. */
  sensitivityFor: (schema?: string) => Sensitivity;
}

function errorMsg(reason: string): HearthholdMessage {
  return { type: 'hearthold/error', version: PROTOCOL_VERSION, reason };
}

/**
 * The Witness as projector (PVM *Mage*): the world-facing emissary.
 *
 * Without `autonomy`, the Witness holds no deciding secret and never approves a disclosure itself — it
 * **relays** every proof-request to the Sovereign's Signet, which approves with proof-of-human and
 * presents, and the Witness carries the result back (§7.7).
 *
 * With `autonomy`, a **standing-delegation fast path** is added: the Witness asks the Sovereign's
 * inward registry "am I cleared to present at this sensitivity?" (`present` + the level). If yes, the
 * Witness presents a credential it holds *on its own* — no Signet round-trip — which is the standing
 * envelope made concrete. If the disclosure is above its cleared ceiling, it falls back to relaying to
 * the Signet. The sensitivity is derived locally from the requested schema; it is never taken from the
 * verifier.
 */
export function makeWitnessProjectorHandler(
  transport: Transport,
  sovereignDid: string,
  autonomy?: ProjectorAutonomy,
): RequestHandler {
  return async (message) => {
    if (message.type !== 'hearthold/proof-request') return null;
    const req = message as ProofRequestMessage;

    if (autonomy) {
      const sensitivity = autonomy.sensitivityFor(req.schema);
      const resource = SENSITIVITY_NAME[sensitivity] ?? 'SEALED';
      const auth = await autonomy.registry
        .authorize({ entity_id: autonomy.witnessDid, action: 'present', resource })
        .catch(() => ({ authorized: false, message: 'registry error' }));
      if (auth.authorized) {
        // Cleared by standing delegation — present on our own, no Signet. No humanProof is attached
        // because no human approved this disclosure; the standing grant did.
        try {
          const responseDid = await presentProof(autonomy.witness, req.challengeDid);
          return { type: 'hearthold/proof-presentation', version: PROTOCOL_VERSION, responseDid };
        } catch (err) {
          return errorMsg(`standing presentation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Above the cleared ceiling → fall through and relay to the Signet.
    }

    // Relay: carry the verifier's request to the Sovereign and return whatever the Signet decides
    // (a proof-presentation when approved, or an error when declined). The Witness only carries.
    try {
      return await transport.request(sovereignDid, message, { timeoutMs: 120_000 });
    } catch (err) {
      return errorMsg(`Witness could not reach the Sovereign: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
