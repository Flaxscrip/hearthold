/**
 * Star Hold conformance — bound-signer verification & challenge (slice 2).
 *
 * Self-contained (no live node): generates real Ed25519 keys with node:crypto, builds and signs an
 * agentprivacy.vta/1 record, and exercises the full "import ≠ control" chain plus its negative
 * cases. The wire details taken from the #90 spec (canonical profile, hex encodings) are asserted
 * for internal consistency here; a signed fixture from PrivacyMage will lock them to his origin.
 *
 * Run: node --experimental-strip-types scripts/e2e-star-vta.ts   (or: npm run e2e:star-vta)
 */

import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import {
  ed25519PublicKeyToDidKey,
  verifyVtaRecord,
  vtaPreimage,
  issueBoundSignerChallenge,
  challengePreimage,
  verifyBoundSignerChallenge,
  type VtaRecord,
  type Kappa,
} from '@hearthold/core';

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function ed25519Keypair(): { publicKeyHex: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { publicKeyHex: Buffer.from(jwk.x, 'base64url').toString('hex'), privateKey };
}
const signHex = (key: KeyObject, msg: string): string =>
  cryptoSign(null, Buffer.from(msg, 'utf8'), key).toString('hex');

console.log('Star Hold · bound-signer verification & challenge\n');

const KAPPA = 'sha256:07f20f689c8bef2d8a9a2a71d94e7014ea8398cc603b0ff72dadba5c517983d1' as Kappa;
const alice = ed25519Keypair();

// ---- did:key derivation ----
console.log('did:key (Ed25519, multicodec ed01)');
const did = ed25519PublicKeyToDidKey(alice.publicKeyHex);
check('derives a did:key:z6Mk… (Ed25519 multicodec)', did.startsWith('did:key:z6Mk'), did);
check('deterministic', ed25519PublicKeyToDidKey(alice.publicKeyHex) === did);

// ---- VTA record verification ----
console.log('\nverifyVtaRecord');
function signedRecord(over: Partial<VtaRecord> = {}, signer = alice): VtaRecord {
  const rec: VtaRecord = {
    kind: 'agentprivacy.vta/1',
    publicKeyHex: signer.publicKeyHex,
    kappa: KAPPA,
    prior: null,
    at: '2026-09-12T00:00:00.000Z',
    walks: 0,
    vrcs: [],
    sig: '',
    ...over,
  };
  rec.sig = signHex(signer.privateKey, vtaPreimage(rec));
  return rec;
}

const good = signedRecord();
const v = verifyVtaRecord(good);
check('valid record verifies', v.ok === true);
check('returns the key-derived did:key', v.ok && v.did === did);

const withClaimedDid = signedRecord({ did });
check('matching claimed did accepted', verifyVtaRecord(withClaimedDid).ok === true);

const wrongDid = { ...good, did: 'did:key:z6MkwrongwrongwrongwrongwrongwrongXXXX' };
const wd = verifyVtaRecord(wrongDid);
check("claimed did that mismatches the key → 'did-mismatch'", !wd.ok && wd.reason === 'did-mismatch');

const tampered = { ...good, kappa: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as Kappa };
const t = verifyVtaRecord(tampered);
check("field changed after signing → 'bad-signature'", !t.ok && t.reason === 'bad-signature');

const forged = { ...good, sig: '00'.repeat(64) };
check('forged signature rejected', verifyVtaRecord(forged).ok === false);

const malformed = { ...good, sig: '' };
const m = verifyVtaRecord(malformed);
check("missing signature → 'malformed'", !m.ok && m.reason === 'malformed');

// a record signed by a DIFFERENT key than its publicKeyHex claims must fail
const impostor = ed25519Keypair();
const mislabelled: VtaRecord = { ...signedRecord(), sig: '' };
mislabelled.sig = signHex(impostor.privateKey, vtaPreimage(mislabelled)); // wrong signer over honest preimage
check('record signed by a key other than publicKeyHex rejected', verifyVtaRecord(mislabelled).ok === false);

// ---- bound-signer challenge (import ≠ control) ----
console.log('\nverifyBoundSignerChallenge (live control)');
const now = Date.now();
const challenge = issueBoundSignerChallenge({ kappa: KAPPA, audience: 'warden:kb-admit', ttlMs: 120_000, now });
check('challenge carries a fresh 32-byte nonce', /^[0-9a-f]{64}$/.test(challenge.nonce));

const response = signHex(alice.privateKey, challengePreimage(challenge));
const passed = verifyBoundSignerChallenge({ record: good, challenge, responseSigHex: response, now: now + 1_000 });
check('bound key signs the live challenge → ok', passed.ok === true);
check('verdict carries the controlling did', passed.ok && passed.did === did);

// negative: someone else answers the challenge
const impostorResp = signHex(impostor.privateKey, challengePreimage(challenge));
const notBound = verifyBoundSignerChallenge({ record: good, challenge, responseSigHex: impostorResp, now: now + 1_000 });
check("a different key answering → 'bad-response'", !notBound.ok && notBound.reason === 'bad-response');

// negative: expired
const exp = verifyBoundSignerChallenge({ record: good, challenge, responseSigHex: response, now: challenge.exp + 1 });
check("past exp → 'expired'", !exp.ok && exp.reason === 'expired');

// negative: record attests a different κ than the challenge
const otherKappaRec = signedRecord({ kappa: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' as Kappa });
const km = verifyBoundSignerChallenge({ record: otherKappaRec, challenge, responseSigHex: response, now: now + 1_000 });
check("record κ ≠ challenge κ → 'kappa-mismatch'", !km.ok && km.reason === 'kappa-mismatch');

// negative: replaying a response to a DIFFERENT challenge (fresh nonce) fails
const challenge2 = issueBoundSignerChallenge({ kappa: KAPPA, audience: 'warden:kb-admit', ttlMs: 120_000, now });
check('nonce differs per challenge', challenge2.nonce !== challenge.nonce);
const replay = verifyBoundSignerChallenge({ record: good, challenge: challenge2, responseSigHex: response, now: now + 1_000 });
check('response to challenge #1 rejected on challenge #2 (anti-replay)', replay.ok === false);

console.log('');
if (failures > 0) {
  console.error(`FAILED — ${failures} check(s) did not pass.`);
  process.exit(1);
}
console.log('PASS — bound-signer verification & challenge enforce import ≠ control.');
