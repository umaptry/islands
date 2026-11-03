// The small things round a house and the people on the roads, map B
// (2026-11-04, the user: as a post gathers reactions and messages, not only does
// the house grow - a dog, chickens, the things of a household turn up round it;
// and the people walking the roads should look more real). Built from the same
// solid parts as the houses (mesh.js), seen at the same angle and lit the same,
// so they read as one world. Pure maths: no DOM, no canvas.
//
// Units are the houses' design units (a house is about 3 across), so a thing
// drawn at the house's own px per unit stands in proportion to it. They are drawn
// larger than life, as the houses are against the trees: the user approved the
// mock-up at these sizes (PROP, ANIMAL, PERSON).

import { box, cone, cyl, ico, part, facesOf, COLOR } from './mesh.js';

const ELEV = (52 * Math.PI) / 180;
const SINE = Math.sin(ELEV);
const COSE = Math.cos(ELEV);

export const PROP = 2.2;     // things, times life size
export const ANIMAL = 1.7;   // dogs, chickens, sheep
export const PERSON = 1.5;   // people on the roads

// ---------------------------------------------------------------- part helpers
const mapPart = (p, f) => ({ ...p, tris: p.tris.map((t) => t.map(f)), center: f(p.center) });
const move = (p, dx, dy, dz = 0) => mapPart(p, ([x, y, z]) => [x + dx, y + dy, z + dz]);
const turnZ = (p, a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return mapPart(p, ([x, y, z]) => [x * c - y * s, x * s + y * c, z]);
};
const grow = (p, k) => mapPart(p, ([x, y, z]) => [x * k, y * k, z * k]);
// Swing about a level axis along y at height h through x0 (x is forward): a > 0 swings the low end forward.
const pitch = (p, a, h, x0 = 0) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return mapPart(p, ([x, y, z]) => {
    const dx = x - x0;
    const dz = z - h;
    return [x0 + dx * c - dz * s, y, h + dx * s + dz * c];
  });
};
// A disc standing on its edge (a wheel, a log end-on), its axis along y.
const wheel = (r, w, color) => mapPart(cyl(8, r, w, -w / 2, color), ([x, y, z]) => [x, z, y]);
const depthOf = (p) => p.center[1] * COSE + p.center[2] * SINE;
// Parts back to front, as facesOf keeps the order it is given.
const ordered = (parts) => parts.slice().sort((a, b) => depthOf(a) - depthOf(b));

/** A pitched roof, its ridge along x the whole width. */
function gable(w, d, h, z0, color) {
  const a = [-w / 2, -d / 2, z0]; const b = [w / 2, -d / 2, z0];
  const c = [w / 2, d / 2, z0]; const e = [-w / 2, d / 2, z0];
  const r0 = [-w / 2, 0, z0 + h]; const r1 = [w / 2, 0, z0 + h];
  return part([[a, b, r1], [a, r1, r0], [e, c, r1], [e, r1, r0], [a, e, r0], [b, c, r1]], [0, 0, z0 + h * 0.3], color);
}

const C = {
  skin: 0xf0c8a0, skin2: 0xc98e64, hair: 0x4a3426, hair2: 0x2a2220, pants: 0x3f4f6b, pants2: 0x6b5a48,
  shirts: [0xe2725b, 0x4f86c6, 0xf2b84b, 0x6aaa64, 0x9b7bd0, 0xf3f0e8],
  shiba: 0xc9853f, white: 0xf5efe2, dark: 0x3a3330, red: 0xd9573f, yellow: 0xf2c14e, orange: 0xe8913a,
  soil: 0x8a6a46, leaf: 0x5aa04e, water: 0x4c7fa8, lamp: 0xffe6a0, iron: 0x3d4650, straw: 0xd9b45a,
  log: 0xb08050, clay: 0xb0683f, clayDark: 0x9a5634, wheel: 0x6b4a30, roofDog: 0x9a4a36, roofWell: 0x8a5a3c,
};

// ---------------------------------------------------------------- people
/** One person walking towards +x, life size (about 1.2 tall). `phase` is the
 * walk cycle in radians: the legs and arms swing in turn and the body bobs. */
function person({ phase = 0, shirt = C.shirts[0], pants = C.pants, skin = C.skin, hair = C.hair, hat = false, carry = null, size = 1 } = {}) {
  const sw = Math.sin(phase) * 0.4;
  const bob = 0.03 * Math.abs(Math.cos(phase));
  const hip = 0.5;
  const leg = (side, a) => pitch(move(box(0.13, 0.12, 0.5, 0, pants, 0), 0, side * 0.08), a, hip);
  const shoe = (side, a) => pitch(move(box(0.18, 0.12, 0.07, 0, C.dark, 0), 0.03, side * 0.08), a, hip);
  const arm = (side, a) => pitch(move(box(0.09, 0.09, 0.38, 0.5, shirt, 0), 0, side * 0.21), a, 0.88);
  const hand = (side, a) => pitch(move(ico(0.05, 0.05, 0.5, skin), 0, side * 0.21), a, 0.88);
  const parts = [
    leg(-1, sw), leg(1, -sw), shoe(-1, sw), shoe(1, -sw),
    box(0.22, 0.34, 0.44, 0.47, shirt, 0),
    arm(-1, -sw * 0.8), arm(1, sw * 0.8), hand(-1, -sw * 0.8), hand(1, sw * 0.8),
    ico(0.14, 0.15, 1.05, skin, 0.3),
    ico(0.155, 0.16, 1.08, hair, 0.3, 1.07),
  ];
  if (hat) parts.push(cone(8, 0.26, 0.14, 1.12, C.straw), cyl(8, 0.27, 0.02, 1.11, C.straw));
  if (carry === 'basket') parts.push(pitch(move(box(0.2, 0.16, 0.14, 0.42, C.straw, 0), 0, 0.3), sw * 0.8, 0.88));
  if (carry === 'bag') parts.push(move(box(0.12, 0.22, 0.3, 0.5, 0x8a5a3c, 0), -0.17, 0));
  return parts.map((p) => grow(move(p, 0, 0, bob), size));
}

// ---------------------------------------------------------------- animals
function dog({ phase = 0, color = C.shiba } = {}) {
  const sw = Math.sin(phase) * 0.45;
  const legs = [[0.18, -0.08, sw], [0.18, 0.08, -sw], [-0.18, -0.08, -sw], [-0.18, 0.08, sw]]
    .map(([x, y, a]) => pitch(move(box(0.07, 0.07, 0.24, 0, color, 0), x, y), a, 0.24, x));
  return [
    ...legs,
    move(box(0.5, 0.2, 0.2, 0.22, color, 0), 0, 0),
    move(box(0.14, 0.18, 0.06, 0.26, C.white, 0), 0.2, 0),
    move(box(0.2, 0.19, 0.19, 0.36, color, 0), 0.32, 0),
    move(box(0.1, 0.12, 0.08, 0.37, C.white, 0), 0.46, 0),
    move(box(0.03, 0.04, 0.03, 0.43, C.dark, 0), 0.52, 0),
    move(cone(4, 0.05, 0.08, 0.55, color, Math.PI / 4), 0.3, -0.06),
    move(cone(4, 0.05, 0.08, 0.55, color, Math.PI / 4), 0.3, 0.06),
    pitch(move(box(0.06, 0.06, 0.18, 0.38, color, 0), -0.26, 0), -0.6 + 0.15 * Math.sin(phase * 3), 0.38, -0.26),
  ];
}

function chicken({ peck = 0 } = {}) {
  const head = (p) => pitch(p, -peck * 0.9, 0.22, 0.08);
  return [
    move(box(0.02, 0.02, 0.1, 0, C.orange, 0), 0, -0.04), move(box(0.02, 0.02, 0.1, 0, C.orange, 0), 0, 0.04),
    ico(0.15, 0.12, 0.18, C.white, 0.2),
    move(ico(0.07, 0.09, 0.26, C.white, 0.5), -0.13, 0),
    head(move(ico(0.07, 0.08, 0.3, C.white, 0.1), 0.11, 0)),
    head(move(box(0.05, 0.02, 0.05, 0.36, C.red, 0), 0.11, 0)),
    head(move(box(0.06, 0.03, 0.03, 0.29, C.yellow, 0), 0.19, 0)),
    head(move(box(0.03, 0.02, 0.04, 0.24, C.red, 0), 0.16, 0)),
  ];
}

function sheep() {
  return [
    ...[[0.14, -0.08], [0.14, 0.08], [-0.14, -0.08], [-0.14, 0.08]].map(([x, y]) => move(box(0.06, 0.06, 0.18, 0, C.dark, 0), x, y)),
    ico(0.26, 0.17, 0.28, 0xf4f1ea, 0.2),
    move(box(0.12, 0.12, 0.14, 0.27, C.dark, 0), 0.27, 0),
  ];
}

// ---------------------------------------------------------------- things
const THINGS = {
  woodpile: () => [0, 1, 2].flatMap((row) => [-0.2, 0, 0.2].slice(0, 3 - row)
    .map((y) => turnZ(move(wheel(0.1, 0.7, C.log), 0, y + row * 0.1, 0.1 + row * 0.17), Math.PI / 2))),
  jar: () => [cyl(8, 0.22, 0.42, 0, C.clay), cyl(8, 0.16, 0.06, 0.42, C.clayDark), cyl(8, 0.13, 0.01, 0.48, C.water)],
  field: () => [
    box(1.5, 1.0, 0.04, 0, C.soil, 0),
    ...[-0.32, 0, 0.32].flatMap((y) => [-0.5, -0.25, 0, 0.25, 0.5].map((x, i) => move(ico(0.09, 0.08, 0.1, i % 2 ? C.leaf : 0x6fb85a, i), x, y))),
  ],
  laundry: () => [
    move(cyl(4, 0.03, 0.8, 0, COLOR.trunk), -0.55, 0), move(cyl(4, 0.03, 0.8, 0, COLOR.trunk), 0.55, 0),
    box(1.1, 0.02, 0.02, 0.76, 0x777777, 0),
    move(box(0.24, 0.02, 0.3, 0.46, C.white, 0), -0.3, 0), move(box(0.2, 0.02, 0.24, 0.52, 0x4f86c6, 0), 0, 0),
    move(box(0.22, 0.02, 0.28, 0.48, 0xe88fb0, 0), 0.3, 0),
  ],
  // The roofs' gable ends face the viewer, or from above they read as a box.
  well: () => [
    cyl(10, 0.34, 0.38, 0, COLOR.stone), cyl(10, 0.26, 0.01, 0.38, C.water),
    move(cyl(4, 0.03, 0.55, 0.38, COLOR.trunk), -0.3, 0), move(cyl(4, 0.03, 0.55, 0.38, COLOR.trunk), 0.3, 0),
    turnZ(gable(0.62, 0.9, 0.3, 0.92, C.roofWell), Math.PI / 2), move(cyl(6, 0.07, 0.1, 0.38, COLOR.wood), 0.2, 0.2),
  ],
  doghouse: () => [
    box(0.6, 0.55, 0.42, 0, COLOR.wood, 0), turnZ(gable(0.7, 0.72, 0.34, 0.42, C.roofDog), Math.PI / 2),
    move(box(0.22, 0.01, 0.26, 0, C.dark, 0), 0, 0.28),
  ],
  cart: () => [
    move(wheel(0.22, 0.05, C.wheel), 0, -0.27, 0.22), box(0.8, 0.46, 0.2, 0.22, COLOR.wood, 0),
    move(box(0.5, 0.04, 0.04, 0.3, COLOR.wood, 0), -0.6, -0.15), move(box(0.5, 0.04, 0.04, 0.3, COLOR.wood, 0), -0.6, 0.15),
    move(ico(0.32, 0.18, 0.46, C.straw, 0.4), 0, 0), move(wheel(0.22, 0.05, C.wheel), 0, 0.27, 0.22),
  ],
  lamp: () => [cyl(5, 0.035, 1.35, 0, C.iron), box(0.16, 0.16, 0.18, 1.35, C.lamp, 0), cone(4, 0.15, 0.1, 1.53, C.iron, Math.PI / 4)],
  flowerbed: () => [
    box(0.9, 0.3, 0.1, 0, COLOR.wood, 0),
    ...[[-0.3, 0xe86f8a], [-0.1, C.yellow], [0.1, 0x9b7bd0], [0.3, 0xe86f8a]].map(([x, c], i) => move(ico(0.08, 0.07, 0.17, c, i), x, (i % 2 ? 0.04 : -0.04))),
    ...[-0.2, 0, 0.2].map((x) => move(ico(0.07, 0.05, 0.13, C.leaf), x, 0.06)),
  ],
  bench: () => [box(0.7, 0.22, 0.05, 0.22, COLOR.wood, 0), move(box(0.05, 0.2, 0.22, 0, COLOR.trunk, 0), -0.3, 0), move(box(0.05, 0.2, 0.22, 0, COLOR.trunk, 0), 0.3, 0)],
};

/** Animals: how each is made at `frame` (0 or 1), at life size. */
const ANIMALS = {
  chicken: (frame) => chicken({ peck: frame ? 0.8 : 0 }),
  dog: (frame) => dog({ phase: frame ? 1.2 : 0 }),
  sheep: () => sheep(),
};

export const PROP_KINDS = [...Object.keys(THINGS), ...Object.keys(ANIMALS)];
export const isAnimal = (kind) => Object.prototype.hasOwnProperty.call(ANIMALS, kind);

/** The parts of a thing or an animal at its drawn size, turned by `rot`
 * (radians), in design units with its foot at the origin. */
export function propParts(kind, { rot = 0, frame = 0 } = {}) {
  const make = THINGS[kind] || ANIMALS[kind];
  if (!make) return [];
  const k = isAnimal(kind) ? ANIMAL : PROP;
  return ordered(make(frame).map((p) => turnZ(grow(p, k), rot)));
}

/** [radius, height] of a thing's soft shadow at its drawn size, in design units (shadowOutline). */
export const PROP_SHADOW = {
  woodpile: [0.7, 0.8], jar: [0.4, 0.8], field: null, laundry: [1.1, 1.3], well: [0.8, 2.2], doghouse: [0.8, 1.3],
  cart: [1.0, 1.1], lamp: [0.25, 3], flowerbed: [1.0, 0.3], bench: [0.7, 0.5],
  chicken: [0.24, 0.5], dog: [0.4, 0.7], sheep: [0.45, 0.8],
};

// ---------------------------------------------------------------- walkers
/** The looks a walker can have (picked by the road's seed): shirt, hair, skin, trousers, what they carry. */
export const WALKER_LOOKS = [
  { shirt: C.shirts[1] },
  { shirt: C.shirts[0], hair: C.hair2 },
  { shirt: C.shirts[3], hat: true, carry: 'basket' },
  { shirt: C.shirts[5], pants: C.pants2, skin: C.skin2, carry: 'bag' },
  { shirt: C.shirts[4], hair: C.hair2 },
  { shirt: C.shirts[2], hat: true },
  { shirt: C.shirts[2], size: 0.65 },   // a child
];
export const WALK_FRAMES = 8;
export const WALK_TURNS = 16;

const walkCache = new Map();
/** The faces of walker `look` (an index into WALKER_LOOKS), heading turn
 * `turn` of WALK_TURNS (0 = east, going round clockwise on the screen) and walk
 * frame `frame` of WALK_FRAMES, at its drawn size: facesOf's output, made once. */
export function walkerFaces(look, turn, frame) {
  const l = ((look % WALKER_LOOKS.length) + WALKER_LOOKS.length) % WALKER_LOOKS.length;
  const t = ((turn % WALK_TURNS) + WALK_TURNS) % WALK_TURNS;
  const f = ((frame % WALK_FRAMES) + WALK_FRAMES) % WALK_FRAMES;
  const key = `${l}|${t}|${f}`;
  let faces = walkCache.get(key);
  if (!faces) {
    const rot = (t / WALK_TURNS) * Math.PI * 2;
    const parts = person({ ...WALKER_LOOKS[l], phase: (f / WALK_FRAMES) * Math.PI * 2 }).map((p) => turnZ(grow(p, PERSON), rot));
    faces = facesOf(ordered(parts));
    walkCache.set(key, faces);
  }
  return faces;
}

/** The faces of a dog on a lead, heading turn and frame as walkerFaces. */
export function dogFaces(turn, frame) {
  const t = ((turn % WALK_TURNS) + WALK_TURNS) % WALK_TURNS;
  const f = ((frame % WALK_FRAMES) + WALK_FRAMES) % WALK_FRAMES;
  const key = `dog|${t}|${f}`;
  let faces = walkCache.get(key);
  if (!faces) {
    const rot = (t / WALK_TURNS) * Math.PI * 2;
    faces = facesOf(ordered(dog({ phase: (f / WALK_FRAMES) * Math.PI * 2 }).map((p) => turnZ(grow(p, ANIMAL), rot))));
    walkCache.set(key, faces);
  }
  return faces;
}

/** How tall a walker stands at its drawn size, in design units. */
export const WALKER_HEIGHT = 1.25 * PERSON;
