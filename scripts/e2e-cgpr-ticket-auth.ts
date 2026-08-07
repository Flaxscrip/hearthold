/**
 * e2e: the CGPR ticket is broker B's VOUCH for C — B signs it, the gateway verifies B's signature + that B
 * is a trusted broker. Closes the audit's "unsigned ticket / self-asserted requester" gap without touching
 * the A2A envelope. Live against Archon.
 *
 * A signed ticket from a trusted broker verifies; forgeries are refused: an unsigned ticket, a ticket from
 * an untrusted broker, and a tampered ticket. Also verified via a trust registry (broker ∈ broker group).
 * Run: HEARTHOLD_DATA_ROOT=$(mktemp -d) HEARTHOLD_NODE_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *      node --experimental-strip-types scripts/e2e-cgpr-ticket-auth.ts
 */
import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  GroupTrustRegistry,
  createRegistryGroup,
  grantAuthorization,
} from '@hearthold/core';
import { signTicket, makeTicketVerifier } from '@hearthold/a2a-gateway';
import type { CgprTicket } from '@hearthold/cgpr-types';

const line = (m: string): void => process.stdout.write(`${m}\n`);
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  line(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-cgpr-ticket-auth-e2e';
  const reg = config.registry;

  const broker = await openKeymaster('sovereign', config, pass); // stands in for broker B
  const attacker = await openKeymaster('emissary', config, pass); // an untrusted broker
  const gateway = await openKeymaster('verifier', config, pass); // the gateway's resolution keymaster
  const bId = await ensureIdentity(broker, config);
  const atkId = await ensureIdentity(attacker, config);
  await ensureIdentity(gateway, config);

  const ticket = (): CgprTicket => ({
    ticketId: randomUUID(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    singleUse: true,
    scopes: ['foodAndBeverage.dietaryRestrictions'],
    purpose: 'menu personalization',
  });

  line('\n════ static allowlist: broker B is trusted ════');
  const verify = makeTicketVerifier({ keymaster: gateway, trustedBrokers: [bId.did] });

  const signed = await signTicket(broker, bId.name, ticket());
  const ok = await verify(signed);
  check('signed ticket from the trusted broker → verified', ok.ok && ok.broker === bId.did, ok.ok ? '' : ok.reason);

  line('\n════ forgeries the gateway must refuse ════');
  const a1 = await verify(ticket()); // unsigned
  check('unsigned ticket → refused', !a1.ok, a1.ok ? '' : a1.reason);

  const forged = await signTicket(attacker, atkId.name, ticket()); // signed by an UNTRUSTED broker
  const a2 = await verify(forged);
  check('ticket from an untrusted broker → refused', !a2.ok, a2.ok ? '' : a2.reason);

  const tampered = { ...(await signTicket(broker, bId.name, ticket())), scopes: ['health.medicalConditions'] };
  const a3 = await verify(tampered as CgprTicket); // scopes escalated after signing
  check('tampered ticket (scopes changed after signing) → refused', !a3.ok, a3.ok ? '' : a3.reason);

  line('\n════ trust registry: broker authorized via a broker group (TRQP) ════');
  await broker.keymaster.setCurrentId(bId.name);
  const brokerGroup = await createRegistryGroup(broker, 'cgpr-brokers', reg);
  await grantAuthorization(broker, brokerGroup, bId.did);
  // A registry that authorizes any member of the broker group to `issue` a `cgpr-ticket`.
  const registry = new GroupTrustRegistry(gateway, [{ action: 'issue', resource: 'cgpr-ticket', group: brokerGroup }]);
  const verifyReg = makeTicketVerifier({ keymaster: gateway, brokerRegistry: registry });
  const okReg = await verifyReg(await signTicket(broker, bId.name, ticket()));
  check('registry-authorized broker → verified', okReg.ok, okReg.ok ? '' : okReg.reason);
  const denyReg = await verifyReg(await signTicket(attacker, atkId.name, ticket()));
  check('non-registered broker → refused', !denyReg.ok, denyReg.ok ? '' : denyReg.reason);

  line(`\n${failures === 0 ? '✅ ALL PASS' : `❌ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`\nFATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
