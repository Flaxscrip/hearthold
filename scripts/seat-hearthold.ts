/**
 * Seat Hearthold on the real Game-of-42 board.
 *
 * The six axes are the six dimensions of the Privacy Is Value Model; Hearthold's agents seat them with
 * real `did:cid`. Each of the 42 slots becomes a spec-shaped VRC edge whose `trustTaskRef` points at a
 * real Archon credential (the task evidence, referenced not embedded), compressed to κ per the
 * agentprivacy canonical serialisation. The board folds to a group seal (= gameId).
 *
 * Emits `demos/game-of-42/hearthold.game42.json` + a browser-console snippet that loads the flower
 * into 42.agentprivacy.ai. Pure/offline — no minting this pass; the on-chain issuance of all 42 VRCs
 * is the named next step (a few are already anchored via `trustTaskRef`).
 *
 * Run:  node --experimental-strip-types scripts/seat-hearthold.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GAME42_AXES,
  GAME42_STATIONS,
  slotId,
  slotIndex,
  kappaLabel,
  groupSeal,
  geometryHashPlaceholder,
  demoVRC,
  type Game42Axis,
  type VrcEdge,
} from '@hearthold/core';

// Real did:cid from this session's cast.
const DID = {
  warden: 'did:cid:bagaaiera6la7amjmkm6tx7yfzuw43iks5wwadk5yaui33ijolyoyol2e4bmq',
  witness: 'did:cid:bagaaiera2h4ptuuutua4rwx2gyga5msguztdh4v55r6m3d5tu43snyr7x4lq',
  sovereign: 'did:cid:bagaaieraeckzoz4g2cb2xices6ier6strr3t7bmpwjtkryn7fxymttpxe46a',
  genitrix: 'did:cid:bagaaieraxdxq4fm2kjh6yqjxjor3t2idczkmxd4v7in4u353fa6m6sms2pnq',
  flaxscrip: 'did:cid:bagaaiera7vsjlu6oiluzd4enop5j7sfzjbwp2ujudt6uunkz6hhd4lgfe4sa',
  herald: 'did:cid:bagaaieravkejyffsygijy7cpmq3ll24x4hyv2wrpkaoeylci74mhhsxdus3q', // the registry/community
};

// The six axes seated by Hearthold (the flower). `did` is a side-car the engine ignores.
const ROOTS: Record<Game42Axis, { name: string; role: string; detail: string; did: string }> = {
  compute: { name: 'The Classifier', role: 'the learning mage', detail: 'Labels your history on-device', did: DID.genitrix },
  connection: { name: 'The Herald', role: 'the network mage', detail: 'DIDComm v2 + the trust registry', did: DID.herald },
  delegation: { name: 'The Emissary', role: 'the agency mage', detail: 'Soulbae — projects proofs for you', did: DID.witness },
  protection: { name: 'The Warden', role: 'the privacy mage', detail: 'Soulbis — guards the sealed vault', did: DID.warden },
  memory: { name: 'The Chronicle', role: 'the continuity mage', detail: 'Your 7th Capital, kept over time', did: DID.flaxscrip },
  value: { name: 'The Sovereign', role: 'the trust mage', detail: 'Holds and signs at the Signet', did: DID.sovereign },
};

// Slots already backed by a real Archon VRC (the task evidence). candidate→root must match the cred.
const ANCHORED: Record<string, { trustTaskRef: string; candidate: string }> = {
  'memory.head': { trustTaskRef: 'did:cid:bagaaierahcevrs2ef5wmbbykma35nbieb7nf3lso6tudgqsd24jrjjhwblmq', candidate: DID.genitrix }, // GenitriX→flaxscrip
  'value.head': { trustTaskRef: 'did:cid:bagaaierazb2hfmxpw53s4of4lu5gicdt2oopfbwh7cyx4xy3hebyfrw6roea', candidate: DID.genitrix }, // GenitriX→Sovereign
  'value.head-heart': { trustTaskRef: 'did:cid:bagaaierazlp73sbzernyoqmspyjymrdhbzmmtxevw6xcnso27imlc3g27h6a', candidate: DID.flaxscrip }, // flaxscrip→Sovereign
  'compute.head': { trustTaskRef: 'did:cid:bagaaierakmobuifst4ca22mss7txlyhlcubdpaetl27z6ez3iw2gf2vcdqrq', candidate: DID.flaxscrip }, // flaxscrip→GenitriX
};

const CAST = [DID.genitrix, DID.flaxscrip, DID.sovereign, DID.witness, DID.warden, DID.herald];
const ISSUED_AT = '2026-06-30T12:00:00Z';
const line = (m = ''): void => process.stdout.write(`${m}\n`);

let failures = 0;
const check = (label: string, ok: boolean): void => {
  if (!ok) failures += 1;
  line(`  ${ok ? '✓' : '✗'} ${label}`);
};

function main(): void {
  const slots: Array<{ slotId: string; axisId: Game42Axis; fillOrder: number; personaClass: string; vrc: VrcEdge; kappa: string; anchored: boolean }> = [];
  const kappaBySlot: Record<string, string> = {};

  for (const axis of GAME42_AXES) {
    const rootDid = ROOTS[axis].did;
    for (const st of GAME42_STATIONS) {
      const id = slotId(axis, st.station);
      const anchor = ANCHORED[id];
      const candidate = anchor?.candidate ?? CAST[slotIndex(axis, st.fillOrder) % CAST.length];
      // avoid candidate == root for unanchored slots
      const cand = !anchor && candidate === rootDid ? CAST[(slotIndex(axis, st.fillOrder) + 1) % CAST.length] : candidate;
      const vrc: VrcEdge = {
        slotId: id,
        axisId: axis,
        candidate: { did: cand },
        root: { did: rootDid },
        polarity: st.personaClass === 'mouse' ? '-' : '+',
        proverb: `we are bound at the ${st.station}`,
        trustTaskRef: anchor?.trustTaskRef ?? `task:pending:${id}`,
        issuedAt: ISSUED_AT,
      };
      const kappa = kappaLabel(vrc);
      kappaBySlot[id] = kappa;
      slots.push({ slotId: id, axisId: axis, fillOrder: st.fillOrder, personaClass: st.personaClass, vrc, kappa, anchored: !!anchor });
    }
  }

  const geometryHash = geometryHashPlaceholder();
  const seal = groupSeal(Object.values(kappaBySlot), geometryHash);
  const locked = slots.map((s) => s.slotId);

  const flower = Object.fromEntries(
    GAME42_AXES.map((a) => [a, { ...ROOTS[a], seated: true }]),
  );

  const game = {
    name: 'Hearthold',
    origin: 'hearthold',
    preset: 'mages',
    _note: 'The six axes of the Privacy Is Value Model, seated by Hearthold did:cid. Each slot is a spec-shaped VRC edge (κ = SHA-256(canonical(VRC))); trustTaskRef points at the real Archon credential. The group seal uses a placeholder geometryHash pending the engine fold — κ-labels are exact.',
    axes: GAME42_AXES,
    stations: GAME42_STATIONS,
    flower,
    locked,
    slots,
    geometryHash,
    groupSeal: seal,
    gameId: seal,
    binding: {
      backend: 'hearthold',
      roots: Object.fromEntries(GAME42_AXES.map((a) => [a, ROOTS[a].did])),
      anchoredSlots: Object.keys(ANCHORED),
      vrcIssuer: 'Archon did:cid (the external VRC-issuer service the trust-protocol spec defers to)',
      nextStep: 'issue all 42 VRCs on-chain so every trustTaskRef resolves to a live credential',
    },
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const out = join(here, '..', 'demos', 'game-of-42', 'hearthold.game42.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(game, null, 2) + '\n', 'utf8');

  line('Seated Hearthold on the Game of 42');
  line(`  → ${out}`);
  line(`  group seal (gameId): sha256:${seal}`);
  line('');
  check('42 slots seated', slots.length === 42);
  check('every slot has a κ-label', slots.every((s) => /^[0-9a-f]{64}$/.test(s.kappa)));
  check('κ recompute is deterministic', slots.every((s) => kappaLabel(s.vrc) === s.kappa));
  check('4 slots anchored to real Archon VRCs', slots.filter((s) => s.anchored).length === 4);
  check('group seal stable on recompute', groupSeal(Object.values(kappaBySlot), geometryHash) === seal);
  // Byte-exact regression guard: this κ was verified equal to game42 `src/hash.js` run side-by-side.
  const demoK = kappaLabel(demoVRC({ slotId: 'compute.head', axisId: 'compute', role: 'lead advisor' }));
  const REF = 'bbd641ebcdb02994a3f387d51677447fddb1d03cbf35678364d8a47bb207e7f9';
  line(`  byte-exact check · demo-VRC κ = ${demoK}`);
  check('canon byte-exact vs game42 hash.js (compute.head demo VRC)', demoK === REF);

  line('\n── paste in the browser console at 42.agentprivacy.ai, then it reloads ──');
  line(`localStorage.setItem("game42.flower", ${JSON.stringify(JSON.stringify(flower))});`);
  line(`localStorage.setItem("game42.locked", ${JSON.stringify(JSON.stringify(locked))});`);
  line(`localStorage.setItem("game42.grid","[]");`);
  line(`localStorage.setItem("game42.intro.seen","1");`);
  line(`localStorage.setItem("game42.preset","mages");`);
  line(`location.reload();`);

  line(`\n${failures === 0 ? 'PASS — Hearthold seats the board, κ-labels exact' : `FAIL (${failures})`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
