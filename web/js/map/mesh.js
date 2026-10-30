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
    case 'house': {
      const turn = ((Math.round(variant) % 6) + 6) % 6;
      const r = (turn * Math.PI) / 12;
      return [box(2.4, 2.4, 2.0, 0, COLOR.wall, r), cone(4, 2.1, 1.5, 2.05, COLOR.roof, r + Math.PI / 4)];
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
      const lit = 0.5 + 0.16 * n[2] + 0.85 * Math.max(0, dot(n, SUN));
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
