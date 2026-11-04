// Small solid shapes (a round tree, a pine, a rock, a house) built from flat
// triangles, seen from above at an angle and shaded face by face. Pure maths:
// nothing here touches the DOM or a canvas, so it is easy to test and the
// painting stays in buildings.js.
//
// Local coordinates: x east, y south (towards the viewer), z up, in WORLD
// units (the same unit the map's ground is built in). One part is convex, so a
// face's outward side is the side away from the part's centre. This is the
// trial "E" of 2026-10-30 moved over as it was.

// The camera looks down at 52 degrees; the sun is top-left and a little behind.
const ELEV = (52 * Math.PI) / 180;
const SINE = Math.sin(ELEV);
const COSE = Math.cos(ELEV);
const VIEW = [0, COSE, SINE];
export const SUN = (() => {
  const v = [-0.36, -0.49, 0.79];
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
})();
/** Where a shadow falls on the ground, per unit of height (world units). */
export const SHADOW_STEP = [-SUN[0] / SUN[2], -SUN[1] / SUN[2]];

export const COLOR = {
  pine: 0x2f8a4f, trunk: 0x8a5a3c, round: 0x58b05a, rock: 0x9a9aa6, wall: 0xf3e8d6, roof: 0xd9573f,
  wood: 0xa97a4c, thatch: 0xd2a94a, stone: 0xc2bfb8, stoneDark: 0xa9a6a0, tower: 0x3f6db3, flag: 0xe0463a,
  blue: 0x4a78b8, trim: 0xdccdb2, glass: 0x6f93b8, door: 0x7a5236,
};

const hex = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const toLin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = (c) => 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.min(1, c) ** (1 / 2.4) - 0.055);
const two = (n) => n.toString(16).padStart(2, '0');

/** A point of a part on the picture: [x, y] with y DOWN, as facesOf() gives. */
export function project(x, y, z) {
  return [x, y * SINE - z * COSE];
}

export function part(tris, center, color) {
  return { tris, center, color: hex(color).map(toLin) };
}

export function cone(seg, r, h, z0, color, rot = 0) {
  const tris = [];
  const apex = [0, 0, z0 + h];
  for (let s = 0; s < seg; s += 1) {
    const a0 = rot + (s / seg) * Math.PI * 2;
    const a1 = rot + ((s + 1) / seg) * Math.PI * 2;
    tris.push([apex, [Math.cos(a0) * r, Math.sin(a0) * r, z0], [Math.cos(a1) * r, Math.sin(a1) * r, z0]]);
  }
  return part(tris, [0, 0, z0 + h * 0.3], color);
}

export function cyl(seg, r, h, z0, color) {
  const tris = [];
  for (let s = 0; s < seg; s += 1) {
    const a0 = (s / seg) * Math.PI * 2;
    const a1 = ((s + 1) / seg) * Math.PI * 2;
    const p0 = [Math.sin(a0) * r, Math.cos(a0) * r];
    const p1 = [Math.sin(a1) * r, Math.cos(a1) * r];
    tris.push([[...p0, z0], [...p1, z0], [...p1, z0 + h]], [[...p0, z0], [...p1, z0 + h], [...p0, z0 + h]]);
  }
  return part(tris, [0, 0, z0 + h / 2], color);
}

export function box(w, d, h, z0, color, rot) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const P = (x, y, z) => [x * c - y * s, x * s + y * c, z];
  const v = [];
  for (const z of [z0, z0 + h]) {
    for (const [x, y] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) v.push(P(x, y, z));
  }
  const q = (a, b, cc, dd) => [[v[a], v[b], v[cc]], [v[a], v[cc], v[dd]]];
  return part(
    [...q(4, 5, 6, 7), ...q(0, 1, 5, 4), ...q(1, 2, 6, 5), ...q(2, 3, 7, 6), ...q(3, 0, 4, 7)],
    [0, 0, z0 + h / 2], color,
  );
}

const ICO = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((p) => { const n = Math.hypot(...p); return [p[0] / n, p[2] / n, p[1] / n]; });
  const f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  return { v, f };
})();

/** A 20-sided ball, `rx` wide, `rz` tall, its middle at height `cz`; faces
 * whose middle is not above `cut` are left out (the part under the ground). */
export function ico(rx, rz, cz, color, rot = 0, cut = -Infinity) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const P = ([x, y, z]) => [(x * c - y * s) * rx, (x * s + y * c) * rx, z * rz + cz];
  const tris = ICO.f.map((f) => f.map((i) => P(ICO.v[i]))).filter((t) => (t[0][2] + t[1][2] + t[2][2]) / 3 > cut);
  return part(tris, [0, 0, cz], color);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------------------------------------------------------------- house tiers
// A house grows with what its post gathers (2026-10-31, the user: reactions and
// messages make the house next to it bigger: hut, house, manor, castle).
export const HOUSE_TIERS = ['hut', 'house', 'manor', 'castle'];
/** From this many reactions and messages on, a post's house is of that tier:
 * [house, manor, castle]; fewer than the first is a hut. One place to tune. */
export const HOUSE_TIER_FROM = [1, 4, 10];
/** How wide each tier is across, in world units - a guide (the manor draws a
 * little narrower); it decides whether a tier is big enough on screen to draw. */
export const HOUSE_WIDTH = [2.4, 3, 4.2, 5.6];

/** Which of the six turns (15 degrees a step) a house with this seed is drawn
 * at. The one rule for drawing it, lighting its windows and placing it by its
 * body (HOUSE_BODY): a seed from hashId runs to 2^32 - 1, and placing it by
 * `seed % 6` while drawing it by `|seed | 0| % 6` put a third of the manors and
 * castles on their faces (2026-10-31, the user: the face stood on the roof). */
export function houseTurn(seed) {
  return Math.abs(Number(seed) | 0) % 6;
}

/** Of a house's size, per tier (hut, house, manor, castle) and per turn
 * (houseTurn): how far its walls and roof reach left of where it stands, and
 * below its foot (its shadow falls further, down and to the right). Measured on
 * the drawn pictures (pixels at least 120 opaque, shadow left out) and rounded up
 * a little. */
export const HOUSE_BODY = [
  [[0.41, 0.24], [0.48, 0.29], [0.53, 0.33], [0.54, 0.35], [0.51, 0.34], [0.46, 0.31]],
  Array(6).fill([0.7, 0.44]),
  [[0.89, 0.54], [0.90, 0.68], [0.84, 0.78], [0.72, 0.83], [0.62, 0.82], [0.71, 0.76]],
  [[0.95, 0.48], [1.03, 0.50], [1.04, 0.61], [0.98, 0.70], [0.86, 0.75], [0.70, 0.75]], // the top tier is no longer a castle (2026-11-04)
];

/** Where a house stands (x, foot) for a pin at (px, py): its body's nearest
 * corner `clear` px up and to the right of the pin. `size` is drawHouse's size. */
export function houseSpot(px, py, clear, size, tier, seed) {
  const body = HOUSE_BODY[tierIndex(tier)][houseTurn(seed)];
  return { x: px + clear * Math.SQRT1_2 + size * body[0], foot: py - clear * Math.SQRT1_2 - size * body[1] };
}

const count = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };

/** Reactions and messages a post has gathered: like + help + join + comment counts. */
export function houseScore(post) {
  const p = post || {};
  return count(p.like_count) + count(p.help_count) + count(p.join_count) + count(p.comment_count);
}

/** 0..3 (hut, house, manor, castle) from like + help + join + comment counts. */
export function houseTier(post) {
  const n = houseScore(post);
  return HOUSE_TIER_FROM.filter((from) => n >= from).length;
}

/** A tier by number or name, as an index 0..3 (anything else is a house). */
export function tierIndex(tier) {
  if (typeof tier === 'string') { const i = HOUSE_TIERS.indexOf(tier); return i < 0 ? 1 : i; }
  const n = Math.round(Number(tier));
  return Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : 1;
}

/** Move a part by (ox, oy, oz), then turn it by `r` about the foot. The flags a
 * part carries (`wall`, `glass`) go with it: the first version of this dropped
 * them and every wall was lit as a grey one (2026-11-04). */
function placed(pt, ox, oy, oz, r) {
  const c = Math.cos(r);
  const s = Math.sin(r);
  const P = ([x, y, z]) => [(x + ox) * c - (y + oy) * s, (x + ox) * s + (y + oy) * c, z + oz];
  const out = { ...pt, tris: pt.tris.map((t) => t.map(P)), center: P(pt.center) };
  if (pt.glass) out.glass = [pt.glass[0] * c - pt.glass[1] * s, pt.glass[0] * s + pt.glass[1] * c];
  return out;
}

/** A hip roof on a w x d plan (w >= d): the ridge is w - d long (0 = a pyramid). */
function roof(w, d, h, z0, color) {
  const rl = Math.max(0, (w - d) / 2);
  const a = [-w / 2, -d / 2, z0]; const b = [w / 2, -d / 2, z0];
  const c = [w / 2, d / 2, z0]; const e = [-w / 2, d / 2, z0];
  const r0 = [-rl, 0, z0 + h]; const r1 = [rl, 0, z0 + h];
  const tris = [[a, b, r1], [a, r1, r0], [e, c, r1], [e, r1, r0], [a, e, r0], [b, c, r1]];
  return part(tris, [0, 0, z0 + h * 0.3], color);
}

/** A part slid by (dx, dy) inside its group, its flags kept. */
function slid(pt, dx, dy) {
  const P = ([x, y, z]) => [x + dx, y + dy, z];
  return { ...pt, tris: pt.tris.map((t) => t.map(P)), center: P(pt.center) };
}

/** A white wall block: lit as a wall (see facesOf). */
const wallBox = (w, d, h, z0 = 0) => ({ ...box(w, d, h, z0, COLOR.wall, 0), wall: true });
/** A door in the south (+y) wall of a block `d` deep, at `x` along it. */
const door = (d, x, h = 0.95, wd = 0.5) => slid(box(wd, 0.05, h, 0, COLOR.door, 0), x, d / 2 + 0.02);
/** A pane in the south wall (a block `d` deep) or the east wall (a block `w` wide).
 * `glass` is the way the pane faces: houseLights glows the ones that face the viewer. */
const paneS = (d, x, z0, w = 0.5, h = 0.6) => ({ ...slid(box(w, 0.05, h, z0, COLOR.glass, 0), x, d / 2 + 0.02), glass: [0, 1] });
const paneE = (w, y, z0, d = 0.5, h = 0.6) => ({ ...slid(box(0.05, d, h, z0, COLOR.glass, 0), w / 2 + 0.02, y), glass: [1, 0] });
/** `floors` rows of `n` panes along the south wall of a w x d block, one on its east wall. */
function paneRows(w, d, floors, z0, step, n) {
  const out = [];
  for (let f = 0; f < floors; f += 1) {
    for (let i = 0; i < n; i += 1) out.push(paneS(d, (i - (n - 1) / 2) * (w / n), z0 + f * step, 0.42, 0.55));
    out.push(paneE(w, 0, z0 + f * step, 0.42, 0.55));
  }
  return out;
}

/** Groups of parts (a building = walls then roof) are laid down back to front. */
function inOrder(groups) {
  return groups.sort((a, b) => a.y - b.y).flatMap((g) => g.parts);
}

function tierParts(tier, turn) {
  const r = (turn * Math.PI) / 12;
  const g = (ox, oy, list) => {
    const parts = list.map((pt) => placed(pt, ox, oy, 0, r));
    const y = Math.sin(r) * ox + Math.cos(r) * oy;
    return { y, parts };
  };
  const B = (w, d, h, z0, color) => box(w, d, h, z0, color, 0);
  const R = (w, d, h, z0, color) => roof(w, d, h, z0, color);
  const C = (seg, rad, h, z0, color) => cyl(seg, rad, h, z0, color);
  const K = (seg, rad, h, z0, color) => cone(seg, rad, h, z0, color, seg === 4 ? Math.PI / 4 : 0);
  switch (tier) {
    case 0: // hut: one small wooden room under a low thatched roof, a door and two small windows
      return inOrder([g(0, 0, [B(1.9, 1.7, 1.2, 0, COLOR.wood), door(1.7, -0.35, 0.8, 0.42),
        paneS(1.7, 0.45, 0.55, 0.34, 0.32), paneE(1.9, 0, 0.55, 0.34, 0.32), R(2.3, 2.1, 0.95, 1.15, COLOR.thatch)])]);
    case 1: // house: a white box under a red pyramid roof, a door and three windows
      return inOrder([g(0, 0, [wallBox(2.4, 2.4, 2.0), door(2.4, -0.45), paneS(2.4, 0.55, 0.8),
        paneE(2.4, -0.4, 0.8), paneE(2.4, 0.5, 0.8), K(4, 2.1, 1.5, 2.05, COLOR.roof)])]);
    case 2: // manor: two storeys, a wing at one end (an L, with its own door), a chimney
      return inOrder([
        g(-0.5, -0.9, [wallBox(3.8, 2.2, 2.6), ...[-1, 0, 1].map((i) => paneS(2.2, i * (3.8 / 3), 0.9, 0.42, 0.55)),
          paneE(3.8, 0, 0.9, 0.42, 0.55), R(4.2, 2.6, 1.3, 2.55, COLOR.roof), slid(B(0.5, 0.5, 1.1, 2.6, COLOR.stoneDark), 0.9, -0.3)]),
        g(1.4, 0.8, [wallBox(2.0, 2.4, 2.0), door(2.4, -0.3), paneS(2.4, 0.45, 0.75, 0.42, 0.55),
          paneE(2.0, 0, 0.75, 0.42, 0.55), R(2.4, 2.8, 1.1, 1.95, COLOR.roof)]),
      ]);
    case 3: // top tier (2026-11-04, the user: not a castle): a long two-storey house, blue roof, a porch over the door
      return inOrder([
        g(0, -0.3, [wallBox(5.2, 2.8, 3.0), B(5.3, 2.9, 0.14, 1.42, COLOR.trim), ...paneRows(5.2, 2.8, 2, 0.55, 1.45, 4),
          R(5.6, 3.2, 1.45, 2.95, COLOR.blue), slid(B(0.45, 0.45, 1.1, 3.2, COLOR.stoneDark), -1.7, -0.3),
          slid(B(0.45, 0.45, 1.1, 3.2, COLOR.stoneDark), 1.7, -0.3), slid(B(0.6, 0.05, 1.0, 0, COLOR.door), 0, 1.42)]),
        // the porch is its own group, laid after the main one, so its roof covers the door
        g(0, 1.45, [slid(C(4, 0.06, 1.2, 0, COLOR.trunk), -0.6, 0.25), slid(C(4, 0.06, 1.2, 0, COLOR.trunk), 0.6, 0.25),
          R(1.7, 0.9, 0.35, 1.2, COLOR.blue)]),
      ]);
    default: return null;
  }
}

/** How big each tier's night glow is round one window (facesOf's units). */
const LIGHT_R = [0.9, 1.0, 0.9, 0.7];

/** Is the point [x, y] inside the triangle `t` (on the picture)? */
function inTriangle([x, y], t) {
  const side = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const d = [side(t[0], t[1]), side(t[1], t[2]), side(t[2], t[0])];
  return d.every((v) => v >= 0) || d.every((v) => v <= 0);
}

/** The windows that glow at night, per tier: [x, y, r] on the picture (facesOf's
 * units). They come from the window panes themselves, so they sit on the panes
 * at every turn. A pane glows only if its wall faces the viewer and nothing
 * drawn after it (the wing's roof, the porch roof) covers it. */
export function houseLights(tier, variant = 0) {
  const t = tierIndex(tier);
  const turn = ((Math.round(variant) % 6) + 6) % 6;
  const parts = tierParts(t, turn);
  const out = [];
  parts.forEach((pt, i) => {
    if (!pt.glass || pt.glass[1] * COSE <= 0.001) return;
    const [x, y, z] = pt.center;
    const at = [x + pt.glass[0] * 0.03, (y + pt.glass[1] * 0.03) * SINE - z * COSE];
    if (facesOf(parts.slice(i + 1).filter((o) => !o.glass)).some((f) => inTriangle(at, f.pts))) return;
    out.push([at[0], at[1], LIGHT_R[t]]);
  });
  return out;
}

/** The shapes of one thing, at unit size. kind: tree | pine | bush | rock | house.
 * `variant` turns a rock (0..2) or a house (any whole number, 15 degrees a step). */
export function partsOf(kind, variant = 0) {
  switch (kind) {
    case 'pine': return [cone(6, 1.1, 2.6, -0.2, COLOR.pine)];
    case 'bush': return [ico(0.85, 0.7, 0.5, COLOR.round, 0.4)];
    case 'rock': {
      const v = ((variant % 3) + 3) % 3;
      return [ico(1, [0.5, 0.65, 0.8][v], 0.12, COLOR.rock, v * 1.7 + 0.4, -0.04)];
    }
    case 'hut': case 'manor': case 'castle': {
      const turn = ((Math.round(variant) % 6) + 6) % 6;
      return tierParts(HOUSE_TIERS.indexOf(kind), turn);
    }
    case 'house': {
      const turn = ((Math.round(variant) % 6) + 6) % 6;
      return tierParts(1, turn);
    }
    default: return [cyl(5, 0.35, 1, 0, COLOR.trunk), ico(1.1, 1.0, 1.4, COLOR.round)];
  }
}

/** Project parts into flat faces: [{ pts: [[x, y] x3], fill: '#rrggbb' }], x
 * to the right, y DOWN, the origin at the thing's foot, one unit = one world
 * unit. Faces turned away are dropped; inside a part they run from the back to
 * the front, and the parts are kept in the order given (a roof after its walls,
 * a crown after its trunk), which is always right seen from above. */
export function facesOf(parts) {
  const out = [];
  for (const p of parts) {
    const own = [];
    for (const t of p.tris) {
      let n = cross(sub(t[1], t[0]), sub(t[2], t[0]));
      const len = Math.hypot(...n) || 1;
      n = n.map((x) => x / len);
      const cen = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3, (t[0][2] + t[1][2] + t[2][2]) / 3];
      if (dot(n, sub(cen, p.center)) < 0) n = n.map((x) => -x);
      if (dot(n, VIEW) <= 0.001) continue;
      // A hemisphere of sky plus the sun, in linear light.
      // A white wall: both walls the viewer sees are on the shadow side of the
      // sun, which made them grey (2026-11-04, the user), so they are lit by
      // their own rule: bright, the south one a little brighter, the east one dimmer.
      const lit = p.wall
        ? 0.84 + 0.1 * n[1] - 0.06 * Math.abs(n[0]) + 0.12 * n[2]
        : 0.5 + 0.16 * n[2] + 0.85 * Math.max(0, dot(n, SUN));
      const rgb = p.color.map((c) => Math.round(toSrgb(c * lit)));
      own.push({
        pts: t.map(([x, y, z]) => [x, y * SINE - z * COSE]),
        depth: cen[1] * COSE + cen[2] * SINE,
        fill: `#${rgb.map(two).join('')}`,
      });
    }
    own.sort((a, b) => a.depth - b.depth);
    own.forEach(({ pts, fill }) => out.push({ pts, fill }));
  }
  return out;
}

/** The soft shadow on the ground of something `rr` wide and `h` tall: a round
 * patch stretched along the sun, as a polygon in world units from the foot. */
export function shadowOutline(rr, h, count = 14) {
  const along = rr + Math.hypot(...SHADOW_STEP) * h * 0.5;
  const across = rr * 0.95;
  const angle = Math.atan2(SHADOW_STEP[1], SHADOW_STEP[0]);
  const cx = SHADOW_STEP[0] * h * 0.45;
  const cy = SHADOW_STEP[1] * h * 0.45;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  return Array.from({ length: count }, (_, i) => {
    const t = (i / count) * Math.PI * 2;
    const u = Math.cos(t) * along;
    const v = Math.sin(t) * across;
    return [cx + u * ca - v * sa, cy + u * sa + v * ca];
  });
}

/** Size of each kind for its shadow: [radius, height] in world units at unit size. */
export const SHADOW_OF = {
  tree: [1.1, 2.4], pine: [1.1, 2.6], bush: [0.85, 1.2], rock: [1, 0.8], house: [1.7, 3.55],
  hut: [1.3, 2.2], manor: [2.7, 3.9], castle: [3.0, 4.6],
};

/** Where the middle of the wall that faces the viewer most is, and how high a
 * window sits: [x, y] in the same units as facesOf. */
export function houseWindow(variant = 0) {
  const turn = ((Math.round(variant) % 6) + 6) % 6;
  const r = (turn * Math.PI) / 12;
  let best = null;
  for (let k = 0; k < 4; k += 1) {
    const a = r + (k * Math.PI) / 2;
    const x = Math.cos(a) * 1.2;
    const y = Math.sin(a) * 1.2;
    if (!best || y > best.y) best = { x, y };
  }
  return [best.x, best.y * SINE - 0.95 * COSE];
}
