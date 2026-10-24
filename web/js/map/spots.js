// Where a town and its landmarks stand on an island so that no pin sits on a
// house (2026-10-25, the user: trees under a pin are fine, houses are not).
//
// A pin (a round badge of 22-30 px, a flame above it) is drawn on its post. In
// world units that is a few at most, from the zoom where faces show, so the
// houses are kept PIN_CLEAR from every post of their island. All in world
// units, so the answer does not depend on the zoom. Pure: index.js passes in what
// it knows (the ground, the sizes).

export const PIN_CLEAR = 2.6;

/** Is the box (world units) at least `margin` from every one of the posts? */
export function boxClear(posts, left, top, right, bottom, margin = PIN_CLEAR) {
  return posts.every((post) => {
    const dx = Math.max(left - post.x, 0, post.x - right);
    const dy = Math.max(top - post.y, 0, post.y - bottom);
    return dx * dx + dy * dy >= margin * margin;
  });
}

/** The box a town of width `span` takes, its foot at (x, y). */
export function townBox(x, y, span) {
  return [x - span * 0.5, y - span * 0.9, x + span * 0.5, y];
}

/** The box a landmark takes, its foot at (x, y); `size` is its width. */
export function markBox(x, y, size) {
  return [x - size * 0.5, y - size * 0.9, x + size * 0.5, y];
}

/** Where the landmarks of a town with its foot at `at` stand: the usual spots
 * (`spots`, in `unit`s from the town) when they are on land and no pin covers
 * them, else other places round the town. A spot on land that a pin covers is
 * used only when there is nothing better; one that is not on land stays not on
 * land (no landmark is drawn there). Each is { x, y, land }.
 * `dims`: { unit, markMin, spots: [[dx, dy], ...] }. */
export function landmarkSlots(at, span, posts, land, { unit, markMin, spots: usual }) {
  const size = Math.max(markMin, span * 0.8);
  const spots = usual.map(([dx, dy]) => ({ x: at.x + dx * unit, y: at.y + dy * unit }));
  // Other places round the town, nearest first.
  [1, 1.7].forEach((scale) => {
    for (let k = 0; k < 10; k += 1) {
      const angle = (k / 10) * Math.PI * 2 + 0.3;
      spots.push({ x: at.x + Math.cos(angle) * unit * scale, y: at.y + Math.sin(angle) * unit * scale * 0.6 });
    }
  });
  const check = (spot) => ({
    ...spot,
    land: land(spot.x, spot.y),
    clear: boxClear(posts, ...markBox(spot.x, spot.y, size)),
    // Not on the town itself.
    free: Math.hypot(spot.x - at.x, (spot.y - at.y) * 1.4) >= size * 0.9,
  });
  const chosen = [];
  const taken = (spot) => chosen.some((other) => Math.hypot(other.x - spot.x, other.y - spot.y) < size);
  const slots = [];
  const originals = spots.slice(0, usual.length).map(check);
  originals.forEach((spot, index) => {
    if (!spot.land || spot.clear) {
      slots[index] = spot;
      if (spot.land) chosen.push(spot);
    }
  });
  const others = spots.slice(usual.length).map(check).filter((spot) => spot.land && spot.clear && spot.free);
  originals.forEach((spot, index) => {
    if (slots[index]) return;
    const spare = others.find((other) => !taken(other));
    slots[index] = spare || spot;   // nothing clear: where it always stood
    chosen.push(slots[index]);
  });
  return slots.map(({ x, y, land: onLand }) => ({ x, y, land: onLand }));
}

/** A spot for the town where it fits and no pin covers it, nearest the island's
 * middle with the most land round it; null if there is none.
 * `fit`: { ring, span, grown, land(x, y), stands(x, y, span, land, loose) }. */
export function clearTownSpot(posts, island, { ring, span, grown, land, stands }) {
  const near = posts.slice()
    .sort((a, b) => Math.hypot(a.x - island.cx, a.y - island.cy) - Math.hypot(b.x - island.cx, b.y - island.cy))
    .slice(0, 24);
  const candidates = [{ x: island.cx, y: island.cy }];
  [4, 8, 14].forEach((radius) => {
    for (let k = 0; k < 8; k += 1) {
      const angle = (k / 8) * Math.PI * 2;
      candidates.push({ x: island.cx + Math.cos(angle) * radius, y: island.cy + Math.sin(angle) * radius });
    }
  });
  near.forEach((post) => {
    for (let k = 0; k < 8; k += 1) {
      const angle = (k / 8) * Math.PI * 2 + 0.4;
      candidates.push({ x: post.x + Math.cos(angle) * PIN_CLEAR * 2.2, y: post.y + Math.sin(angle) * PIN_CLEAR * 2.2 });
    }
  });
  let best = null;
  let bestScore = -1;
  for (const c of candidates) {
    if (!boxClear(posts, ...townBox(c.x, c.y, span))) continue;
    if (!land(c.x, c.y) || !stands(c.x, c.y, span, land, grown)) continue;
    let score = 0;
    for (let k = 0; k < 8; k += 1) {
      if (land(c.x + Math.cos(k * Math.PI / 4) * ring, c.y + Math.sin(k * Math.PI / 4) * ring)) score += 1;
    }
    if (score > bestScore) { best = c; bestScore = score; }
    if (bestScore === 8) break;
  }
  return best;
}
