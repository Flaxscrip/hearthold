/**
 * Seat the Drake Gamers Guild on the real Game-of-42 board (byte-exact canon).
 *
 * The guild's officers seat the six Privacy-Is-Value-Model axes; flaxscrip (Guild Founder) is the
 * centre/seed. Each of the 42 slots is a spec-shaped VRC edge → κ via the canon ported byte-exact from
 * game42 `src/hash.js`. Ten slots' `trustTaskRef` point at the **real Drake Gamers Guild credentials**
 * we minted (VMC/VEC/VWC membership + the signed VRC relationship edges) — the task evidence,
 * referenced not embedded. The board folds to a group seal (= gameId).
 *
 * Emits `demos/game-of-42/drake-gamers-guild.game42.json` + a browser-console snippet that loads the
 * flower into 42.agentprivacy.ai.
 *
 * Run:  node --experimental-strip-types scripts/seat-drake-gamers.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GAME42_AXES,
  GAME42_STATIONS,
  GAME42_AXIS_VERTEX,
  litVertices,
  slotId,
  slotIndex,
  kappaLabel,
  groupSeal,
  geometryHashPlaceholder,
  type Game42Axis,
  type VrcEdge,
} from '@hearthold/core';

// Real Drake Gamers Guild cast (did:cid).
const DID = {
  sovereign: 'did:cid:bagaaieraeckzoz4g2cb2xices6ier6strr3t7bmpwjtkryn7fxymttpxe46a',
  flaxscrip: 'did:cid:bagaaiera7vsjlu6oiluzd4enop5j7sfzjbwp2ujudt6uunkz6hhd4lgfe4sa',
  genitrix: 'did:cid:bagaaieraxdxq4fm2kjh6yqjxjor3t2idczkmxd4v7in4u353fa6m6sms2pnq',
  witness: 'did:cid:bagaaiera2h4ptuuutua4rwx2gyga5msguztdh4v55r6m3d5tu43snyr7x4lq',
  warden: 'did:cid:bagaaiera6la7amjmkm6tx7yfzuw43iks5wwadk5yaui33ijolyoyol2e4bmq',
  quartermaster: 'did:cid:bagaaieratqqdammifahbb2dbls4l5a3b6orcbfqgj5i46sosmszmqcuqjqmq',
  lorekeeper: 'did:cid:bagaaieranza2an2cznopjbpdwektds5wf6yinwcsp6fgjfjfbyizxzuo4w3q',
};

// The six axes seated by guild officers (the flower). `did` rides as a side-car the engine ignores.
const ROOTS: Record<Game42Axis, { name: string; role: string; detail: string; did: string }> = {
  compute: { name: 'GenitriX', role: 'the learning mage', detail: 'the Scribe — learns the guild', did: DID.genitrix },
  connection: { name: 'The Quartermaster', role: 'the network mage', detail: 'the muster & the supply lines', did: DID.quartermaster },
  delegation: { name: 'The Emissary', role: 'the agency mage', detail: 'Soulbae — projects for the guild', did: DID.witness },
  protection: { name: 'The Warden', role: 'the privacy mage', detail: 'Soulbis — guards the guild vault', did: DID.warden },
  memory: { name: 'The Lorekeeper', role: 'the continuity mage', detail: 'keeps the guild’s lore', did: DID.lorekeeper },
  value: { name: 'The Sovereign', role: 'the trust mage', detail: 'Raid-Lead — holds the guild’s value', did: DID.sovereign },
};
const FOUNDER = { name: 'flaxscrip', role: 'Guild Founder (centre / seed)', did: DID.flaxscrip };

// Slots anchored to real Drake Gamers Guild credentials (full DIDs we hold).
const ANCHORED: Record<string, { trustTaskRef: string; candidate: string }> = {
  // compute axis (root GenitriX) — GenitriX's own membership + the founder's collaboration edge
  'compute.head': { trustTaskRef: 'did:cid:bagaaierakmobuifst4ca22mss7txlyhlcubdpaetl27z6ez3iw2gf2vcdqrq', candidate: DID.flaxscrip }, // flaxscrip→GenitriX CollaborationPartner
  'compute.head-heart': { trustTaskRef: 'did:cid:bagaaierase4ikj433nmrh5orsmfuivqruwfqsbdvdxga6k3pn6thxi2fmf3q', candidate: DID.genitrix }, // GenitriX VMC (membership)
  'compute.head-hands': { trustTaskRef: 'did:cid:bagaaieraddquugpotrokoa5nspz6l2vohljg7snhze2wktra6st6joejdzca', candidate: DID.genitrix }, // GenitriX VEC (role)
  'compute.hands': { trustTaskRef: 'did:cid:bagaaiera3untv2ld7jjhlkhn5avfzrgqlajct7msatmka4u6vsxri6hecoaa', candidate: DID.genitrix }, // GenitriX VWC (form-up)
  // value axis (root Sovereign) — the Sovereign's membership + the signed relationship edges
  'value.head': { trustTaskRef: 'did:cid:bagaaierazb2hfmxpw53s4of4lu5gicdt2oopfbwh7cyx4xy3hebyfrw6roea', candidate: DID.genitrix }, // GenitriX→Sovereign VRC
  'value.head-heart': { trustTaskRef: 'did:cid:bagaaierazlp73sbzernyoqmspyjymrdhbzmmtxevw6xcnso27imlc3g27h6a', candidate: DID.flaxscrip }, // flaxscrip→Sovereign VRC
  'value.head-hands': { trustTaskRef: 'did:cid:bagaaierad7cb62ddwros3eloej2dexjxfsaxp2za7s742grfej6myyi4x2iq', candidate: DID.sovereign }, // Sovereign VMC
  'value.hands': { trustTaskRef: 'did:cid:bagaaieraifashvavq34vaaugit5mfeteqblrnbh5q5chh67lgfocblkjcjaa', candidate: DID.sovereign }, // Sovereign VEC
  'value.heart-hands': { trustTaskRef: 'did:cid:bagaaierafll3qx56xizirragjcdol2xa3lrczf6jasc3t42u6oylpxmwgsnq', candidate: DID.sovereign }, // Sovereign VWC
  // memory axis (root Lorekeeper) — the founder↔scribe bond
  'memory.head': { trustTaskRef: 'did:cid:bagaaierahcevrs2ef5wmbbykma35nbieb7nf3lso6tudgqsd24jrjjhwblmq', candidate: DID.genitrix }, // GenitriX→flaxscrip VRC
};

const CAST = [DID.genitrix, DID.flaxscrip, DID.sovereign, DID.witness, DID.warden, DID.quartermaster, DID.lorekeeper];
const ISSUED_AT = '2026-06-30T12:00:00Z';
const line = (m = ''): void => process.stdout.write(`${m}\n`);
let failures = 0;
const check = (label: string, ok: boolean): void => {
  if (!ok) failures += 1;
  line(`  ${ok ? '✓' : '✗'} ${label}`);
};

function main(): void {
  const slots: Array<{ slotId: string; axisId: Game42Axis; fillOrder: number; personaClass: string; latticeAxisVertex: number; vrc: VrcEdge; kappa: string; anchored: boolean }> = [];
  const kappaBySlot: Record<string, string> = {};

  for (const axis of GAME42_AXES) {
    const rootDid = ROOTS[axis].did;
    for (const st of GAME42_STATIONS) {
      const id = slotId(axis, st.station);
      const anchor = ANCHORED[id];
      const picked = anchor?.candidate ?? CAST[slotIndex(axis, st.fillOrder) % CAST.length];
      const cand = !anchor && picked === rootDid ? CAST[(slotIndex(axis, st.fillOrder) + 1) % CAST.length] : picked;
      const vrc: VrcEdge = {
        slotId: id,
        axisId: axis,
        candidate: { did: cand },
        root: { did: rootDid },
        polarity: st.personaClass === 'mouse' ? '-' : '+',
        proverb: `the guild keeps faith at the ${st.station}`,
        trustTaskRef: anchor?.trustTaskRef ?? `task:pending:${id}`,
        issuedAt: ISSUED_AT,
      };
      const kappa = kappaLabel(vrc);
      kappaBySlot[id] = kappa;
      slots.push({ slotId: id, axisId: axis, fillOrder: st.fillOrder, personaClass: st.personaClass, latticeAxisVertex: GAME42_AXIS_VERTEX[axis], vrc, kappa, anchored: !!anchor });
    }
  }

  const geometryHash = geometryHashPlaceholder();
  const seal = groupSeal(Object.values(kappaBySlot), geometryHash);
  const locked = slots.map((s) => s.slotId);
  const flower = Object.fromEntries(GAME42_AXES.map((a) => [a, { ...ROOTS[a], seated: true }]));

  const game = {
    name: 'Drake Gamers Guild',
    origin: 'hearthold',
    preset: 'mages',
    _note: 'The Drake Gamers Guild seated on the six PVM axes by guild officers. Each slot is a spec-shaped VRC edge; κ uses the byte-exact game42 canon (verified vs src/hash.js). trustTaskRef points at real Archon guild credentials. Group seal uses a placeholder geometryHash pending the engine fold; κ-labels are exact.',
    founder: FOUNDER,
    axes: GAME42_AXES,
    litVertices: litVertices(),
    flower,
    locked,
    slots,
    geometryHash,
    groupSeal: seal,
    gameId: seal,
    binding: {
      backend: 'hearthold',
      guildBoardGroup: 'did:cid:bagaaiera3gqizewooxllarg33lg2in34frdjqodcmywiai4mo6u6ogihfnua',
      community: 'did:cid:bagaaieravkejyffsygijy7cpmq3ll24x4hyv2wrpkaoeylci74mhhsxdus3q',
      roots: Object.fromEntries(GAME42_AXES.map((a) => [a, ROOTS[a].did])),
      anchoredSlots: Object.keys(ANCHORED),
      vrcIssuer: 'Archon did:cid — the external VRC-issuer service the trust-protocol spec (§7) defers to',
      nextStep: 'issue all 42 VRCs on-chain so every trustTaskRef resolves to a live credential',
    },
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const out = join(here, '..', 'demos', 'game-of-42', 'drake-gamers-guild.game42.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(game, null, 2) + '\n', 'utf8');

  line('Seated the Drake Gamers Guild on the Game of 42 🐉');
  line(`  → ${out}`);
  line(`  group seal (gameId): sha256:${seal}`);
  line(`  founder/centre: flaxscrip`);
  line('');
  check('42 slots seated', slots.length === 42);
  check('every slot κ is byte-exact-canon hex', slots.every((s) => /^[0-9a-f]{64}$/.test(s.kappa)));
  check('κ recompute deterministic', slots.every((s) => kappaLabel(s.vrc) === s.kappa));
  check('10 slots anchored to real Drake Gamers Guild credentials', slots.filter((s) => s.anchored).length === 10);
  check('group seal stable on recompute', groupSeal(Object.values(kappaBySlot), geometryHash) === seal);

  line('\n── paste in the browser console at 42.agentprivacy.ai, then it reloads ──');
  line(`localStorage.setItem("game42.flower", ${JSON.stringify(JSON.stringify(flower))});`);
  line(`localStorage.setItem("game42.locked", ${JSON.stringify(JSON.stringify(locked))});`);
  line(`localStorage.setItem("game42.grid","[]");`);
  line(`localStorage.setItem("game42.intro.seen","1");`);
  line(`localStorage.setItem("game42.preset","mages");`);
  line(`location.reload();`);

  line(`\n${failures === 0 ? 'PASS — the Drake Gamers Guild seats the board, κ byte-exact' : `FAIL (${failures})`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
