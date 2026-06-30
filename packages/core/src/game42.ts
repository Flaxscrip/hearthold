/**
 * Game of 42 interop — the trust-protocol primitives (agentprivacy / First Person Network).
 *
 * The Game of 42 (42.agentprivacy.ai) seals each of its 42 slots as a **VRC → κ**: a slot fills via a
 * trust task that mints one Verifiable Relationship Credential edge, compressed to a content-addressed
 * κ-label. Its spec (guide.agentprivacy.ai/game42/trust-protocol) explicitly **defers the VRC issuer,
 * DID resolution, and persistence to external services** — which is exactly Hearthold/Archon's role.
 *
 * This module implements the κ + group-seal exactly per the documented canonical serialisation
 * ("sorted keys, compact separators ',',':', the kappa and vrcId fields excluded, UTF-8"), so a
 * Hearthold-seated board hashes the same as the engine. The agentprivacy VRC edge's `trustTaskRef`
 * carries the real Archon credential DID — the task evidence, referenced not embedded.
 *
 * NOTE: byte-exact equality with the reference `canonical_serialise.py` should be cross-checked once
 * that file is in hand; the rule is mirrored faithfully here.
 */

import { createHash } from 'node:crypto';

/** The six axes (sovereignty-lattice basis vectors), in canonical order (matches slot indexing). */
export const GAME42_AXES = ['compute', 'connection', 'delegation', 'protection', 'memory', 'value'] as const;
export type Game42Axis = (typeof GAME42_AXES)[number];

/** The seven barycentric stations of each heptad, with fill order and persona class. */
export const GAME42_STATIONS = [
  { station: 'head', fillOrder: 1, personaClass: 'vision_fish' },
  { station: 'head-heart', fillOrder: 2, personaClass: 'vision_fish' },
  { station: 'head-hands', fillOrder: 3, personaClass: 'vision_fish' },
  { station: 'hands', fillOrder: 4, personaClass: 'mouse' },
  { station: 'heart-hands', fillOrder: 5, personaClass: 'mouse' },
  { station: 'heart', fillOrder: 6, personaClass: 'mouse' },
  { station: 'head-heart-hands', fillOrder: 7, personaClass: 'privacy_guide' },
] as const;

/** A1 lattice map — each axis is a basis bit of the {0,1}⁶ sovereignty lattice (game42 `conform.mjs`). */
export const GAME42_AXIS_VERTEX: Record<Game42Axis, number> = {
  protection: 32,
  delegation: 16,
  memory: 8,
  connection: 4,
  compute: 2,
  value: 1,
};

/** The lit vertices of a fully-sealed board: the six basis bits + the apex 63 (all dimensions held). */
export function litVertices(): number[] {
  return [...Object.values(GAME42_AXIS_VERTEX).sort((a, b) => a - b), 63];
}

/** `axis.station` — the engine's slot identifier (and the entries in `game42.locked`). */
export function slotId(axis: string, station: string): string {
  return `${axis}.${station}`;
}

/** Slot index = axisIndex*7 + fillOrder (the engine's `k.indexOf(axisId)*7 + fillOrder`). */
export function slotIndex(axis: Game42Axis, fillOrder: number): number {
  return GAME42_AXES.indexOf(axis) * 7 + fillOrder;
}

/** All 42 slot ids, in canonical order. */
export function allSlotIds(): string[] {
  return GAME42_AXES.flatMap((a) => GAME42_STATIONS.map((s) => slotId(a, s.station)));
}

/** A Game-of-42 Verifiable Relationship Credential edge (one per slot). */
export interface VrcEdge {
  slotId: string;
  axisId: Game42Axis;
  candidate: { did: string };
  root: { did: string };
  /** Promise-theory polarity. */
  polarity: '+' | '-';
  /** A lowercase relationship proverb (RPP output). */
  proverb: string;
  /** Reference to the task evidence — a real Archon credential DID (referenced, not embedded). */
  trustTaskRef: string;
  issuedAt: string;
  /** Excluded from its own canonical input (filled by kappaLabel). */
  kappa?: string;
  vrcId?: string;
}

const sha256hex = (s: string): string => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

/** Excluded from the canonical input — **top level only** (matches game42 `src/hash.js`). */
const EXCLUDE = new Set(['kappa', 'seal', 'vrcId', 'gameId']);

/** Recursive encoder — a faithful port of game42 `hash.js` `enc()`: sorted keys, compact, no pruning. */
function enc(o: unknown): string {
  if (o === null) return 'null';
  if (Array.isArray(o)) return '[' + o.map(enc).join(',') + ']';
  const t = typeof o;
  if (t === 'object') {
    const obj = o as Record<string, unknown>;
    return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + enc(obj[k])).join(',') + '}';
  }
  if (t === 'string') return JSON.stringify(o);
  if (t === 'boolean') return o ? 'true' : 'false';
  return String(o); // numbers — stringify upstream (toFixed) for cross-impl determinism
}

/**
 * Canonical serialisation — byte-exact port of game42 `src/hash.js` `canonical()`: prune the EXCLUDE
 * keys at the **top level**, then `enc()` recursively. "Verifiers MUST match it or produce false
 * negatives." Floats must be stringified upstream before hashing.
 */
export function canonical(obj: Record<string, unknown>): string {
  const pruned: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (!EXCLUDE.has(k)) pruned[k] = obj[k];
  return enc(pruned);
}

/** κ-label of a VRC edge: bare-hex `SHA-256(canonical(VRC))` (the engine prefixes display with `sha256:`). */
export function kappaLabel(vrc: VrcEdge): string {
  return sha256hex(canonical(vrc as unknown as Record<string, unknown>));
}

/**
 * Group seal: `SHA-256(canonical({ geometryHash, kappaLabels: sorted }))`, where `kappaLabels` is the
 * array of the 42 bare-hex κ-strings, sorted. `gameId === seal`.
 */
export function groupSeal(kappaLabels: string[], geometryHash: string): string {
  return sha256hex(canonical({ kappaLabels: [...kappaLabels].sort(), geometryHash }));
}

/**
 * The folded-geometry hash. The engine seals over the star-tetrahedron geometry at p=1 (a snapshot of
 * sorted slotIds each with position rounded to 3dp as strings). We don't reproduce the exact vertex
 * fold, so this is a documented placeholder — κ-labels are byte-exact; the group seal awaits the fold.
 */
export function geometryHashPlaceholder(): string {
  return sha256hex(canonical({ _placeholder: 'folded star-tetrahedron geometry at p=1 not reproduced', p: '1.000' }));
}

/**
 * The deterministic demo VRC from game42 `hash.js` — used as a shared conformance vector. The plan doc
 * pins `kappaLabel(demoVRC(...))` to begin `4cdab0eb…`; reproducing it proves our canon is byte-exact.
 */
export function demoVRC(slot: { slotId: string; axisId: string; role: string }): VrcEdge {
  return {
    vrcId: 'demo:' + slot.slotId,
    slotId: slot.slotId,
    axisId: slot.axisId as Game42Axis,
    candidate: { did: 'did:demo:candidate:' + slot.slotId },
    root: { did: 'did:demo:root:' + slot.axisId },
    polarity: '+',
    proverb: 'the ' + slot.role + ' answers for the ' + slot.axisId,
    trustTaskRef: 'demo:task:' + slot.slotId,
    issuedAt: '2026-06-27T00:00:00Z',
  };
}

// ── City-Key projection (Phase 2: game42 forges → soulbis /star carries & charges) ──────────────────

/**
 * Soulbis carrier canon — byte-exact port of `star/index.html` `canonicalJSON`: recursive key-sort, no
 * whitespace, `JSON.stringify` for every primitive. (No top-level exclude; the κ fn deletes `kappa`.)
 */
export function cityCanonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(cityCanonical).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + cityCanonical(obj[k])).join(',') + '}';
}

/** City-Key κ (soulbis parameterization): `sha256:` + SHA-256(cityCanonical(key without `kappa`)). */
export function cityKappa(obj: Record<string, unknown>): string {
  const c = { ...obj };
  delete c.kappa;
  return 'sha256:' + sha256hex(cityCanonical(c));
}

/** The soulbis production carrier palette (game42's amber/sapphire is the forge theme, not canon). */
export const CITY_CARRIER_PALETTE = { cool: '#141a3d', warm: '#f0eee8', sword: '#e8523a', mage: '#4dd9e8' };

/** A soulbis City Key (`/star` carries it; `/city` charges it). */
export interface CityKey {
  name: string;
  version: number;
  palette: typeof CITY_CARRIER_PALETTE;
  lit: number[];
  packets: { root: string; count: number };
  witness: { spent: Record<string, number>; complete: boolean; at: string };
  geometry: { eps: number; m: number; n: number; core: number; smRatio: number };
  descriptions?: Record<string, string>;
  identity?: Record<string, unknown>;
  prior?: string;
  kappa?: string;
}

/**
 * Project a sealed game42 board into a City Key (the integration plan's `game42ToCityKey`). The
 * manifold `geometry` is **derived from the group seal**, so every game gets a distinct `/star` shape;
 * `packets.root` carries the seal as the charge digest, `lit` is the six axes + apex, and `kappa` is
 * stamped with the soulbis canon so `/star`/`/sigil` re-derivation verifies.
 */
export function game42ToCityKey(opts: {
  name: string;
  groupSeal: string;
  savedAt: string;
  descriptionsByVertex?: Record<number, string>;
  identity?: Record<string, unknown>;
}): CityKey {
  const seal = opts.groupSeal;
  const byte = (i: number): number => parseInt(seal.slice(i * 2, i * 2 + 2), 16) || 0;
  const r3 = (x: number): number => Math.round(x * 1000) / 1000;
  const geometry = {
    eps: r3(0.18 + (byte(0) / 255) * 0.34),
    m: 2 + (byte(1) % 5),
    n: 2 + (byte(2) % 6),
    core: r3(0.5 + (byte(3) / 255) * 1.0),
    smRatio: r3(0.4 + (byte(4) / 255) * 0.6),
  };
  const key: CityKey = {
    name: opts.name,
    version: 1,
    palette: CITY_CARRIER_PALETTE,
    lit: litVertices(),
    packets: { root: seal, count: 42 },
    witness: { spent: { '63': 42 }, complete: true, at: opts.savedAt },
    geometry,
    prior: 'sha256:' + seal, // lineage: the forge seal this key evolved from
  };
  if (opts.descriptionsByVertex) {
    key.descriptions = {};
    for (const [v, d] of Object.entries(opts.descriptionsByVertex)) key.descriptions[v] = d;
  }
  if (opts.identity) key.identity = opts.identity;
  key.kappa = cityKappa(key as unknown as Record<string, unknown>);
  return key;
}
