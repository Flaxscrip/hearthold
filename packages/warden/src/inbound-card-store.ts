import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IssuedLeaf } from '@hearthold/core';
import type { CardReceivedEvent } from '@hearthold/control-types';

/**
 * A pending inbound card AS STORED — the wire `CardReceivedEvent` plus the **verified closure** kept
 * server-side. The closure is the ONLY thing retained from a cross-node card's DMZ verification (never the
 * raw foreign ops); accept promotes it into the vault. `closure` is absent when verification failed
 * (`verified:false`) — accept then refuses, fail-closed. The closure never crosses the wire (see `list`).
 */
export interface StoredInboundCard extends CardReceivedEvent {
  closure?: IssuedLeaf;
  /** The exact DMZ-verified version the chain resolved to (provenance pin). */
  versionId?: string;
}

/**
 * The pending-inbound queue: cards passed from ANOTHER node, verified at receipt but NOT yet imported into
 * the vault. Distinct from the local triage queue (that is "my Emissary stored something"); these are "a
 * counterparty passed me a card." A member accepts one explicitly (`/api/card/accept`), which promotes the
 * verified closure; until then it sits here, born obsidian, so the Table can render a receive surface.
 * File-backed, upserted by `credentialDid` (a re-delivery replaces, never duplicates).
 */
export class InboundCardStore {
  private readonly path: string;
  constructor(dataFolder: string) {
    this.path = join(dataFolder, 'inbound-cards.json');
  }
  private read(): StoredInboundCard[] {
    try {
      return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as StoredInboundCard[]) : [];
    } catch {
      return [];
    }
  }
  private write(list: StoredInboundCard[]): void {
    writeFileSync(this.path, JSON.stringify(list, null, 2));
  }
  put(card: StoredInboundCard): void {
    const list = this.read().filter((c) => c.credentialDid !== card.credentialDid);
    list.push(card);
    this.write(list);
  }
  /** Pending inbound cards for the wire — scoped to `owner`, with the server-side closure STRIPPED. */
  list(owner?: string): CardReceivedEvent[] {
    const list = this.read().filter((c) => (owner ? c.owner === owner : true));
    return list.map(({ closure: _closure, versionId: _versionId, ...card }) => card);
  }
  /** The full stored card INCLUDING its verified closure — for the accept route only, never the wire. */
  getStored(credentialDid: string): StoredInboundCard | undefined {
    return this.read().find((c) => c.credentialDid === credentialDid);
  }
  remove(credentialDid: string): void {
    this.write(this.read().filter((c) => c.credentialDid !== credentialDid));
  }
}
