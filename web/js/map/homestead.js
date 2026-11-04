// What stands round a house, map B (2026-11-04). As a post gathers reactions
// and messages (houseScore), its household grows, in the order a household
// would: first what can be picked up (firewood), the livestock that feeds on
// weeds and insects (chickens), water carried home (a jar), a field, clothes on
// the line, a well (the jar goes), a guard dog, a cart for trade, more
// livestock (sheep), the street (a lamp), and last what is only for pleasure
// (flowers and a bench). The user set this order (2026-11-04: a well cannot be
// the first thing; chickens are easier than a field; firewood is just picked up).
// Pure functions: no canvas, no DOM.
//
// Offsets are on the ground in the houses' design units (x east, y south, a
// house is about 3 across), from the house's foot, out from its half width
// `hw` so a bigger house keeps its things clear of its walls.

/** Half the width of each tier's house, design units (hut, house, big house, two-storey house). */
export const HOMESTEAD_HALF = [1.25, 1.6, 2.3, 2.9];

/** Each: from this score on (and, with `until`, below that), a `kind` (props-mesh.js) at
 * `at(hw)`, turned `rot`; `r` is its footprint's radius and `min` its size, design units
 * (it is left out while `min` is under MIN_PX on the screen). */
export const HOMESTEAD = [
  { from: 2, kind: 'woodpile', at: (hw) => [-hw - 0.5, -hw * 0.75], rot: 0.3, r: 0.8, min: 1.2 },
  { from: 3, kind: 'chicken', at: (hw) => [hw + 0.8, hw * 0.8], rot: 2.6, r: 0.3, min: 0.5 },
  { from: 3, kind: 'chicken', at: (hw) => [hw + 1.4, hw * 0.45], rot: 0.4, r: 0.3, min: 0.5 },
  { from: 4, until: 7, kind: 'jar', at: (hw) => [-hw - 0.8, hw * 0.75], rot: 0, r: 0.5, min: 0.8 },
  { from: 5, kind: 'field', at: (hw) => [hw + 1.1, -hw - 1.7], rot: 0, r: 2, min: 3 },
  { from: 6, kind: 'laundry', at: (hw) => [-hw - 1.7, 0.1], rot: 0.25, r: 1.2, min: 2.4 },
  { from: 7, kind: 'well', at: (hw) => [-hw - 1.2, hw * 0.75], rot: 0, r: 0.8, min: 1.5 },
  { from: 8, kind: 'doghouse', at: (hw) => [hw + 1.2, -hw * 0.1], rot: 0, r: 0.8, min: 1.3 },
  { from: 8, kind: 'dog', at: (hw) => [hw + 0.4, -hw * 0.1 + 1.3], rot: 2.6, r: 0.5, min: 1 },
  { from: 10, kind: 'cart', at: (hw) => [hw + 2.2, hw * 0.9 + 1], rot: -0.5, r: 1.1, min: 1.8 },
  { from: 13, kind: 'sheep', at: (hw) => [-hw - 2.1, -hw * 0.7 - 0.7], rot: 0.6, r: 0.6, min: 0.9 },
  { from: 13, kind: 'sheep', at: (hw) => [-hw - 1.2, -hw * 0.9 - 1.3], rot: 2.4, r: 0.6, min: 0.9 },
  { from: 16, kind: 'lamp', at: (hw) => [-0.9, hw + 1.9], rot: 0, r: 0.3, min: 0.9 },
  { from: 20, kind: 'flowerbed', at: (hw) => [0.6, hw + 1.1], rot: 0, r: 1, min: 2 },
  { from: 20, kind: 'bench', at: (hw) => [1.4, hw + 2.3], rot: 0.1, r: 0.8, min: 1.4 },
];

/**
 * The things round a house of `tier` (0..3) whose post has `score`. Every other
 * house (by `seed`) has them the other way round, east for west, so a village
 * is not the same yard over and over.
 * @returns [{ kind, dx, dy, rot, r, min, index }] (index: its place in HOMESTEAD)
 */
export function homestead(score, tier, seed = 0) {
  const n = Number(score) || 0;
  const hw = HOMESTEAD_HALF[Math.max(0, Math.min(3, Math.round(Number(tier)) || 0))];
  const flip = (Math.abs(seed | 0) & 1) === 1;
  const out = [];
  HOMESTEAD.forEach((step, index) => {
    if (n < step.from || (step.until && n >= step.until)) return;
    const [x, y] = step.at(hw);
    out.push({
      kind: step.kind, dx: flip ? -x : x, dy: y, rot: flip ? Math.PI - step.rot : step.rot,
      r: step.r, min: step.min, index,
    });
  });
  return out;
}

/** How far from its foot a house's things reach on the ground, design units, with the ground's
 * depth foreshortened by `squash` as the pictures draw it (sin 52 degrees). 0 with none. */
const SQUASH = Math.sin((52 * Math.PI) / 180);
// Past the last step's score nothing more comes, so the answers are few: kept, as the map asks
// for every house's reach on every frame.
const TOP = Math.max(...HOMESTEAD.map((step) => step.from));
const reaches = new Map();
export function homesteadReach(score, tier, squash = SQUASH) {
  const n = Math.min(Number(score) || 0, TOP);
  const key = squash === SQUASH ? `${tier}|${n}` : null;
  if (key !== null && reaches.has(key)) return reaches.get(key);
  const reach = homestead(n, tier).reduce((most, it) => Math.max(most, Math.hypot(it.dx, it.dy * squash) + it.r), 0);
  if (key !== null && reaches.size < 4096) reaches.set(key, reach);
  return reach;
}
