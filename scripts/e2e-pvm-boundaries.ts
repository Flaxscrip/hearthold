/**
 * e2e: PVM-BOUNDARIES — the architectural invariants that otherwise live only in prose, encoded so a
 * refactor that erodes one goes RED. Each check names the principle it guards and is tagged:
 *
 *   [STRUCTURAL]   — enforced by the type system; the guard is a `@ts-expect-error` (or a type shape) that
 *                    the build (`tsc`) checks. If the invariant breaks, the BUILD fails before this runs.
 *   [OBSERVATIONAL] — checked at runtime by scanning a real wire artifact or the source. Weaker: it catches
 *                     what it looks for, not what it doesn't.
 *
 *   B1 CUSTODIAN/ACTOR SEPARATION — the Warden opens no connection to a foreign endpoint.
 *   B2 HUMAN ROOT                 — authority not rooted in the Sovereign is not exercisable.
 *   B3 PROVE-THE-FACT             — only the derived claim leaves; no sibling rung's fact rides along.
 *   B4 PAIRWISE DISCLOSURE        — every boundary-crossing artifact is encrypted to a specific recipient.
 *   B5 NO REPUTATION              — no aggregate principal score; confidence stays per-edge, decomposable.
 *   B6 GATEKEEPER PURITY          — no code path imports a foreign DID into the node's OWN Gatekeeper.
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-pvm-boundaries.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  issueRecognition,
  presentRecognition,
  createStatusList,
  createAllocationRecord,
  StatusListResolver,
  MeshWarden,
  receiveAnswer,
  type MeshPolicy,
  type MeshQuery,
  type MeshQueryEnvelope,
  type PartitionLadder,
  type IssuedDisclosureCredential,
} from '@hearthold/core';

let failures = 0;
const red: string[] = [];
const check = (principle: string, tag: 'STRUCTURAL' | 'OBSERVATIONAL', label: string, ok: boolean): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} [${tag}] ${principle}: ${label}\n`);
  if (!ok) {
    failures += 1;
    red.push(`${principle} — ${label}`);
  }
};
const step = (m: string): void => process.stdout.write(`\n▸ ${m}\n`);

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

/** Walk a package's src for .ts files (excludes .d.ts). */
function srcFiles(pkgSrc: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(pkgSrc, { withFileTypes: true, recursive: true })) {
    if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) {
      out.push(join(ent.parentPath ?? pkgSrc, ent.name));
    }
  }
  return out;
}
/** Non-comment lines matching a needle, as `path:line`. Skips `//`, `*`, and ` * ` doc lines. */
function callSites(files: string[], needle: RegExp): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((ln, i) => {
      const t = ln.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (needle.test(ln)) hits.push(`${f.replace(repo + '/', '')}:${i + 1}`);
    });
  }
  return hits;
}

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-pvm-boundaries';
  const reg = base.registry;
  const cfgA = { ...base, dataRoot: join(base.dataRoot, 'A') };
  const cfgB = { ...base, dataRoot: join(base.dataRoot, 'B') };
  const cfgX = { ...base, dataRoot: join(base.dataRoot, 'X') }; // imposter (non-Sovereign) root

  process.stdout.write(`PVM-BOUNDARIES\n  node: ${base.nodeUrl}\n  registry: ${reg}\n`);

  step('Provision B (Sovereign + Warden), A (presenter), X (imposter root)');
  const aEmissary = await openKeymaster('emissary', cfgA, pass);
  const bSov = await openKeymaster('sovereign', cfgB, pass);
  const bWarden = await openKeymaster('warden', cfgB, pass);
  const xSov = await openKeymaster('sovereign', cfgX, pass);
  const aEmId = await ensureIdentity(aEmissary, cfgA);
  const bSovId = await ensureIdentity(bSov, cfgB);
  const bWardenId = await ensureIdentity(bWarden, cfgB);
  const xSovId = await ensureIdentity(xSov, cfgX);

  const { statusListCredential } = await createStatusList(bSov, bSovId.name, cfgB);
  const allocationRecord = await createAllocationRecord(bSov, bSovId.name, cfgB);
  const xStatus = await createStatusList(xSov, xSovId.name, cfgX);
  const xAlloc = await createAllocationRecord(xSov, xSovId.name, cfgX);

  // A 2-rung ladder: world-public (reachable) + close-friend (gated). The gate code is the "sibling fact"
  // that must NEVER ride along in a world-public answer (B3).
  const tierOrder = ['world', 'close-friend'];
  const GATE_CODE = '4-8-1-5';
  const ladder: PartitionLadder = [
    { name: 'world-public', domain: 'fences', access: { minTier: 'world', maxArrivalDepth: 2 }, facts: [{ ref: 'post-spacing', provenance: 'asserted', confidence: 1, keywords: ['post', 'spacing', 'apart'], narrative: 'Set fence posts 8 feet on center.' }] },
    { name: 'close-friend', domain: 'fences', access: { minTier: 'close-friend', maxArrivalDepth: 1 }, facts: [{ ref: 'gate-code', provenance: 'asserted', confidence: 1, keywords: ['gate', 'code'], narrative: `The side gate code is ${GATE_CODE}.` }] },
  ];
  const statusList = new StatusListResolver(bWarden, { statusListCredential, expectedIssuer: bSovId.did, maxAgeMs: 60_000 });
  const policy: MeshPolicy = { recognizedIssuer: bSovId.did, tierOrder, statusList };
  const meshB = new MeshWarden(bWarden, bWardenId.name, cfgB, policy, ladder);

  const q = (text: string): MeshQuery => ({ text, mode: 'fact', domain: 'fences', budget: { maxNodes: 1, rate: 1 }, arrivalDepth: 1 });
  const askWith = (rec: IssuedDisclosureCredential) =>
    meshB.handle({ query: q('how far apart should posts be?'), recognition: presentRecognition(rec), presenterDid: aEmId.did } as MeshQueryEnvelope);

  // ── B1 — CUSTODIAN/ACTOR SEPARATION ─────────────────────────────────────────────────────────────────
  step('B1 CUSTODIAN/ACTOR SEPARATION — the Warden constructs from local handles and opens no foreign connection');
  // STRUCTURAL: MeshWarden's only "external" arg is the OWN-node forwarding capability, never a peer URL.
  // If someone widens the constructor to take a foreign endpoint, this @ts-expect-error goes stale → build fails.
  // @ts-expect-error B1: MeshWarden takes no foreign endpoint/transport argument (6th arg is MeshForwarding, not a URL)
  const _b1: MeshWarden = new MeshWarden(bWarden, bWardenId.name, cfgB, policy, ladder, 'http://foreign.example/didcomm');
  void _b1;
  check('B1 CUSTODIAN/ACTOR SEPARATION', 'STRUCTURAL', 'MeshWarden constructor rejects a foreign endpoint arg (enforced by @ts-expect-error at build)', true);
  // OBSERVATIONAL: the mesh answer path itself opens no network client — it signs + encrypts locally and
  // delegates all resolution to the Warden's own Keymaster/Gatekeeper. Scan mesh.ts for a direct client.
  const meshSrc = readFileSync(join(repo, 'packages/core/src/mesh.ts'), 'utf8');
  const foreignClient = /\b(fetch|axios|undici|http\.request|https\.request|new WebSocket|net\.connect)\b/;
  check('B1 CUSTODIAN/ACTOR SEPARATION', 'OBSERVATIONAL', 'mesh.ts opens no direct network client (no fetch/axios/socket)', !foreignClient.test(meshSrc));

  // ── B2 — HUMAN ROOT ─────────────────────────────────────────────────────────────────────────────────
  step('B2 HUMAN ROOT — a recognition NOT rooted in the Sovereign is not exercisable');
  const recWorld = await issueRecognition({ issuer: bSov, issuerName: bSovId.name, subject: aEmId.did, scope: { tier: 'world', confidence: 0.9, domain: 'fences', mode: 'fact', maxDepth: 2 }, statusListCredential, allocationRecord, registry: reg });
  const recImposter = await issueRecognition({ issuer: xSov, issuerName: xSovId.name, subject: aEmId.did, scope: { tier: 'world', confidence: 0.9, domain: 'fences', mode: 'fact', maxDepth: 2 }, statusListCredential: xStatus.statusListCredential, allocationRecord: xAlloc, registry: reg });
  const grantSov = await askWith(recWorld);
  const grantImposter = await askWith(recImposter);
  check('B2 HUMAN ROOT', 'OBSERVATIONAL', 'the Sovereign-rooted recognition is admitted (granted)', grantSov.status === 'granted');
  check('B2 HUMAN ROOT', 'OBSERVATIONAL', 'a recognition signed by a non-Sovereign root is REJECTED at admission', grantImposter.status === 'rejected');

  // ── B3 — PROVE-THE-FACT ─────────────────────────────────────────────────────────────────────────────
  step('B3 PROVE-THE-FACT — the granted world-public answer carries ONLY its rung’s fact, never the gate code');
  const rWorld = await receiveAnswer({ emissary: aEmissary, emissaryName: aEmId.name, answerDid: grantSov.status === 'granted' ? grantSov.answerDid : '', expectedIssuer: bWardenId.did });
  const wire = JSON.stringify(rWorld.answer ?? {});
  check('B3 PROVE-THE-FACT', 'OBSERVATIONAL', 'answer contains the derived claim (post-spacing)', rWorld.ok === true && wire.includes('post-spacing'));
  check('B3 PROVE-THE-FACT', 'OBSERVATIONAL', `no sibling rung fact rides along (gate code "${GATE_CODE}" absent)`, !wire.includes(GATE_CODE) && !/gate code/i.test(wire));

  // ── B4 — PAIRWISE DISCLOSURE ────────────────────────────────────────────────────────────────────────
  step('B4 PAIRWISE DISCLOSURE — the boundary-crossing artifact is encrypted to a specific recipient DID');
  const answerDid = grantSov.status === 'granted' ? grantSov.answerDid : '';
  check('B4 PAIRWISE DISCLOSURE', 'OBSERVATIONAL', 'the artifact is an encrypted did:cid, not plaintext', answerDid.startsWith('did:'));
  // Only the intended recipient (A) can open it. Test with an UNRELATED third party (X) — not the Warden,
  // which authored it and can read back its own encrypt-for-sender output. X is neither sender nor recipient.
  await xSov.keymaster.setCurrentId(xSovId.name);
  let nonRecipientOpened = true;
  try {
    await xSov.keymaster.decryptJSON(answerDid);
  } catch {
    nonRecipientOpened = false;
  }
  check('B4 PAIRWISE DISCLOSURE', 'OBSERVATIONAL', 'an unrelated third-party DID cannot decrypt the artifact', nonRecipientOpened === false);

  // ── B5 — NO REPUTATION ──────────────────────────────────────────────────────────────────────────────
  step('B5 NO REPUTATION — the returned structure carries no aggregate principal score; confidence is decomposable');
  const ans = rWorld.answer as Record<string, unknown>;
  const forbidden = ['score', 'reputation', 'rating', 'trustScore', 'trust_score', 'aggregate'];
  const keysDeep = JSON.stringify(ans);
  const hasForbidden = forbidden.some((k) => new RegExp(`"${k}"\\s*:`).test(keysDeep));
  check('B5 NO REPUTATION', 'OBSERVATIONAL', 'no aggregate principal score field (score/reputation/rating/…)', !hasForbidden);
  // The confidence that IS present is per-fact and per-recognition-path — decomposable, not a single number
  // standing in for a principal's trustworthiness.
  check('B5 NO REPUTATION', 'OBSERVATIONAL', 'confidence is decomposable (factConfidence ∧ recognitionConfidence present)', typeof ans?.factConfidence === 'number' && typeof ans?.recognitionConfidence === 'number');

  // ── B6 — GATEKEEPER PURITY ──────────────────────────────────────────────────────────────────────────
  step('B6 GATEKEEPER PURITY — importing a foreign DID into the node’s OWN Gatekeeper is IMPOSSIBLE BY TYPE');
  // STRUCTURAL: the node's own handle is a PrivateGatekeeper with the import methods removed (keymaster.ts),
  // so this call does not type-check. If someone re-adds importDIDs to PrivateGatekeeper, the @ts-expect-error
  // goes unused and the BUILD fails — the invariant can no longer silently regress.
  void (async () => {
    // @ts-expect-error B6 STRUCTURAL: PrivateGatekeeper omits importDIDs — importing foreign ops into the node's own gatekeeper is a type error
    await bWarden.gatekeeper.importDIDs([]);
  });
  check('B6 GATEKEEPER PURITY', 'STRUCTURAL', "the node's own gatekeeper cannot import foreign ops (PrivateGatekeeper omits importDIDs — @ts-expect-error, build-enforced)", true);
  // OBSERVATIONAL: any surviving importDIDs/importBatch call must live ONLY in the sanctioned DMZ module,
  // which imports into an ephemeral, peerless instance — never a node-own handle.
  const allSrc: string[] = [];
  for (const pkg of readdirSync(join(repo, 'packages'), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(repo, 'packages', pkg.name, 'src');
    try {
      allSrc.push(...srcFiles(src));
    } catch {
      /* no src dir */
    }
  }
  const imports = callSites(allSrc, /\.(importDIDs|importBatch)\s*\(/);
  const strays = imports.filter((loc) => !loc.startsWith('packages/core/src/dmz.ts:'));
  check('B6 GATEKEEPER PURITY', 'OBSERVATIONAL', `imports are confined to the DMZ module${strays.length ? ` — STRAY import outside dmz.ts: ${strays.join(', ')}` : ' (dmz.ts only)'}`, strays.length === 0);

  // ── Summary ─────────────────────────────────────────────────────────────────────────────────────────
  process.stdout.write('\n' + '─'.repeat(78) + '\n');
  if (failures === 0) {
    process.stdout.write('✓ PVM-BOUNDARIES: all six invariants hold\n');
  } else {
    process.stdout.write(`✗ PVM-BOUNDARIES: ${failures} invariant(s) RED — the most valuable output of this run:\n`);
    for (const r of red) process.stdout.write(`    • ${r}\n`);
    process.stdout.write('  (Do NOT weaken behaviour to go green — see docs/pvm-boundaries/RESULTS.md.)\n');
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-pvm-boundaries: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
