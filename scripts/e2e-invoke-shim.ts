/**
 * e2e: the keyless invoke-shim on the Emissary daemon (Sevenfold's ask) — the Table's Forge path.
 *
 * A browser has no keymaster, so it POSTs an intent to the Emissary control API and the wallet-holding daemon
 * runs the full invocation ceremony. This drives the real HTTP routes:
 *   POST /api/accept-capability  → the daemon holds the Sovereign-granted scope VC
 *   POST /api/invoke             → GRANTED (the Warden mints an evidence graph) | denied (verbatim reason)
 *
 *   HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/e2e-invoke-shim.ts
 */
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  ensureAuthorizationSchema,
  issueScopeCapability,
  DidCommTransport,
  Sensitivity,
} from '@hearthold/core';
import { VaultStore } from '@hearthold/warden/store';
import { WardenService } from '@hearthold/warden/service';
import { EvidenceService } from '@hearthold/warden/evidence';
import { DelegationStore } from '@hearthold/warden/delegations';
import { ChallengeStore } from '@hearthold/warden/challenge-store';
import { makeWardenHandler } from '@hearthold/warden/handler';
import { runEmissaryControl } from '@hearthold/emissary/control';
import type { InvokeResponse, AcceptCapabilityResponse } from '@hearthold/control-types';

const PORT = 4366;
const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const unwrap = <T,>(r: { ok: boolean } & Record<string, unknown>): T => {
  if (!r.ok) throw new Error(String(r.error));
  const { ok: _ok, ...rest } = r;
  return rest as unknown as T;
};
const post = async <T,>(path: string, body: unknown): Promise<T> =>
  unwrap<T>((await (await fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as { ok: boolean } & Record<string, unknown>);

async function main(): Promise<void> {
  const base = loadConfig();
  const pass = 'hearthold-invoke-shim-e2e';
  const VAULT = 'hearthold:vault';

  const warden = await openKeymaster('warden', base, pass);
  const sovereign = await openKeymaster('sovereign', base, pass);
  const emissary = await openKeymaster('emissary', { ...base, dataRoot: `${base.dataRoot}/emissary` }, pass);
  const wardenId = await ensureIdentity(warden, base);
  const sovId = await ensureIdentity(sovereign, base);
  const emiId = await ensureIdentity(emissary, { ...base, dataRoot: `${base.dataRoot}/emissary` });
  const cfg = { ...base, sovereignDid: sovId.did };

  const store = new VaultStore(warden.dataFolder);
  const now = new Date().toISOString();
  await store.put({ id: 'art-fr', kind: 'location', observedAt: now, storedAt: now, sensitivity: Sensitivity.LOW, ciphertext: 'x', metadata: { witness: 'device-A' }, owner: sovId.did });

  // The Sovereign grants a LOW/location scope capability (what /api/authorize-capability issues at the Signet).
  await warden.keymaster.setCurrentId(wardenId.name);
  const authSchema = await ensureAuthorizationSchema(warden);
  const capDid = await issueScopeCapability({
    issuer: sovereign, issuerName: sovId.name, holder: emiId.did, schemaDid: authSchema, config: base,
    scope: { invocationTarget: VAULT, authority: { operations: ['prove'], resources: [VAULT] }, caveats: { ceiling: Sensitivity.LOW, owner: sovId.did, kinds: ['location'] } },
  });

  // Warden serves the full handler over DIDComm.
  const challenges = new ChallengeStore(warden, base.registry, sovId.did);
  const handler = makeWardenHandler(new WardenService(warden), new DelegationStore(warden), new EvidenceService(warden, cfg), undefined, sovId.did, undefined, undefined, challenges);
  const wardenTransport = new DidCommTransport(warden, wardenId.name, base.nodeUrl);
  await wardenTransport.ready();
  const stopWarden = await wardenTransport.serve(handler, { pollMs: 1000 });

  // Boot the Emissary control daemon (owns its mailbox; the invoke-shim runs the ceremony on the loop).
  await runEmissaryControl(emissary, { ...base, dataRoot: `${base.dataRoot}/emissary`, wardenDid: wardenId.did }, PORT);

  try {
    line('\n════ the Table drives the keyless Forge ════');

    const accepted = await post<AcceptCapabilityResponse>('/api/accept-capability', { credentialDid: capDid });
    check('POST /api/accept-capability → the daemon holds the scope capability', accepted.accepted === true);

    const granted = await post<InvokeResponse>('/api/invoke', { claim: 'resided in FR during 2026-H1', kind: 'location' });
    check('POST /api/invoke (location, within grant) → GRANTED with a credential', granted.status === 'granted' && !!(granted as { credentialDid?: string }).credentialDid, granted.status === 'denied' ? granted.reason : '');

    // A kind OUTSIDE the grant is refused — the caveats bind every invoke, even from a compromised browser.
    const denied = await post<InvokeResponse>('/api/invoke', { claim: 'read a book', kind: 'book' });
    check('POST /api/invoke (book, outside grant) → DENIED', denied.status === 'denied', denied.status);
  } finally {
    await stopWarden();
  }

  line(`\n${failures === 0 ? '✅ INVOKE-SHIM LIVE — grant → accept → Forge over local HTTP' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
