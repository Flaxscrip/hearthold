/**
 * The Sovereign's WATCH backend (item 5) — the live delegation forest it governs.
 *
 * A root the Sovereign mints, and every hop an agent's Emissary reports (`hearthold/hop-registered`), is recorded
 * here as a node linked to its parent. `forest()` assembles the tree the human (or an AI-agent parent) watches —
 * who delegated authority to whom, how deep, and which hops are revoked. Provenance only: no caveats, no secrets.
 * The reports are hints the Sovereign can independently verify against the public chain (`reconstructLineage`).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface LineageRecord {
  vcDid: string;
  /** null for a root the Sovereign minted; else the parent hop's Asset DID. */
  parentVcDid: string | null;
  /** The hop's issuer (controller) — the Sovereign for a root, a delegating agent for a hop. */
  issuer?: string;
  /** Who holds (may invoke / further-delegate) this hop. */
  holder: string;
  counter: number;
  ts: string;
  revoked?: boolean;
}

/** A rendered tree node (children nested) for the watch UI. */
export interface LineageTreeNode extends LineageRecord {
  children: LineageTreeNode[];
}

export class LineageStore {
  private readonly file: string;
  constructor(private readonly dataFolder: string) {
    this.file = join(dataFolder, 'lineage.json');
  }
  private async all(): Promise<LineageRecord[]> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as LineageRecord[];
    } catch {
      return [];
    }
  }
  async record(r: LineageRecord): Promise<void> {
    await mkdir(this.dataFolder, { recursive: true });
    const all = (await this.all()).filter((x) => x.vcDid !== r.vcDid);
    all.push(r);
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
  }
  async markRevoked(vcDid: string): Promise<boolean> {
    const all = await this.all();
    const n = all.find((x) => x.vcDid === vcDid);
    if (!n) return false;
    n.revoked = true;
    await writeFile(this.file, JSON.stringify(all, null, 2), 'utf8');
    return true;
  }
  async list(): Promise<LineageRecord[]> {
    return this.all();
  }
  /** Assemble the forest: roots (no parent, or a parent we haven't seen) with children nested by depth. */
  async forest(): Promise<LineageTreeNode[]> {
    const all = await this.all();
    const byId = new Map<string, LineageTreeNode>(all.map((r) => [r.vcDid, { ...r, children: [] }]));
    const roots: LineageTreeNode[] = [];
    for (const node of byId.values()) {
      const parent = node.parentVcDid ? byId.get(node.parentVcDid) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const sortRec = (n: LineageTreeNode): void => {
      n.children.sort((a, b) => a.counter - b.counter || a.ts.localeCompare(b.ts));
      n.children.forEach(sortRec);
    };
    roots.sort((a, b) => a.ts.localeCompare(b.ts));
    roots.forEach(sortRec);
    return roots;
  }
}
