/**
 * e2e: CGPR schemas (A2A brief §4.2) — the four wire objects register as Archon schema DIDs, and the
 * pre-approval objects are STRUCTURALLY incapable of naming the subject (conformance rule #1, the
 * "assert by schema" half). No node writes beyond schema creation.
 *
 * Isolated under a throwaway data root; run:  npm run e2e:cgpr-schemas
 */
import { loadConfig, openKeymaster, ensureIdentity } from '@hearthold/core';
import {
  CGPR_EXTENSION_URI,
  CGPR_SCHEMAS,
  CgprTicketSchema,
  CgprRequestArtifactSchema,
  CgprDecisionSchema,
  registerCgprSchemas,
} from '@hearthold/cgpr-types';

const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
};

/** No `subject`/identifier property anywhere in an object schema, and additions are forbidden. */
function forbidsSubject(schema: { additionalProperties?: unknown; properties?: Record<string, unknown> }): boolean {
  const props = Object.keys(schema.properties ?? {});
  const banned = ['subject', 'subjectDid', 'sub', 'holder', 'account', 'accountId', 'id'];
  return schema.additionalProperties === false && !props.some((p) => banned.includes(p));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const warden = await openKeymaster('warden', config, 'hearthold-e2e-cgpr-schemas');
  await ensureIdentity(warden, config);

  // Structural (assert-by-schema): the pre-approval objects cannot carry A's identity.
  assert(forbidsSubject(CgprTicketSchema), 'CgprTicket must forbid a subject field (additionalProperties:false + none present)');
  assert(
    forbidsSubject(CgprRequestArtifactSchema) && forbidsSubject(CgprRequestArtifactSchema.properties.ticket),
    'CgprRequestArtifact + its embedded ticket must forbid a subject field',
  );
  // Denials leak nothing beyond the ticketId + decision.
  assert(
    CgprDecisionSchema.additionalProperties === false &&
      JSON.stringify(Object.keys(CgprDecisionSchema.properties).sort()) === JSON.stringify(['decision', 'ticketId']),
    'CgprDecision must be exactly { ticketId, decision } — no reason field',
  );
  // Single-use is pinned, not merely typed.
  assert(CgprTicketSchema.properties.singleUse.const === true, 'CgprTicket.singleUse must be const true');
  process.stdout.write('✓ structural: no subject field in ticket/request; denial carries only ticketId+decision\n');

  // Register all four as Archon schema DIDs (the same shapes verify on both sides of the bridge).
  const dids = await registerCgprSchemas(warden);
  for (const [name, did] of Object.entries(dids)) {
    assert(/^did:cid:/.test(did), `${name} schema must register as a did:cid (got ${did})`);
    const resolved = await warden.keymaster.getSchema(did);
    assert(resolved != null, `${name} schema must resolve on-node`);
    process.stdout.write(`  ${name.padEnd(20)} ${did.slice(0, 30)}…\n`);
  }
  assert(Object.keys(dids).length === Object.keys(CGPR_SCHEMAS).length, 'all four schemas must register');

  // Idempotent: re-registering returns the same DIDs.
  const again = await registerCgprSchemas(warden);
  assert(JSON.stringify(again) === JSON.stringify(dids), 'schema registration must be idempotent');

  process.stdout.write(`\n✓ CGPR schemas registered (extension ${CGPR_EXTENSION_URI})\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e-cgpr-schemas: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
