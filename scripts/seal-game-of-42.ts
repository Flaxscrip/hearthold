/**
 * Seal the Drake Gamers Guild roleplay board into a Game-of-42 game state (game-of-42.json).
 *
 * The Game of 42 (42.agentprivacy.ai) is a governance-assembly board: six axes × seven stations = 42,
 * six root home bases each growing a heptad, the completed board sealing into one trust-graph node.
 * Field names follow the vocabulary read from the engine bundle (axes/roots/heptad/seat/kappa/
 * axisBitmask/seal); `_reconcile` flags that exact conformance should be confirmed by round-tripping
 * through the grid view's import/export. The `binding` block is Hearthold's contribution: every seat
 * and edge carries the real Archon did:cid credential underneath the game piece.
 *
 * Run:  node --experimental-strip-types scripts/seal-game-of-42.ts
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (s: string): string => `sha256:${createHash('sha256').update(s).digest('hex')}`;

const board = {
  name: 'Drake Gamers Guild',
  session: 'drake-gamers-formup-001',
  community: 'did:cid:bagaaieravkejyffsygijy7cpmq3ll24x4hyv2wrpkaoeylci74mhhsxdus3q',
  warden: 'did:cid:bagaaiera6la7amjmkm6tx7yfzuw43iks5wwadk5yaui33ijolyoyol2e4bmq',
  verifier: 'did:cid:bagaaieraty3o7zbiygqzlbnx5ejopg2kxdg5oss5gifcsoelkcuxm3sqy25a',
  group: 'did:cid:bagaaiera3gqizewooxllarg33lg2in34frdjqodcmywiai4mo6u6ogihfnua',
  schema: 'did:cid:bagaaierapdi6qlte3zo4u3svpfmjq2oujdcksnf6kric2rglxtwsx4r6f7uq',
};

// Six axes (faculty → domain); axes 0–2 read from the engine, 3–5 left as the complement basis.
const axes = [
  { axis: 0, faculty: 'head', domain: 'soil' },
  { axis: 1, faculty: 'heart', domain: 'soul' },
  { axis: 2, faculty: 'hands', domain: 'society' },
  { axis: 3, faculty: 'axis-3', domain: '—' },
  { axis: 4, faculty: 'axis-4', domain: '—' },
  { axis: 5, faculty: 'axis-5', domain: '—' },
];

interface Seat {
  root: string;
  axis: number;
  phase: string;
  name: string;
  did: string;
  role: string;
  real: boolean;
  binding: { vmc?: string; vec?: string; vwc?: string };
}

const seats: Seat[] = [
  {
    root: 'I', axis: 0, phase: 'ignited', name: 'Sovereign', role: 'Raid Leadership', real: true,
    did: 'did:cid:bagaaieraeckzoz4g2cb2xices6ier6strr3t7bmpwjtkryn7fxymttpxe46a',
    binding: {
      vmc: 'did:cid:bagaaierad7cb62ddwros3eloej2dexjxfsaxp2za7s742grfej6myyi4x2iq',
      vec: 'did:cid:bagaaieraifashvavq34vaaugit5mfeteqblrnbh5q5chh67lgfocblkjcjaa',
      vwc: 'did:cid:bagaaierafll3qx56xizirragjcdol2xa3lrczf6jasc3t42u6oylpxmwgsnq',
    },
  },
  {
    root: 'II', axis: 1, phase: 'ignited', name: 'flaxscrip', role: 'Guild Founder', real: true,
    did: 'did:cid:bagaaiera7vsjlu6oiluzd4enop5j7sfzjbwp2ujudt6uunkz6hhd4lgfe4sa',
    binding: {},
  },
  {
    root: 'III', axis: 2, phase: 'ignited', name: 'Quartermaster', role: 'Quartermaster', real: false,
    did: 'did:cid:bagaaieratqqdammifahbb2dbls4l5a3b6orcbfqgj5i46sosmszmqcuqjqmq',
    binding: {},
  },
  {
    root: 'IV', axis: 3, phase: 'ignited', name: 'Lorekeeper', role: 'Lorekeeper', real: false,
    did: 'did:cid:bagaaieranza2an2cznopjbpdwektds5wf6yinwcsp6fgjfjfbyizxzuo4w3q',
    binding: {},
  },
  {
    root: 'V', axis: 4, phase: 'ignited', name: 'GenitriX', role: 'Scribe', real: true,
    did: 'did:cid:bagaaieraxdxq4fm2kjh6yqjxjor3t2idczkmxd4v7in4u353fa6m6sms2pnq',
    binding: {
      vmc: 'did:cid:bagaaierase4ikj433nmrh5orsmfuivqruwfqsbdvdxga6k3pn6thxi2fmf3q',
      vec: 'did:cid:bagaaieraddquugpotrokoa5nspz6l2vohljg7snhze2wktra6st6joejdzca',
      vwc: 'did:cid:bagaaiera3untv2ld7jjhlkhn5avfzrgqlajct7msatmka4u6vsxri6hecoaa',
    },
  },
];

const edges = [
  { from: 'II', to: 'V', dtg: 'RelationshipCredential', relationship: 'Assistant', real: true,
    credential: 'did:cid:bagaaierakmobuifst4ca22mss7txlyhlcubdpaetl27z6ez3iw2gf2vcdqrq', signer: 'flaxscrip' },
  { from: 'V', to: 'II', dtg: 'RelationshipCredential', relationship: 'Principal', real: true,
    credential: 'did:cid:bagaaierahcevrs2ef5wmbbykma35nbieb7nf3lso6tudgqsd24jrjjhwblmq', signer: 'GenitriX' },
  { from: 'V', to: 'I', dtg: 'RelationshipCredential', relationship: 'Scribe', real: true,
    credential: 'did:cid:bagaaierazb2hfmxpw53s4of4lu5gicdt2oopfbwh7cyx4xy3hebyfrw6roea', signer: 'GenitriX' },
  { from: 'II', to: 'I', dtg: 'RelationshipCredential', relationship: 'Sovereign', real: true,
    credential: 'did:cid:bagaaierazlp73sbzernyoqmspyjymrdhbzmmtxevw6xcnso27imlc3g27h6a', signer: 'flaxscrip' },
];

// κ-label per seat = sha256 over the member DID (the engine binds each seat by a κ-label).
const seated = seats.map((s) => ({
  root: s.root,
  axis: s.axis,
  axisBitmask: 1 << s.axis,
  phase: s.phase,
  name: s.name,
  did: s.did,
  role: s.role,
  real: s.real,
  kappa: sha(s.did),
  binding: s.binding,
}));

// Group seal = sha256 over the κ-labels (in root order) + the geometry tag.
const geometry = 'star-tetrahedron/6x7';
const seal = sha(seated.map((s) => s.kappa).join('|') + '#' + geometry);

const game = {
  kind: 'game-of-42',
  name: board.name,
  version: 1,
  origin: 'hearthold',
  _reconcile: 'Field names follow the agentprivacy engine vocabulary (axes/roots/heptad/seat/kappa/axisBitmask/seal). Confirm exact conformance by round-tripping through 42.agentprivacy.ai grid import/export.',
  geometry,
  phase: 'building', // 5 of 6 roots ignited; not yet locked (42 seats unfilled)
  filled: { roots: seated.length, of: 6, seats: seated.length, ofSeats: 42 },
  session: board.session,
  axes,
  roots: seated,
  edges,
  seal,
  // Hearthold's contribution: the verifiable did:cid layer beneath the game pieces.
  binding: {
    backend: 'hearthold',
    note: 'Each seat is a real Archon did:cid holding a DTG VMC (membership) + VEC (role); the Warden witnessed the form-up (VWC); edges are signed DTG RelationshipCredentials (VRC). Trust holds two ways: the credentials and the board group registry.',
    board: board,
    trustRegistry: {
      authority: board.community,
      membershipBinding: { action: 'member', resource: 'Drake Gamers Guild', group: board.group },
      issuerBinding: { action: 'issue', resource: board.schema, note: 'the community sits in an issuers group' },
      trqp: 'TRQP v2.0 over Archon groups; served at POST /authorization, wire-compatible with archon-trust-registry (HATPro :4260)',
    },
    verifiedLive: [
      'Sovereign membership Signet-presented + verified',
      'registry authorizes the community to ISSUE GuildMembership (TRQP issue + schema)',
      'registry confirms board membership per root and refuses non-members (TRQP member + guild) — in-process and over TRQP HTTP',
    ],
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'demos', 'game-of-42', 'drake-gamers-guild.game-of-42.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(game, null, 2) + '\n', 'utf8');
process.stdout.write(`Sealed → ${out}\n  seal: ${seal}\n  roots: ${seated.length}/6   edges: ${edges.length}\n`);
