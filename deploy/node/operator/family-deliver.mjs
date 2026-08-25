// family-deliver.mjs — DIDComm today's family report to each member, as a provenance card FROM aegis.
// Runs in a container joined to aegis_internal (reaches the aegis Warden control plane + gatekeeper).
// Input env: HEARTHOLD_PASSPHRASE + HEARTHOLD_DATA_ROOT (aegis agent dir @ /data), RECIPIENTS=[[name,did],...],
// WARDEN_URL, REPORT_PATH. Mints a familyMessage-shaped card per recipient + passes it via the gated
// /api/card/pass (the aegis Signet self-approves the provenance co-sign). Same path hearthold_send uses.
import { openKeymaster, loadConfig } from '@hearthold/core';
import { readFileSync } from 'node:fs';

const report = readFileSync(process.env.REPORT_PATH, 'utf8');
const recipients = JSON.parse(process.env.RECIPIENTS || '[]');
const wardenUrl = process.env.WARDEN_URL || 'http://aegis-agent-warden:4310';

const h = await openKeymaster('warden', loadConfig(), process.env.HEARTHOLD_PASSPHRASE);
const km = h.keymaster;
// Same shape hearthold_send / hearthold_messages use, so the report decodes as a normal message (kind marks it).
const schema = await km.createSchema({
  $schema: 'http://json-schema.org/draft-07/schema#', type: 'object',
  properties: { message: { type: 'string' }, from: { type: 'string' }, ts: { type: 'string' }, kind: { type: 'string' } },
  required: ['message'],
});

let ok = 0;
for (const [name, did] of recipients) {
  try {
    const bound = await km.bindCredential(did, { schema, claims: { message: report, from: 'aegis', ts: new Date().toISOString(), kind: 'family-report' } });
    const cardDid = await km.issueCredential(bound);
    const r = await fetch(`${wardenUrl}/api/card/pass`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toDid: did, credentialDid: cardDid, readable: false }),
    });
    const jr = await r.json().catch(() => ({}));
    if (r.ok && jr.ok !== false) { console.log(`  ${name}: delivered (…${String(cardDid).slice(-8)})`); ok++; }
    else console.log(`  ${name}: FAILED — ${jr.error || ('HTTP ' + r.status)}`);
  } catch (e) { console.log(`  ${name}: ERROR — ${e.message}`); }
}
process.exit(ok === recipients.length ? 0 : 1);
