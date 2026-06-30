#!/usr/bin/env node
import {
  loadConfig,
  openKeymaster,
  ensureIdentity,
  GroupTrustRegistry,
  createRegistryGroup,
  grantAuthorization,
  revokeAuthorization,
  IDENTITY_NAME,
  type KeymasterHandle,
  type GroupBinding,
} from '@hearthold/core';

import { BindingStore } from './store.js';
import { startTrqpServer } from './serve.js';

const HELP = `Hearthold Registry — a TRQP trust registry over Archon groups

Authorize entities for an (action, resource): membership in the bound Archon group IS the
authorization. Outward, action 'issue' authorizes issuers for a schema; inward, action 'present'
grades a Witness's autonomy by sensitivity level.

Usage:
  registry init                                Provision the registry identity
  registry status                              Show identity and bindings
  registry bind <action> <resource> [group]    Create/reuse the (action,resource) group, or bind an
                                               existing group DID (e.g. a board's membership group)
  registry grant <action> <resource> <did>     Authorize <did> (add to the group)
  registry revoke <action> <resource> <did>    De-authorize <did> (remove from the group)
  registry check <action> <resource> <did>     Query: is <did> authorized?
  registry list                                List bindings and their members
  registry serve [port]                        Serve TRQP over HTTP (default port 4262)
  registry help                                Show this message

  <action>   ∈ issue | verify | hold | present | revoke
  <resource>   a schema DID (outward) or a sensitivity level e.g. HIGH (inward); '*' = any

Env:
  HEARTHOLD_PASSPHRASE   wallet passphrase (required)
  HEARTHOLD_NODE_URL     Archon node (Drawbridge) URL; default http://flaxlap.local:4222
  HEARTHOLD_DATA_ROOT    default ~/.hearthold
`;

/** Resource '*' (or missing) is the per-action wildcard, stored as undefined. */
const parseResource = (raw?: string): string | undefined => (!raw || raw === '*' ? undefined : raw);

/** A readable, reasonably-unique group name for an (action, resource). */
const groupName = (action: string, resource?: string): string =>
  `hearthold-${action}-${resource ? (resource.replace(/[^a-zA-Z0-9]+/g, '').slice(-16) || 'any') : 'any'}`;

/**
 * Find the binding for (action, resource). On first use, bind `existingGroup` if given (e.g. a group
 * created elsewhere, like a board's membership group), otherwise create a fresh group.
 */
async function ensureBinding(
  handle: KeymasterHandle,
  store: BindingStore,
  registry: string,
  action: string,
  resource?: string,
  existingGroup?: string,
): Promise<GroupBinding> {
  const existing = await store.find(action, resource);
  if (existing) return existing;
  const group = existingGroup ?? (await createRegistryGroup(handle, groupName(action, resource), registry));
  const all = await store.upsert({ action, resource, group });
  return all.find((b) => b.action === action && b.resource === resource) ?? { action, resource, group };
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig();
  const passphrase = process.env.HEARTHOLD_PASSPHRASE;
  if (!passphrase) throw new Error('HEARTHOLD_PASSPHRASE is required');

  const handle = await openKeymaster('registry', config, passphrase);
  const id = await ensureIdentity(handle, config);
  const store = new BindingStore(handle.dataFolder);

  switch (cmd) {
    case 'init': {
      process.stdout.write(`Registry ready\n  name: ${id.name}\n  did:  ${id.did}\n  data: ${handle.dataFolder}\n`);
      break;
    }
    case 'status': {
      const bindings = await store.load();
      process.stdout.write(
        `Registry ${id.did}\n  node: ${config.nodeUrl}\n  bindings: ${bindings.length}\n`,
      );
      break;
    }
    case 'bind': {
      const action = process.argv[3];
      const resource = parseResource(process.argv[4]);
      const existingGroup = process.argv[5]?.startsWith('did:') ? process.argv[5] : undefined;
      if (!action) throw new Error('usage: registry bind <action> <resource> [existingGroupDid]');
      const b = await ensureBinding(handle, store, config.registry, action, resource, existingGroup);
      process.stdout.write(`Bound ${action} / ${resource ?? '*'}\n  group: ${b.group}\n`);
      break;
    }
    case 'grant':
    case 'revoke': {
      const action = process.argv[3];
      const resource = parseResource(process.argv[4]);
      const entityDid = process.argv[5];
      if (!action || !entityDid) {
        throw new Error(`usage: registry ${cmd} <action> <resource> <did>`);
      }
      const b = await ensureBinding(handle, store, config.registry, action, resource);
      const ok =
        cmd === 'grant'
          ? await grantAuthorization(handle, b.group, entityDid)
          : await revokeAuthorization(handle, b.group, entityDid);
      process.stdout.write(
        `${cmd === 'grant' ? 'Granted' : 'Revoked'} ${action}/${resource ?? '*'} ${ok ? '✓' : '(no change)'}\n` +
          `  entity: ${entityDid.slice(0, 32)}…\n  group:  ${b.group.slice(0, 32)}…\n`,
      );
      break;
    }
    case 'check': {
      const action = process.argv[3];
      const resource = parseResource(process.argv[4]);
      const entityDid = process.argv[5];
      if (!action || !entityDid) throw new Error('usage: registry check <action> <resource> <did>');
      const evaluator = new GroupTrustRegistry(handle, await store.load(), id.did);
      const r = await evaluator.authorize({ entity_id: entityDid, action, resource });
      process.stdout.write(`${r.authorized ? '✓ AUTHORIZED' : '✗ NOT AUTHORIZED'}\n  ${r.message}\n`);
      process.exitCode = r.authorized ? 0 : 1;
      break;
    }
    case 'list': {
      const bindings = await store.load();
      if (bindings.length === 0) {
        process.stdout.write('No bindings yet. Use `registry grant` to authorize an entity.\n');
        break;
      }
      for (const b of bindings) {
        const group = await handle.keymaster.getGroup(b.group).catch(() => null);
        const members = group?.members ?? [];
        process.stdout.write(
          `${b.action} / ${b.resource ?? '*'}  →  ${members.length} member(s)\n` +
            members.map((m) => `    · ${m}\n`).join('') +
            `    [group ${b.group.slice(0, 28)}…]\n`,
        );
      }
      break;
    }
    case 'serve': {
      const port = Number(process.argv[3] ?? 4262);
      const evaluator = new GroupTrustRegistry(handle, await store.load(), id.did);
      const server = startTrqpServer(evaluator, { port, authorityId: id.did, registryName: IDENTITY_NAME.registry });
      process.stdout.write(
        `Registry serving TRQP on http://localhost:${port}\n  authority: ${id.did}\n` +
          `  POST /authorization {entity_id, action, resource}  ·  GET /metadata  ·  GET /health\n  (Ctrl-C to stop)\n`,
      );
      const shutdown = (): void => {
        server.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`registry: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
