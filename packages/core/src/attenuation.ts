/**
 * Verifier-enforced attenuation for VCs over Archon did:cid Asset DIDs — the verifier walks the chain and
 * checks the subset relation at each hop (not issuer convention, and not cryptographic constraint).
 *
 * Each hop in a delegation chain is its OWN Asset DID, controlled by an Agent DID (the attenuating actor,
 * e.g. the Warden). Two layers live in the asset:
 *
 *   - ENCRYPTED payload (`encryptJSON` → cipher_sender/cipher_receiver): the actual `authoritySet` + a
 *     high-entropy `salt`, disclosed only on challenge/response (or holder-side decrypt).
 *   - CLEARTEXT `pic` block (written via `mergeData` == Archon's setProperty): lineage, counter, a
 *     version-PINNED parent pointer, a salted authority commitment, the parent's commitment, and a signed
 *     attenuation assertion. Publicly resolvable — a third party verifies the whole chain with ZERO
 *     decryption, by resolving Asset DIDs.
 *
 * Semantics are 100% Hearthold's. Archon stays dumb: it stores cleartext (mergeData), encrypts pairwise
 * (encryptJSON), versions every update (new content-addressed versionId + versionSequence), and resolves —
 * including `resolveDID(did, { versionSequence })`, the pinned-version read the tamper-evidence rests on.
 * Archon never understands "authority" or "subset"; that logic is here, and the VERIFIER is the only
 * enforcement point (issuance-time refusal is a courtesy, never relied upon).
 *
 * Trust model = Archon resolution itself. A verifier trusts whichever Gatekeeper it resolves through
 * (own node = sovereign; SaaS = provider). We assume nothing stronger than resolution already requires.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { KeymasterHandle } from './keymaster.js';

// ── Authority ────────────────────────────────────────────────────────────────────────────────────────

/** A capability as a flat pair of sets. Attenuation = subset in BOTH dimensions (see `isSubset`). */
export interface AuthoritySet {
  operations: string[];
  resources: string[];
}

/** What gets pairwise-encrypted into the VC payload. The salt defeats commitment brute-forcing. */
export interface AuthoritySetPayload {
  authoritySet: AuthoritySet;
  salt: string;
}

/** Set-normalize: dedupe + sort each dimension, so a commitment is order- and multiplicity-independent. */
export function normalizeAuthoritySet(a: AuthoritySet): AuthoritySet {
  return {
    operations: [...new Set(a.operations)].sort(),
    resources: [...new Set(a.resources)].sort(),
  };
}

/** Cᵢ₊₁ ⊆ Cᵢ — every operation AND every resource of the child appears in the parent. */
export function isSubset(child: AuthoritySet, parent: AuthoritySet): boolean {
  const c = normalizeAuthoritySet(child);
  const p = normalizeAuthoritySet(parent);
  return c.operations.every((o) => p.operations.includes(o)) && c.resources.every((r) => p.resources.includes(r));
}

// ── Canonical serialization + commitment ───────────────────────────────────────────────────────────────

/**
 * Deterministic canonical JSON — a fixed subset of RFC 8785 (JCS) adequate for our value space (strings,
 * string arrays, integers, booleans, null, plain objects; NO floats). Object keys are sorted recursively;
 * arrays keep order (we set-normalize authority BEFORE hashing, so ordering there is already canonical).
 * Fixing the form now makes every commitment reproducible by any independent verifier.
 */
export function canonicalize(value: unknown): string {
  const enc = (v: unknown): string => {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(enc).join(',')}]`;
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${enc(o[k])}`).join(',')}}`;
    }
    throw new Error(`canonicalize: unsupported value type ${typeof v}`);
  };
  return enc(value);
}

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** A fresh 32-byte salt (hex) — 256 bits, so the small authority-set space is not enumerable. */
export function freshSalt(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The salted authority commitment: sha256 over the canonical `{ authoritySet(normalized), salt }`. Given a
 * commitment alone (no salt), the authority set is NOT recoverable by enumeration — the salt dominates the
 * preimage. Recompute-and-compare on disclosure binds the revealed set to the committed one.
 */
export function commit(authoritySet: AuthoritySet, salt: string): string {
  return sha256Hex(canonicalize({ authoritySet: normalizeAuthoritySet(authoritySet), salt }));
}

// ── The pic block (cleartext, resolvable) ────────────────────────────────────────────────────────────

/** A parent reference pinned to a SPECIFIC version — never the bare DID (that would follow tampering). */
export interface PrevPin {
  did: string;
  /** The parent's content-addressed versionId at pin time (asserted against the resolved doc). */
  versionId: string;
  /** The resolution key: `resolveDID(did, { versionSequence })` returns exactly this historical version. */
  versionSequence: number;
}

/** The attenuating actor's signed claim that this hop's authority is a subset of its parent's. */
export interface AttenuationAssertion {
  issuer: string;
  statement: string;
  lineageId: string;
  counter: number;
  authorityCommitment: string;
  parentAuthorityCommitment: string | null;
  /** Added by keymaster.addProof — `proof.verificationMethod` names the signing DID (checked at (e)). */
  proof?: { verificationMethod: string; proofValue: string; created: string; [k: string]: unknown };
}

export interface PicBlock {
  lineageId: string;
  counter: number;
  prevCredential: PrevPin | null;
  authorityCommitment: string;
  parentAuthorityCommitment: string | null;
  attenuationAssertion: AttenuationAssertion;
}

export const ATTENUATION_STATEMENT = 'authoritySet ⊆ parent.authoritySet';

// ── Issuance ─────────────────────────────────────────────────────────────────────────────────────────

/** The record threaded from a parent issuance into a child (carries the pin the child will embed). */
export interface IssuedVc {
  vcDid: string;
  lineageId: string;
  counter: number;
  authoritySet: AuthoritySet;
  salt: string;
  authorityCommitment: string;
  /** THIS credential pinned at the version that carries its pic — what a child embeds as prevCredential. */
  pin: PrevPin;
  holder: string;
}

export interface IssueVcArgs {
  issuer: KeymasterHandle;
  /** Wallet id NAME of the attenuating Agent DID — becomes the asset controller AND the assertion signer. */
  issuerName: string;
  /** DID the authoritySet payload is pairwise-encrypted to. */
  holder: string;
  authoritySet: AuthoritySet;
  registry: string;
  /** Omit for the origin (counter 0, lineageId := the origin's own DID). */
  parent?: IssuedVc;

  // ── test-only knobs (build the attack artefacts the VERIFIER must reject; never used in real issuance) ──
  /** Sign the attenuation assertion with a DIFFERENT id than the controller (FORGED-ASSERTION). */
  forgeAssertionWith?: string;
  /** Force a specific counter, bypassing parent+1 (COUNTER-SKIP). */
  overrideCounter?: number;
  /** Force parentAuthorityCommitment (forge the commitment chain / CROSS-LINEAGE). */
  overrideParentCommitment?: string | null;
  /** Force lineageId (CROSS-LINEAGE). */
  overrideLineageId?: string;
  /** Override the pinned parent pointer (CROSS-LINEAGE: pin L1 while claiming L2 lineage). */
  overridePrev?: PrevPin | null;
  /** Skip the issuance-time subset refusal (to actually MINT a non-subset child for the verifier to catch). */
  skipSubsetGuard?: boolean;
}

/**
 * Mint one hop. Encrypts the authoritySet payload to the holder, computes the salted commitment, signs the
 * attenuation assertion with the issuer's key, and writes the cleartext pic via `mergeData`. Enforces
 * attenuation at issuance too (refuses a non-subset child) — but this is belt-and-suspenders; the verifier
 * is the security boundary.
 */
export async function issueVc(args: IssueVcArgs): Promise<IssuedVc> {
  const km = args.issuer.keymaster;
  await km.setCurrentId(args.issuerName);
  const issuerDid = (await km.resolveDID(args.issuerName)).didDocument?.id ?? '';

  const authoritySet = normalizeAuthoritySet(args.authoritySet);
  const salt = freshSalt();
  const authorityCommitment = commit(authoritySet, salt);

  if (args.parent && !args.skipSubsetGuard && !isSubset(authoritySet, args.parent.authoritySet)) {
    throw new Error(
      `issuance refused: {${authoritySet.operations}/${authoritySet.resources}} ⊄ parent ` +
        `{${args.parent.authoritySet.operations}/${args.parent.authoritySet.resources}}`,
    );
  }

  const counter = args.overrideCounter ?? (args.parent ? args.parent.counter + 1 : 0);
  const parentAuthorityCommitment =
    args.overrideParentCommitment !== undefined
      ? args.overrideParentCommitment
      : args.parent
        ? args.parent.authorityCommitment
        : null;
  const prevCredential = args.overridePrev !== undefined ? args.overridePrev : args.parent ? args.parent.pin : null;

  // 1. Encrypt the payload → the VC's Asset DID. Its didDocumentData is the cipher; controller = issuer.
  const vcDid = await km.encryptJSON({ authoritySet, salt }, args.holder, { registry: args.registry });
  const lineageId = args.overrideLineageId ?? (args.parent ? args.parent.lineageId : vcDid);

  // 2. Sign the attenuation assertion (forgeable: signed by forgeAssertionWith if the test asks).
  const assertionBody: AttenuationAssertion = {
    issuer: issuerDid,
    statement: ATTENUATION_STATEMENT,
    lineageId,
    counter,
    authorityCommitment,
    parentAuthorityCommitment,
  };
  const attenuationAssertion = (await km.addProof(assertionBody, args.forgeAssertionWith ?? args.issuerName)) as AttenuationAssertion;

  // 3. Write the cleartext pic beside the cipher (setProperty) → a new version.
  const pic: PicBlock = { lineageId, counter, prevCredential, authorityCommitment, parentAuthorityCommitment, attenuationAssertion };
  await km.mergeData(vcDid, { pic });

  // 4. Pin THIS version (the one carrying the pic) for a child to embed.
  const doc = await km.resolveDID(vcDid);
  const meta = doc.didDocumentMetadata as { versionId?: string; versionSequence?: string };
  const pin: PrevPin = { did: vcDid, versionId: meta.versionId ?? '', versionSequence: Number(meta.versionSequence ?? 0) };

  return { vcDid, lineageId, counter, authoritySet, salt, authorityCommitment, pin, holder: args.holder };
}

// ── Verifier (standalone; public resolution + signature verification only) ───────────────────────────────

export interface VerifyOptions {
  /** Any keymaster bound to the Gatekeeper the verifier trusts (own node = sovereign, SaaS = provider). */
  keymaster: KeymasterHandle;
  /** If set, the origin hop's controller MUST equal this DID (pin the root of trust). */
  expectedRootIssuer?: string;
  /** Stronger check: vcDid → revealed {authoritySet, salt} (from challenge/response or holder decrypt). */
  disclosed?: Record<string, AuthoritySetPayload>;
  maxHops?: number;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  /** The check that failed, e.g. '(c)', '(d)', '(e)', '(⊆)', '(b)'. */
  check?: string;
  vc?: string;
  counter?: number;
  chainLength?: number;
}

const signerOf = (a: AttenuationAssertion): string => (a.proof?.verificationMethod ?? '').split('#')[0] ?? '';

/**
 * Walk a leaf VC Asset DID to its origin, resolving each hop through the trusted Gatekeeper, and return
 * ACCEPT or REJECT-with-reason. Zero decryption unless `disclosed` is supplied. Checks per hop:
 *   (a) the hop resolves with a controller;
 *   (e) its attenuation assertion is validly signed BY that controller (the expected issuer);
 *       + the assertion's committed fields match the pic (no split-brain between signed claim and pic);
 *   (b) the pinned parent version resolves and its content-addressed versionId matches the pin;
 *   (c) counter == parent.counter + 1;
 *   (d) parentAuthorityCommitment == the parent's OWN authorityCommitment (commitment chain consistent);
 *       + lineageId is stable across the hop.
 * With `disclosed`: recompute commit(set,salt)==commitment (bind), and enforce Cᵢ₊₁ ⊆ Cᵢ.
 */
export async function verifyAttenuationChain(leafVcDid: string, opts: VerifyOptions): Promise<VerifyResult> {
  const km = opts.keymaster.keymaster;
  const verifyProof = km.verifyProof.bind(km) as (o: unknown) => Promise<boolean>;
  const disclosed = opts.disclosed ?? {};
  const maxHops = opts.maxHops ?? 64;

  const reject = (reason: string, check: string, vc: string, counter?: number): VerifyResult => ({ ok: false, reason, check, vc, counter });

  let did = leafVcDid;
  let useVersion: number | undefined;
  // What the CHILD just processed asked of the node we are about to load (pin + the child's own pic/did).
  let expectFromChild: { pin: PrevPin; childPic: PicBlock; childDid: string } | null = null;
  let length = 0;

  for (let step = 0; step < maxHops; step++) {
    const doc = await km.resolveDID(did, useVersion !== undefined ? { versionSequence: useVersion } : undefined);
    const meta = doc.didDocumentMetadata as { versionId?: string };
    const controller = (doc.didDocument as { controller?: string } | undefined)?.controller ?? '';
    const pic = (doc.didDocumentData as { pic?: PicBlock } | undefined)?.pic;

    // (b) — a pinned parent must resolve to EXACTLY the pinned content-addressed version.
    if (expectFromChild && meta.versionId !== expectFromChild.pin.versionId) {
      return reject(`pinned parent version ${expectFromChild.pin.versionSequence} resolved to ${meta.versionId}, expected ${expectFromChild.pin.versionId}`, '(b)', did);
    }
    // (a)
    if (!controller) return reject('hop has no controller', '(a)', did);
    if (!pic) return reject('hop carries no pic block', '(a)', did);

    // (e) — assertion validly signed by the expected issuer (== this hop's controller), and self-consistent.
    const asrt = pic.attenuationAssertion;
    if (!asrt || !asrt.proof) return reject('hop carries no signed attenuation assertion', '(e)', did, pic.counter);
    const sigOk = await verifyProof(asrt).catch(() => false);
    if (!sigOk) return reject('attenuation assertion signature does not verify', '(e)', did, pic.counter);
    if (signerOf(asrt) !== controller) {
      return reject(`attenuation assertion signed by ${signerOf(asrt)}, not the hop's controller/issuer ${controller}`, '(e)', did, pic.counter);
    }
    if (
      asrt.authorityCommitment !== pic.authorityCommitment ||
      asrt.parentAuthorityCommitment !== pic.parentAuthorityCommitment ||
      asrt.counter !== pic.counter ||
      asrt.lineageId !== pic.lineageId ||
      asrt.statement !== ATTENUATION_STATEMENT
    ) {
      return reject('signed assertion disagrees with the pic block (split-brain)', '(e)', did, pic.counter);
    }

    // disclosure binding for THIS hop: the revealed set must hash to the committed value.
    const reveal = disclosed[did];
    if (reveal && commit(reveal.authoritySet, reveal.salt) !== pic.authorityCommitment) {
      return reject('disclosed authoritySet+salt does not match the authorityCommitment', '(commit)', did, pic.counter);
    }

    // Cross-hop checks: the child we just processed vs THIS parent.
    if (expectFromChild) {
      const child = expectFromChild.childPic;
      if (child.counter !== pic.counter + 1) {
        return reject(`counter ${child.counter} is not parent ${pic.counter} + 1`, '(c)', expectFromChild.childDid, child.counter);
      }
      if (child.parentAuthorityCommitment !== pic.authorityCommitment) {
        return reject('child.parentAuthorityCommitment != parent.authorityCommitment (commitment chain break)', '(d)', expectFromChild.childDid, child.counter);
      }
      if (child.lineageId !== pic.lineageId) {
        return reject(`lineage mismatch: child ${child.lineageId} vs parent ${pic.lineageId}`, '(lineage)', expectFromChild.childDid, child.counter);
      }
      const childReveal = disclosed[expectFromChild.childDid];
      if (reveal && childReveal && !isSubset(childReveal.authoritySet, reveal.authoritySet)) {
        return reject('disclosed child authoritySet ⊄ parent authoritySet', '(⊆)', expectFromChild.childDid, child.counter);
      }
    }

    length++;

    if (pic.prevCredential === null) {
      // Origin.
      if (pic.counter !== 0) return reject(`origin counter is ${pic.counter}, expected 0`, '(c)', did, pic.counter);
      if (pic.parentAuthorityCommitment !== null) return reject('origin carries a parentAuthorityCommitment', '(d)', did, pic.counter);
      if (opts.expectedRootIssuer && controller !== opts.expectedRootIssuer) {
        return reject(`origin controller ${controller} != expected root issuer ${opts.expectedRootIssuer}`, '(root)', did, pic.counter);
      }
      return { ok: true, chainLength: length };
    }

    expectFromChild = { pin: pic.prevCredential, childPic: pic, childDid: did };
    did = pic.prevCredential.did;
    useVersion = pic.prevCredential.versionSequence;
  }

  return reject(`chain exceeded ${maxHops} hops without reaching an origin`, '(depth)', did);
}
