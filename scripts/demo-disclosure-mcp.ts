/**
 * demo (task 7): the transport-binding leapfrog. A mock MCP endpoint challenges for ONE scope fact; the
 * holder responds with a Pattern-A Presentation encrypted to the endpoint; the endpoint verifies and
 * authorizes — WITHOUT seeing the rest of the credential. Runnable walkthrough (not assertions).
 *
 *   HEARTHOLD_GATEKEEPER_URL=http://flaxlap.local:4222 HEARTHOLD_REGISTRY=local \
 *   node --experimental-strip-types scripts/demo-disclosure-mcp.ts
 */
import { randomUUID } from 'node:crypto';

import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  issueDisclosureCredential,
  assemblePresentation,
  verifyPresentation,
  type Disclosure,
  type Presentation,
  type KeymasterHandle,
} from '@hearthold/core';

const say = (m: string): void => process.stdout.write(`${m}\n`);

async function main(): Promise<void> {
  const config = loadConfig();
  const pass = 'hearthold-disclosure-mcp';
  const reg = config.registry;

  const warden = await openKeymaster('warden', config, pass); // the issuer
  const agent = await openKeymaster('verifier', config, pass); // the holder (an AI agent)
  const mcp = await openKeymaster('emissary', config, pass); // the mock MCP endpoint
  const wardenId = await ensureIdentity(warden, config);
  const agentId = await ensureIdentity(agent, config);
  const mcpId = await ensureIdentity(mcp, config);

  say('\n══════════ Pattern-A selective disclosure over a mock MCP transport ══════════');
  say(`  issuer (Warden): ${wardenId.did.slice(0, 30)}…`);
  say(`  holder (agent):  ${agentId.did.slice(0, 30)}…`);
  say(`  endpoint (MCP):  ${mcpId.did.slice(0, 30)}…`);

  // ── Issuance: a grant the agent holds, with a sensitive budget + api-key ref the endpoint must NOT see ──
  say('\n▸ Warden issues the agent a grant: scope, budget, apiKeyRef, tier (values encrypted to the agent)');
  const cred = await issueDisclosureCredential({
    issuer: warden,
    issuerName: wardenId.name,
    holder: agentId.did,
    properties: { scope: ['tools:read', 'tools:list'], budget: 500000, apiKeyRef: 'vault://prod/openai', tier: 'gold' },
    credentialType: 'McpAgentGrant',
    registry: reg,
  });
  say(`  signed digest array (opaque): [${cred.commitments.sd.map((h) => h.slice(0, 8) + '…').join(', ')}]`);

  // ── The endpoint challenges for exactly one property ──
  const challenge = { type: 'mcp/scope-challenge', requestedProperties: ['scope'], endpointDid: mcpId.did, nonce: randomUUID() };
  say(`\n▸ MCP endpoint → challenge: "prove your ${JSON.stringify(challenge.requestedProperties)} to call my tools"`);

  // ── Holder retrieves its disclosures from the ENCRYPTED payload, assembles a scope-only presentation ──
  await agent.keymaster.setCurrentId(agentId.name);
  const held = (await agent.keymaster.decryptJSON(cred.payloadDid)) as { disclosures: Disclosure[] };
  const presentation = assemblePresentation(cred.commitments, held.disclosures, challenge.requestedProperties);
  // Encrypt the presentation to the endpoint (pairwise — the transport binding). Only this DID crosses.
  const wireDid = await agent.keymaster.encryptJSON(presentation, challenge.endpointDid, { registry: reg });
  say(`  holder → response: encrypted Presentation asset ${wireDid.slice(0, 30)}… (scope disclosed; rest = bare digests)`);

  // ── Endpoint decrypts + verifies, learning ONLY scope ──
  await mcp.keymaster.setCurrentId(mcpId.name);
  const received = (await mcp.keymaster.decryptJSON(wireDid)) as Presentation;
  const result = await verifyPresentation(received, { keymaster: mcp as KeymasterHandle, expectedIssuer: wardenId.did });

  say('\n▸ MCP endpoint verifies:');
  say(`  signature over the digest array: ${result.ok ? 'VALID' : 'INVALID'} (issuer = Warden)`);
  say(`  disclosed to the endpoint: ${JSON.stringify(result.disclosed)}`);
  const wire = JSON.stringify(received);
  say(`  can the endpoint see the budget?   ${wire.includes('500000') ? 'YES (LEAK!)' : 'no'}`);
  say(`  can the endpoint see the apiKeyRef? ${wire.includes('vault://prod') ? 'YES (LEAK!)' : 'no'}`);

  // ── Authorization decision ──
  const scope = (result.disclosed?.scope as string[] | undefined) ?? [];
  const authorized = result.ok && scope.includes('tools:read');
  say(`\n▸ Authorization: ${authorized ? 'GRANTED — agent may call tools:read' : 'DENIED'}`);
  say(
    authorized && !wire.includes('500000') && !wire.includes('vault://prod')
      ? '\n✓ endpoint authorized on the scope fact ALONE — budget + apiKeyRef never left the holder\n'
      : '\n✗ demo did not hold its invariants\n',
  );
  process.exit(authorized && !wire.includes('500000') && !wire.includes('vault://prod') ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`demo-disclosure-mcp: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
