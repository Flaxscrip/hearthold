/**
 * Cross-project interop proof: Hearthold's `HttpTrustRegistry` querying a **foreign** TRQP registry —
 * the live `archon-trust-registry` ("HATPro Trust Registry") that hatpro-archon runs on :4260, a
 * different codebase. This is the same client `verifyProof` uses via its `trustRegistry` option, so a
 * green run here means Hearthold can trust an ecosystem registry it did not build.
 *
 * Prereq: the reference registry must be running (`cd ~/projects/archon-trust-registry && npm run dev`,
 * port 4260). Entities default to that registry's current group members (public DIDs, discovered
 * 2026-06-30); override via env if the registry is re-provisioned.
 *
 * Run:  npm run interop:registry
 */

import { HttpTrustRegistry } from '@hearthold/core';

const URL = process.env.HATPRO_REGISTRY_URL ?? 'http://localhost:4260';
// Live HATPro registry group members (public DIDs). Override if the registry is re-provisioned.
const ADMIN_DID =
  process.env.HATPRO_ADMIN_DID ?? 'did:cid:bagaaierasr77mnht2tqsrzc6dc6svwi4eim36d66oozgvpz5fibvcg7av7na';
const MEMBER_DID =
  process.env.HATPRO_MEMBER_DID ?? 'did:cid:bagaaiera2wf5idh5p5mnjl2g7v3722l355dm6vug7uyxqxf24ng3ynsljb3a';
// A real, resolvable DID that is NOT in any of the registry's groups (hatpro-gov from the demo).
const OUTSIDER_DID =
  process.env.HATPRO_OUTSIDER_DID ?? 'did:cid:bagaaierajq7gh42sfkx4us4i5cafxa6ogdnhmr67g2owai2lvxhvco7haena';
// A HATPro schema (the resource being authorized).
const SCHEMA =
  process.env.HATPRO_SCHEMA ?? 'did:cid:bagaaieraxitfyqlqq73cmrbas3sskp6z2fpfsasx7wkq3c5qkahtkxkiyzra';

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures += 1;
};

async function main(): Promise<void> {
  process.stdout.write(`HttpTrustRegistry × foreign TRQP registry (cross-project interop)\n  registry: ${URL}\n`);

  // 1) Discover the registry over HTTP (proves it's a reachable TRQP v2.0 endpoint).
  let authorityId = '';
  try {
    const meta = (await fetch(`${URL}/metadata`).then((r) => r.json())) as {
      registry_id?: string;
      registry_name?: string;
      name?: string;
      trqp_version?: string;
    };
    authorityId = String(meta.registry_id ?? '');
    process.stdout.write(`  found: ${meta.registry_name ?? meta.name ?? '(unnamed)'} · TRQP ${meta.trqp_version}\n  authority: ${authorityId}\n\n`);
    check('discovered a TRQP v2.0 registry', meta.trqp_version === '2.0' && authorityId.startsWith('did:'));
  } catch (e) {
    process.stderr.write(
      `\nCannot reach ${URL}. Start the reference registry:\n` +
        `  cd ~/projects/archon-trust-registry && npm run dev   (port 4260)\n` +
        `  (${e instanceof Error ? e.message : String(e)})\n`,
    );
    process.exitCode = 1;
    return;
  }

  // 2) Query it with OUR client (the same one verifyProof uses).
  const registry = new HttpTrustRegistry(URL, authorityId);
  const ask = async (entity: string, action: string) => registry.authorize({ entity_id: entity, action, resource: SCHEMA });

  const adminIssue = await ask(ADMIN_DID, 'issue');
  check('admin entity authorized to ISSUE', adminIssue.authorized === true, adminIssue.message);

  const adminVerify = await ask(ADMIN_DID, 'verify');
  check('admin entity authorized to VERIFY', adminVerify.authorized === true, adminVerify.message);

  const memberIssue = await ask(MEMBER_DID, 'issue');
  check('member entity NOT authorized to ISSUE (role-scoped)', memberIssue.authorized === false, memberIssue.message);

  const memberVerify = await ask(MEMBER_DID, 'verify');
  check('member entity authorized to VERIFY', memberVerify.authorized === true, memberVerify.message);

  const outsiderIssue = await ask(OUTSIDER_DID, 'issue');
  check('non-member entity NOT authorized', outsiderIssue.authorized === false, outsiderIssue.message);

  process.stdout.write(`\n${failures === 0 ? 'PASS — our HttpTrustRegistry interoperates with the foreign registry' : `FAIL (${failures})`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`\ninterop error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
