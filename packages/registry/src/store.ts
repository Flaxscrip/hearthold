import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { GroupBinding } from '@hearthold/core';

interface RegistryFile {
  bindings: GroupBinding[];
}

/** A binding's `(action, resource)` identity. `resource: undefined` is the per-action wildcard. */
function sameKey(a: GroupBinding, action: string, resource?: string): boolean {
  return a.action === action && a.resource === resource;
}

/** File-backed store of the registry's `(action, resource) → group` bindings. */
export class BindingStore {
  private readonly file: string;

  constructor(private readonly dataFolder: string) {
    this.file = join(dataFolder, 'hearthold-registry.json');
  }

  async load(): Promise<GroupBinding[]> {
    try {
      return (JSON.parse(await readFile(this.file, 'utf8')) as RegistryFile).bindings ?? [];
    } catch {
      return [];
    }
  }

  private async save(bindings: GroupBinding[]): Promise<void> {
    await mkdir(this.dataFolder, { recursive: true });
    await writeFile(this.file, JSON.stringify({ bindings }, null, 2), 'utf8');
  }

  async find(action: string, resource?: string): Promise<GroupBinding | undefined> {
    return (await this.load()).find((b) => sameKey(b, action, resource));
  }

  /** Insert or replace the binding for `(action, resource)`. Returns the full list. */
  async upsert(binding: GroupBinding): Promise<GroupBinding[]> {
    const all = (await this.load()).filter((b) => !sameKey(b, binding.action, binding.resource));
    all.push(binding);
    await this.save(all);
    return all;
  }
}
