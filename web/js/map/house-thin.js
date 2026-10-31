// Thinning houses that would stand on top of each other (2026-10-31, the user:
// "only one house per post in a town; zoomed out, thin them like the pins").
// Pure functions: no canvas, no DOM.
//
// Rule: a house's box is its body (walls and roof, shadow left out), measured on
// the drawn pictures like HOUSE_BODY. Two boxes may overlap a little (up to
// OVERLAP_OK = 25% of the smaller box's area: houses side by side in a town);
// more than that and only one stays. Who stays, in this order:
//   1. the open post and the post that is landing,
//   2. the bigger tier (castle > manor > house > hut),
//   3. more reactions and messages,
//   4. the smaller hash of the post id (the same answer every frame, so a house
//      does not flicker when the camera moves a little).
// The result does not depend on the order of the input.

export const OVERLAP_OK = 0.25;
/** Of the house size (drawHouse's size), per tier: half width, height above the foot, depth below it. */
export const HOUSE_BOX = [
  { half: 0.54, up: 0.65, down: 0.35 },
  { half: 0.7, up: 0.98, down: 0.44 },
  { half: 0.9, up: 1.42, down: 0.83 },
  { half: 1.31, up: 1.8, down: 0.96 },
];

/** The screen box of a house { x, foot, size, tier }. */
export function houseBox(house) {
  const b = HOUSE_BOX[Math.max(0, Math.min(3, house.tier | 0))];
  return {
    left: house.x - b.half * house.size, right: house.x + b.half * house.size,
    top: house.foot - b.up * house.size, bottom: house.foot + b.down * house.size,
  };
}

/** True when the two boxes overlap by more than OVERLAP_OK of the smaller one. */
export function crowds(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return false;
  const small = Math.min((a.right - a.left) * (a.bottom - a.top), (b.right - b.left) * (b.bottom - b.top));
  return w * h > small * OVERLAP_OK;
}

const rank = (a, b) => (
  (b.keep ? 1 : 0) - (a.keep ? 1 : 0)
  || b.tier - a.tier
  || (b.score || 0) - (a.score || 0)
  || (a.seed - b.seed)
  || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)
);

/**
 * houses: [{ id, x, foot, size, tier, score, seed, keep }] (keep: open or landing).
 * Returns the ones that stay (new array, same objects). A grid of cells as wide as
 * the widest box means each house only asks its eight neighbours' cells.
 */
export function thinHouses(houses) {
  if (houses.length < 2) return houses.slice();
  const sorted = houses.slice().sort(rank);
  const cell = Math.max(1, ...houses.map((h) => 2 * HOUSE_BOX[Math.max(0, Math.min(3, h.tier | 0))].half * h.size));
  const grid = new Map();
  const kept = [];
  sorted.forEach((house) => {
    const box = houseBox(house);
    const cx = Math.floor((box.left + box.right) / 2 / cell);
    const cy = Math.floor((box.top + box.bottom) / 2 / cell);
    // A box can be taller than it is wide; look two cells up and down to be safe.
    let blocked = false;
    for (let dx = -1; dx <= 1 && !blocked; dx += 1) {
      for (let dy = -2; dy <= 2 && !blocked; dy += 1) {
        const list = grid.get(`${cx + dx},${cy + dy}`);
        if (list && list.some((other) => crowds(box, other.box))) blocked = true;
      }
    }
    if (blocked && !house.keep) return;
    const key = `${cx},${cy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ box });
    kept.push(house);
  });
  return kept;
}
