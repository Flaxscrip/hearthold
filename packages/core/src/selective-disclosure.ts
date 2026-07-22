/**
 * Selective disclosure ("Pattern A") for Hearthold VCs on Archon — SD-JWT-style salted-hash disclosure
 * adapted to Archon primitives. The enabling primitive for the privacy-preserving MCP/A2A transport
 * binding, so this is a reusable module, sibling to `attenuation.ts`.
 *
 * The problem: Archon challenge/response is credential-LEVEL — the issuer signature covers the WHOLE VC,
 * so a disclosed subset is unsigned. Selective disclosure can't be retrofitted at presentation; it must be
 * built into WHAT THE WARDEN SIGNS AT ISSUANCE. So the Warden signs an ARRAY OF SALTED DIGESTS (one per
 * disclosable property) plus always-visible metadata; the full (salt, name, value) disclosures live in the
 * credential's pairwise-encrypted payload. At presentation the holder reveals only the requested
 * disclosures; the verifier recomputes each digest and checks membership in the signed array.
 *
 * Architecture split (identical to the attenuation work): Archon stays DUMB. It signs an opaque structured
 * payload (`addProof` — the same signature primitive the codebase uses for rulesets, whose trust is Archon
 * resolution: the verifier resolves the signer DID through whichever Gatekeeper it trusts) and stores
 * encrypted content (`encryptJSON`). Archon gets NO knowledge of properties, salts, or subsets — all
 * disclosure semantics are here.
 *
 * SCOPE — this gives property-HIDING, NOT unlinkability. The issuer signature is a stable value, so an
 * endpoint CAN correlate repeat presentations of the same credential. Unlinkability is a separate BBS+
 * tier and is out of scope; nothing here should be read as providing it. See FINDINGS.md.
 */

import { createHash } from 'node:crypto';

import type { KeymasterHandle } from './keymaster.js';
import { canonicalize, freshSalt } from './attenuation.js';

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ── Schemas ──────────────────────────────────────────────────────────────────────────────────────────

/** One disclosable property with its fresh per-property salt. Held by the holder; revealed selectively. */
export interface Disclosure {
  salt: string;
  name: string;
  value: unknown;
}

/**
 * `digest = HASH(canonical(salt, name, value))` — JCS (RFC 8785, via `canonicalize`) makes it reproducible
 * by any verifier. The salt (256-bit) defeats recovery of a small-domain value by enumerating the domain.
 */
export function digestDisclosure(d: Disclosure): string {
  return sha256Hex(canonicalize({ name: d.name, salt: d.salt, value: d.value }));
}

/** The signed credential body: the digest array + always-visible metadata. Archon signs this blob. */
export interface SignedDisclosureCommitments {
  /** The disclosure commitments — opaque salted digests, SORTED (issuance order carries no information). */
  sd: string[];
  issuer: string;
  credentialType: string;
  validUntil: string | null;
  /** Added by keymaster.addProof — the Warden's signature over the whole body (incl. `sd`). */
  proof?: { verificationMethod: string; proofValue: string; created: string; [k: string]: unknown };
}

/** What crosses the wire to an endpoint: the signed digest array + ONLY the requested disclosures. */
export interface Presentation {
  commitments: SignedDisclosureCommitments;
  disclosures: Disclosure[];
}

// ── Issuance (Warden) ────────────────────────────────────────────────────────────────────────────────

export interface IssueDisclosureArgs {
  issuer: KeymasterHandle;
  /** Wallet id NAME of the Warden — the signer, and the always-visible `issuer` DID. */
  issuerName: string;
  /** DID the full-disclosure payload is pairwise-encrypted to. */
  holder: string;
  /** The disclosable properties as (name → value). */
  properties: Record<string, unknown>;
  credentialType: string;
  validUntil?: string | null;
  registry: string;
}

export interface IssuedDisclosureCredential {
  /** The signed commitments — the holder presents this (fully; it's all opaque digests + metadata). */
  commitments: SignedDisclosureCommitments;
  /** The full disclosures (salts + values) — the holder keeps these to reveal selected ones. */
  disclosures: Disclosure[];
  /** The pairwise-encrypted asset (to the holder) holding the full disclosures. */
  payloadDid: string;
}

/**
 * Issue a selectively-disclosable credential. Salts each property, signs the sorted digest array via
 * Archon (`addProof`), and pairwise-encrypts the full disclosures to the holder. The values themselves
 * NEVER enter the signed body — only their salted digests do.
 */
export async function issueDisclosureCredential(args: IssueDisclosureArgs): Promise<IssuedDisclosureCredential> {
  const km = args.issuer.keymaster;
  await km.setCurrentId(args.issuerName);
  const issuerDid = (await km.resolveDID(args.issuerName)).didDocument?.id ?? '';

  const disclosures: Disclosure[] = Object.entries(args.properties).map(([name, value]) => ({ salt: freshSalt(), name, value }));
  const sd = disclosures.map(digestDisclosure).sort();

  const body: SignedDisclosureCommitments = {
    sd,
    issuer: issuerDid,
    credentialType: args.credentialType,
    validUntil: args.validUntil ?? null,
  };
  const commitments = (await km.addProof(body, args.issuerName)) as SignedDisclosureCommitments;

  const payloadDid = await km.encryptJSON({ disclosures }, args.holder, { registry: args.registry });
  return { commitments, disclosures, payloadDid };
}

// ── Presentation (holder) ────────────────────────────────────────────────────────────────────────────

/** Pick the disclosures the endpoint asked for; everything else stays hidden as bare digests. */
export function selectDisclosures(all: Disclosure[], names: string[]): Disclosure[] {
  const want = new Set(names);
  return all.filter((d) => want.has(d.name));
}

/** Build a Presentation revealing ONLY `requested`. The commitments (all opaque digests) go along whole. */
export function assemblePresentation(commitments: SignedDisclosureCommitments, all: Disclosure[], requested: string[]): Presentation {
  return { commitments, disclosures: selectDisclosures(all, requested) };
}

// ── Verification (endpoint; Hearthold-side, resolution-trust only) ─────────────────────────────────────

export interface DisclosureVerifyResult {
  ok: boolean;
  reason?: string;
  /** The failing check: 'signature' | 'issuer' | 'validity' | 'membership'. */
  check?: string;
  /** On ACCEPT: the disclosed name→value map — and NOTHING about the undisclosed properties. */
  disclosed?: Record<string, unknown>;
}

/**
 * Verify a Presentation: (1) the issuer signature over the digest array verifies to the named issuer
 * (resolution trust — no new assumption); (2) optional validity window; (3) every disclosed (salt, name,
 * value) recomputes to a digest PRESENT in the signed array. Reject if any is absent — a forged or
 * wrong-salted value has no matching digest. On ACCEPT the endpoint learns exactly the disclosed
 * properties and nothing about the rest (they remain opaque digests).
 */
export async function verifyPresentation(
  presentation: Presentation,
  opts: { keymaster: KeymasterHandle; expectedIssuer?: string; now?: string },
): Promise<DisclosureVerifyResult> {
  const km = opts.keymaster.keymaster;
  const verifyProof = km.verifyProof.bind(km) as (o: unknown) => Promise<boolean>;
  const c = presentation.commitments;
  const reject = (reason: string, check: string): DisclosureVerifyResult => ({ ok: false, reason, check });

  // (signature) — the whole body, including `sd`, is signed; a flipped digest breaks this.
  if (!c.proof) return reject('commitments carry no issuer signature', 'signature');
  const sigOk = await verifyProof(c).catch(() => false);
  if (!sigOk) return reject('issuer signature over the digest array does not verify', 'signature');
  const signer = (c.proof.verificationMethod ?? '').split('#')[0];
  if (signer !== c.issuer) return reject(`signed by ${signer}, not the named issuer ${c.issuer}`, 'signature');
  if (opts.expectedIssuer && c.issuer !== opts.expectedIssuer) {
    return reject(`issuer ${c.issuer} is not the expected ${opts.expectedIssuer}`, 'issuer');
  }

  // (validity)
  if (c.validUntil && opts.now && opts.now > c.validUntil) return reject(`credential expired at ${c.validUntil}`, 'validity');

  // (membership) — bind each disclosed value to a signed digest.
  const sdSet = new Set(c.sd);
  const disclosed: Record<string, unknown> = {};
  for (const d of presentation.disclosures) {
    if (!sdSet.has(digestDisclosure(d))) {
      return reject(`disclosed property '${d.name}' has no matching digest in the signed array`, 'membership');
    }
    disclosed[d.name] = d.value;
  }
  return { ok: true, disclosed };
}
