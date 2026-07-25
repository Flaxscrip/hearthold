import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CardReceivedEvent } from '@hearthold/control-types';

/**
 * The pending-inbound queue: cards passed from ANOTHER node that have been verified but NOT yet imported
 * into the vault. Distinct from the local triage queue (that is "my Emissary stored something"); these are
 * "a counterparty passed me a card." A member accepts one explicitly (a future `/api/card/accept`), which
 * imports it; until then it sits here, born obsidian, so the Table can render a receive surface. File-backed,
 * upserted by `credentialDid` (a re-delivery replaces, never duplicates).
 */
export class InboundCardStore {
  private readonly path: string;
  constructor(dataFolder: string) {
    this.path = join(dataFolder, 'inbound-cards.json');
  }
  private read(): CardReceivedEvent[] {
    try {
      return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as CardReceivedEvent[]) : [];
    } catch {
      return [];
    }
  }
  private write(list: CardReceivedEvent[]): void {
    writeFileSync(this.path, JSON.stringify(list, null, 2));
  }
  put(card: CardReceivedEvent): void {
    const list = this.read().filter((c) => c.credentialDid !== card.credentialDid);
    list.push(card);
    this.write(list);
  }
  /** Pending inbound cards, scoped to `owner` (the recipient member) when given. */
  list(owner?: string): CardReceivedEvent[] {
    const list = this.read();
    return owner ? list.filter((c) => c.owner === owner) : list;
  }
  remove(credentialDid: string): void {
    this.write(this.read().filter((c) => c.credentialDid !== credentialDid));
  }
}
