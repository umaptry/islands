// The 24 landmarks (lighthouse, windmill, library ...) as small solids of flat triangles,
// the same way as the houses and trees in mesh.js: seen from above at an angle,
// shaded face by face, and painted by buildings.js. This is the trial "C 風" of
// 2026-10-31 moved over; which landmark an island gets, and where it stands, is
// decided elsewhere (index.js, spots.js) and is not touched here.
//
// Pure data: no DOM, no canvas. Local coordinates as in mesh.js: x east, y south
// (towards the viewer), z up, in WORLD units, the origin in the middle of the
// foot print on the ground. Every landmark faces south (its front is at +y).
// Parts are listed bottom to top and back to front: facesOf() keeps their order.
import { COLOR, box, cone, cyl, ico, part, project } from './mesh.js';

// ---------------------------------------------------------------- colours (the house's and the trees' tones, a little muted)
const C = {
  wall: COLOR.wall, roof: COLOR.roof,
  trunk: COLOR.trunk, leaf: COLOR.round, pine: COLOR.pine,
  roofDark: 0xb04a37, roofWine: 0x8c3a30, roofTeal: 0x4f8f86, slate: 0x6f7f8c,
  stone: 0xcfc8bc, stoneDark: COLOR.rock, soot: 0x6a6460,
  white: 0xf7f4ee, glass: 0xa9d3dc, glassPale: 0xbfe3dc, water: 0x7bc3df, blue: 0x7fb5c9,
  wood: 0xc9a77a, woodDark: COLOR.trunk, lamp: 0xf3dc8a, gold: 0xe8c25a,
  pink: 0xf0b3a8, fire: 0xe8924a, bread: 0xe2b27a,
  plaza: 0xe6dcc0, soil: 0xc2a074, lawn: 0x8fc566, rowA: 0x8fc566, rowB: 0x5c9f48, hedge: 0x4d8a40,
  smithWall: 0xbdb7ae, domeWhite: 0xdce8ee,
};

// ---------------------------------------------------------------- sizes (world units; E's house is 2.4 x 2.4, 3.55 high)
const DIM = {
  lighthouse: { plinthR: 1.75, plinthH: 0.6, bandR: 1.3, bandTaper: 0.13, bandH: 1.5, bands: 4, lanternR: 0.6, lanternH: 0.9, roofH: 0.9 },
  clock: { w: 2.6, h: 5.4, roofR: 2.6, roofH: 2.2, face: 1.35 },
  watch: { leg: 1.1, legH: 4.2, deck: 3.1, cabin: 2.0, cabinH: 1.4 },
  observatory: { r: 2.2, h: 2.3, domeR: 2.25, domeH: 2.0 },
  music: { w: 4.6, d: 3.4, h: 2.0, domeR: 2.0 },
  manor: { w: 5.2, d: 3.4, h: 2.6, roofRise: 1.6, over: 0.7 },
  workshop: { w: 4.4, d: 3.2, h: 2.2, roofRise: 1.35, over: 0.6 },
  clinic: { w: 4.6, d: 3.4, h: 3.0 },
  greenhouse: { w: 5.0, d: 3.0, base: 0.5, glassH: 1.5, roofRise: 1.2 },
  windmill: { r0: 1.55, r1: 1.0, h: 4.6, blade: 3.1 },
  market: { w: 5.4, d: 1.2, post: 2.4 },
  pier: { w: 6.0, d: 2.0, z: 0.6 },
  flat: { w: 6.2, d: 4.4, t: 0.35 },
  shop: { w: 3.8, d: 3.0, h: 2.2, roofRise: 1.2, over: 0.5 },
};

// ---------------------------------------------------------------- helpers on top of part()
/** Move a part by (dx, dy, dz). */
function at(p, dx, dy, dz = 0) {
  return { tris: p.tris.map((t) => t.map(([x, y, z]) => [x + dx, y + dy, z + dz])), center: [p.center[0] + dx, p.center[1] + dy, p.center[2] + dz], color: p.color };
}
/** cyl() has an open top (a tree trunk is hidden by its crown); a building needs the lid. */
function capCyl(seg, r, h, z0, color) {
  const p = cyl(seg, r, h, z0, color), tris = [...p.tris];
  for (let s = 0; s < seg; s++) {
    const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
    tris.push([[0, 0, z0 + h], [Math.sin(a0) * r, Math.cos(a0) * r, z0 + h], [Math.sin(a1) * r, Math.cos(a1) * r, z0 + h]]);
  }
  return { ...p, tris };
}
/** A round tower that narrows upwards, with a lid. */
function frustum(seg, r0, r1, h, z0, color) {
  const tris = [];
  for (let s = 0; s < seg; s++) {
    const a0 = (s / seg) * Math.PI * 2, a1 = ((s + 1) / seg) * Math.PI * 2;
    const b0 = [Math.sin(a0) * r0, Math.cos(a0) * r0, z0], b1 = [Math.sin(a1) * r0, Math.cos(a1) * r0, z0];
    const t0 = [Math.sin(a0) * r1, Math.cos(a0) * r1, z0 + h], t1 = [Math.sin(a1) * r1, Math.cos(a1) * r1, z0 + h];
    tris.push([b0, b1, t1], [b0, t1, t0], [[0, 0, z0 + h], t0, t1]);
  }
  return part(tris, [0, 0, z0 + h / 2], color);
}
/** A roof with its ridge along x: w long, d deep, rising h above the eaves at z0. */
function gable(w, d, h, z0, color) {
  const a = [-w / 2, -d / 2, z0], b = [w / 2, -d / 2, z0], c = [w / 2, d / 2, z0], dd = [-w / 2, d / 2, z0];
  const r1 = [-w / 2, 0, z0 + h], r2 = [w / 2, 0, z0 + h];
  return part([[dd, c, r2], [dd, r2, r1], [a, r1, r2], [a, r2, b], [a, dd, r1], [b, c, r2]], [0, 0, z0 + h * 0.3], color);
}
/** A lean-to (an awning): high against the back wall (-y), sloping down to the front (+y). */
function wedge(w, d, h, z0, color) {
  const bt1 = [-w / 2, -d / 2, z0 + h], bt2 = [w / 2, -d / 2, z0 + h], bb1 = [-w / 2, -d / 2, z0], bb2 = [w / 2, -d / 2, z0];
  const f1 = [-w / 2, d / 2, z0], f2 = [w / 2, d / 2, z0];
  return part([[bt1, bt2, f2], [bt1, f2, f1], [bb1, bb2, bt2], [bb1, bt2, bt1], [bb1, f1, bt1], [bb2, f2, bt2]], [0, 0, z0 + h * 0.3], color);
}
/** A flat convex plate standing in the x-z plane (a mill sail), `thick` deep from y0. pts = [[x, z], ...]. */
function plate(pts, y0, thick, color) {
  const fr = pts.map(([x, z]) => [x, y0 + thick, z]), bk = pts.map(([x, z]) => [x, y0, z]);
  const tris = [];
  for (let i = 1; i < pts.length - 1; i++) tris.push([fr[0], fr[i], fr[i + 1]], [bk[0], bk[i], bk[i + 1]]);
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; tris.push([bk[i], bk[j], fr[j]], [bk[i], fr[j], fr[i]]); }
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return part(tris, [cx, y0 + thick / 2, cz], color);
}
const ball = (r, x, y, z, color) => at(ico(r, r, 0, color), x, y, z);
const tree = (sc, x, y) => [at(cyl(5, 0.35 * sc, sc, 0, C.trunk), x, y), at(ico(1.1 * sc, 1.0 * sc, 1.4 * sc, C.leaf), x, y)];
const smokeBalls = (x, y, z) => [ball(0.38, x, y, z, 0xf2f2f2), ball(0.5, x + 0.35, y - 0.15, z + 0.75, 0xf6f6f6)];
/** A thin colour patch on a wall: w wide, h high, bottom at z0, on the south face of depth `face` at x. */
const patch = (x, face, w, h, z0, color) => at(box(w, 0.12, h, z0, color, 0), x, face + 0.03);

// ---------------------------------------------------------------- the twelve forms
function lighthouse() {
  const g = DIM.lighthouse, out = [capCyl(8, g.plinthR, g.plinthH, 0, C.stone)];
  let z = g.plinthH, r = g.bandR;
  for (let i = 0; i < g.bands; i++) {
    out.push(frustum(8, r, r - g.bandTaper, g.bandH, z, i % 2 === 0 ? C.white : C.roof));
    z += g.bandH; r -= g.bandTaper;
  }
  out.push(capCyl(8, r + 0.35, 0.3, z, C.slate)); z += 0.3;
  out.push(capCyl(8, g.lanternR, g.lanternH, z, C.lamp)); z += g.lanternH;
  out.push(cone(8, g.lanternR + 0.4, g.roofH, z, C.roofDark));
  return out;
}

function tower(v) {
  if (v === 'watch') {
    const g = DIM.watch, out = [];
    for (const [x, y] of [[-g.leg, -g.leg], [g.leg, -g.leg], [-g.leg, g.leg], [g.leg, g.leg]]) out.push(at(box(0.32, 0.32, g.legH, 0, C.woodDark, 0), x, y));
    out.push(box(g.deck, g.deck, 0.28, g.legH, C.wood, 0));
    out.push(box(g.cabin, g.cabin, g.cabinH, g.legH + 0.28, C.wood, 0));
    out.push(cone(4, g.cabin * 1.05, 1.2, g.legH + 0.28 + g.cabinH, C.roofDark, Math.PI / 4));
    out.push(at(box(g.deck, 0.1, 0.45, g.legH + 0.28, C.woodDark, 0), 0, g.deck / 2 - 0.1));
    out.push(patch(0, g.cabin / 2, 0.6, 0.6, g.legH + 0.7, C.lamp));
    return out;
  }
  const g = DIM.clock, f = g.face, zc = 3.75;
  return [
    box(g.w, g.w, g.h, 0, C.wall, 0),
    box(g.w + 0.4, g.w + 0.4, 0.3, g.h, C.stone, 0),
    cone(4, g.roofR, g.roofH, g.h + 0.3, C.roof, Math.PI / 4),
    at(box(f + 0.35, 0.12, f + 0.35, zc - 0.175, C.woodDark, 0), 0, g.w / 2 + 0.03),
    at(box(f, 0.14, f, zc, C.white, 0), 0, g.w / 2 + 0.08),
    at(box(0.12, 0.16, 0.55, zc + f / 2, C.soot, 0), 0, g.w / 2 + 0.13),
    at(box(0.45, 0.16, 0.12, zc + f / 2 - 0.06, C.soot, 0), 0.2, g.w / 2 + 0.13),
    patch(0, g.w / 2, 0.7, 1.1, 0.0, C.woodDark),
  ];
}

function dome(v) {
  if (v === 'music') {
    const g = DIM.music, out = [box(g.w, g.d, g.h, 0, C.wall, 0)];
    out.push(ico(g.domeR, g.domeR * 0.85, g.h, C.roof, 0, g.h - 0.05));
    out.push(ball(0.28, 0, 0, g.h + g.domeR * 0.85 + 0.1, C.gold));
    for (const x of [-1.6, -0.55, 0.55, 1.6]) out.push(at(box(0.3, 0.3, 1.7, 0, C.white, 0), x, g.d / 2 + 0.25));
    out.push(patch(0, g.d / 2, 0.8, 1.3, 0, C.woodDark));
    return out;
  }
  const g = DIM.observatory;
  return [
    capCyl(8, g.r, g.h, 0, C.wall),
    capCyl(8, g.r + 0.15, 0.25, g.h, C.stone),
    ico(g.domeR, g.domeH, g.h + 0.25, C.domeWhite, 0, g.h + 0.2),
    at(box(0.5, 0.3, 1.5, g.h + 0.7, C.slate, 0), 0, g.domeR * 0.72),
    patch(0, g.r * 0.92, 0.8, 1.3, 0, C.woodDark),
  ];
}

function manor(v) {
  const g = DIM.manor, { w, d, h } = g, fy = d / 2, out = [];
  if (v === 'gallery') {
    out.push(box(w, d, h + 0.2, 0, C.white, 0), box(w + 0.5, d + 0.5, 0.3, h + 0.2, C.roofDark, 0));
    out.push(patch(0, fy, 0.8, 1.4, 0, C.woodDark));
    [[-1.8, C.pink], [-0.95, C.blue], [1.0, C.gold], [1.85, C.pink]].forEach(([x, c]) => out.push(patch(x, fy, 0.65, 0.85, 1.0, c)));
    return out;
  }
  const roofC = { library: C.roofTeal, school: C.roof, theater: C.roofWine }[v] || C.roof;
  out.push(box(w, d, h, 0, v === 'library' ? 0xe9e6dc : C.wall, 0));
  out.push(gable(w + g.over, d + g.over, g.roofRise, h, roofC));
  out.push(patch(0, fy, 0.8, 1.4, 0, C.woodDark));
  if (v === 'library') {
    for (const x of [-1.9, -1.0, 1.0, 1.9]) out.push(patch(x, fy, 0.5, 1.2, 0.9, C.glass));
    out.push(at(box(1.5, 0.5, 0.2, 0, C.stone, 0), 0, fy + 0.25));
  } else {
    for (const x of [-1.7, 1.7]) out.push(patch(x, fy, 0.65, 0.75, 1.0, C.glass));
  }
  if (v === 'school') {
    out.push(at(box(1.1, 1.1, 1.5, 0, C.wall, 0), -1.4, 0, h + g.roofRise - 0.75));
    out.push(at(cone(4, 1.05, 0.9, 0, C.roofDark, Math.PI / 4), -1.4, 0, h + g.roofRise + 0.75));
  }
  if (v === 'theater') {
    out.push(at(box(3.0, 0.8, 0.22, 0, C.gold, 0), 0, fy + 0.4, 2.0));
    for (const x of [-1.1, 1.1]) out.push(patch(x, fy, 0.5, 1.3, 0.1, C.roof));
  }
  return out;
}

function workshop(v) {
  const g = DIM.workshop, { w, d, h } = g, smithy = v === 'smithy';
  const out = [
    box(w, d, h, 0, smithy ? C.smithWall : C.wall, 0),
    gable(w + g.over, d + g.over, g.roofRise, h, smithy ? C.slate : C.roof),
    patch(-1.0, d / 2, 0.9, 1.4, 0, C.woodDark),
    at(box(0.8, 0.8, 2.3, 0, C.stoneDark, 0), 1.3, -0.5, h + 0.5),
  ];
  out.push(...smokeBalls(1.3, -0.5, h + 3.1));
  if (smithy) {
    out.push(at(box(1.0, 0.8, 0.7, 0, C.soot, 0), 1.0, d / 2 + 0.5), at(box(0.6, 0.12, 0.35, 0.7, C.fire, 0), 1.0, d / 2 + 0.55));
    out.push(at(box(0.7, 0.4, 0.45, 0, C.soot, 0), -1.9, d / 2 + 0.5));
  } else {
    out.push(at(box(0.9, 0.9, 0.8, 0, C.wood, 0), 1.3, d / 2 + 0.55), at(box(0.8, 0.8, 0.6, 0, C.wood, 0), 2.45, d / 2 + 0.35));
  }
  return out;
}

function clinic(v) {
  const g = DIM.clinic, { w, d, h } = g, lab = v === 'lab';
  const out = [box(w, d, h, 0, C.wall, 0)];
  if (lab) {
    out.push(box(w + 0.4, d + 0.4, 0.3, h, C.stoneDark, 0), box(w, d, 0.12, h + 0.3, C.stone, 0), patch(-1.2, d / 2, 0.8, 1.4, 0, C.blue));
    for (const x of [0.2, 1.4]) out.push(patch(x, d / 2, 0.6, 1.0, 1.1, C.glass));
    out.push(at(box(1.6, 1.4, 1.0, 0, C.wall, 0), -0.9, -0.2, h + 0.42), at(box(1.8, 1.6, 0.25, 0, C.blue, 0), -0.9, -0.2, h + 1.42));
    out.push(at(box(0.1, 0.1, 1.6, 0, C.stoneDark, 0), 1.5, -0.4, h + 0.42), ball(0.22, 1.5, -0.4, h + 2.2, C.roof));
  } else {
    out.push(gable(w + 0.5, d + 0.5, 1.1, h, C.blue), patch(-1.2, d / 2, 0.8, 1.4, 0, C.blue));
    out.push(patch(1.0, d / 2, 0.9, 0.25, 1.65, C.roof), patch(1.0, d / 2, 0.25, 0.9, 1.33, C.roof));
    out.push(patch(2.0, d / 2, 0.45, 0.9, 0.9, C.glass), patch(0.0, d / 2, 0.45, 0.9, 0.9, C.glass));
  }
  return out;
}

function greenhouse() {
  const g = DIM.greenhouse, { w, d } = g;
  const out = [box(w + 0.2, d + 0.2, g.base, 0, C.stone, 0), box(w, d, g.glassH, g.base, C.glassPale, 0)];
  out.push(gable(w + 0.2, d + 0.2, g.roofRise, g.base + g.glassH, 0xd0ece6));
  for (const x of [-0.9, 0.9]) out.push(patch(x, d / 2, 0.14, g.glassH, g.base, C.white));
  out.push(patch(0, d / 2, 0.75, 1.15, g.base, C.glass));
  out.push(ball(0.45, -1.9, d / 2 + 0.45, 0.45, C.leaf), ball(0.4, 1.9, d / 2 + 0.4, 0.4, C.pine), ball(0.32, 2.45, d / 2 + 0.3, 0.32, C.pink));
  return out;
}

function windmill() {
  const g = DIM.windmill, out = [capCyl(8, g.r0 + 0.2, 0.5, 0, C.stone), frustum(8, g.r0, g.r1, g.h, 0.5, C.wall)];
  out.push(cone(8, g.r1 + 0.35, 1.3, g.h + 0.5, C.roofDark));
  out.push(patch(0, g.r0 * 0.92, 0.8, 1.3, 0.5, C.woodDark));
  const hy = 1.2, hz = g.h - 0.2;
  const blades = [];
  for (let k = 0; k < 4; k++) {
    const th = 0.5 + (k * Math.PI) / 2, u = [Math.cos(th), Math.sin(th)], n = [-u[1], u[0]];
    const P = (r, o) => [u[0] * r + n[0] * o, hz + u[1] * r + n[1] * o];
    blades.push(plate([P(0, -0.06), P(g.blade, -0.06), P(g.blade, 0.06), P(0, 0.06)], hy, 0.1, C.woodDark));
    blades.push(plate([P(0.9, 0.08), P(g.blade, 0.08), P(g.blade, 0.78), P(0.9, 0.78)], hy + 0.1, 0.06, k % 2 ? C.white : C.stone));
  }
  // the lowest blades are drawn first so that a higher one is never covered by a lower one
  out.push(...blades, at(ico(0.3, 0.3, 0, C.roof), 0, hy + 0.15, hz));
  return out;
}

function market() {
  const g = DIM.market, out = [at(box(g.w, 0.3, 2.0, 0, C.white, 0), 0, -g.d / 2 - 0.1)];
  out.push(at(box(g.w - 0.4, g.d, 0.85, 0, C.wood, 0), 0, 0.2));
  out.push(at(box(0.18, 0.18, g.post, 0, C.woodDark, 0), -g.w / 2 + 0.1, g.d / 2 + 0.1), at(box(0.18, 0.18, g.post, 0, C.woodDark, 0), g.w / 2 - 0.1, g.d / 2 + 0.1));
  const col = [C.roof, C.white, C.blue];
  for (let i = 0; i < 3; i++) out.push(at(cone(4, 1.3, 1.1, g.post - 0.1, col[i], Math.PI / 4), (i - 1) * 1.8, 0.15));
  [[-1.8, C.roof], [0, C.gold], [1.8, C.leaf]].forEach(([x, c]) => out.push(ball(0.3, x, 0.35, 1.15, c)));
  return out;
}

function pier(v) {
  const g = DIM.pier, out = [];
  for (const x of [-2.5, 0, 2.5]) out.push(at(box(0.32, 0.32, g.z + 0.1, 0, C.woodDark, 0), x, g.d / 2 - 0.25));
  out.push(box(g.w, g.d, 0.3, g.z, C.wood, 0));
  const top = g.z + 0.3;
  if (v === 'fishhut') {
    out.push(at(box(2.0, 1.7, 1.4, top, C.wood, 0), -1.7, 0.05), at(gable(2.6, 2.3, 1.0, top + 1.4, C.roofDark), -1.7, 0.05));
    out.push(at(box(0.1, 0.1, 2.3, top, C.woodDark, 0), 2.4, -0.5), at(box(0.7, 0.7, 0.5, top, C.wood, 0), 1.2, 0.2));
    out.push(at(box(1.9, 0.9, 0.4, 0.2, C.blue, 0), 1.6, 2.0), at(box(2.0, 1.0, 0.12, 0.55, C.white, 0), 1.6, 2.0));
  } else {
    out.push(at(box(0.18, 0.18, 2.0, top, C.woodDark, 0), -2.5, -0.6), ball(0.3, -2.5, -0.6, top + 2.1, C.lamp));
    out.push(at(box(0.9, 0.8, 0.7, top, C.wood, 0), 0.4, -0.2));
    out.push(at(box(2.6, 1.0, 0.45, 0.15, C.white, 0), 1.7, 1.9), at(box(2.7, 1.1, 0.14, 0.5, C.roof, 0), 1.7, 1.9), at(box(0.9, 0.8, 0.5, 0.64, C.wall, 0), 2.2, 1.9));
  }
  return out;
}

function flat(v) {
  const g = DIM.flat, { w, d, t } = g;
  const base = { plaza: C.plaza, farm: C.soil, field: C.lawn, garden: 0x6fae55 }[v];
  const out = [box(w, d, t, 0, base, 0)];
  if (v === 'plaza') {
    out.push(capCyl(8, 1.15, 0.45, t, C.stone), capCyl(8, 0.95, 0.06, t + 0.45, C.water), capCyl(5, 0.16, 1.0, t + 0.45, C.white), ball(0.26, 0, 0, t + 1.5, C.water));
    out.push(...tree(0.8, -2.4, -1.0), ...tree(0.7, 2.5, 0.6));
  } else if (v === 'farm') {
    [C.rowA, C.rowB, C.rowA, C.rowB].forEach((c, i) => out.push(at(box(3.3, 0.5, 0.22, t, c, 0), -0.9, -1.55 + i * 0.95)));
    out.push(at(box(1.5, 1.3, 1.0, t, C.wall, 0), 2.1, -0.8), at(gable(1.9, 1.7, 0.8, t + 1.0, C.roof), 2.1, -0.8));
  } else if (v === 'field') {
    const line = (lw, ld, x, y) => out.push(at(box(lw, ld, 0.05, t, C.white, 0), x, y));
    line(5.4, 0.12, 0, -1.7); line(5.4, 0.12, 0, 1.7); line(0.12, 3.4, -2.7, 0); line(0.12, 3.4, 2.7, 0); line(0.12, 3.4, 0, 0);
    for (const s of [-1, 1]) out.push(at(box(0.16, 1.2, 0.9, t, C.white, 0), s * 2.55, 0));
  } else {
    out.push(at(box(5.2, 0.7, 0.05, t, C.plaza, 0), 0, 0));
    for (const [x, y] of [[-2.0, -1.4], [2.0, -1.4], [-2.0, 1.4], [2.0, 1.4]]) out.push(at(box(1.9, 0.6, 0.5, t, C.hedge, 0), x, y));
    out.push(...tree(0.75, 0, -0.9));
    out.push(ball(0.2, -0.8, 0.9, t + 0.22, C.pink), ball(0.2, 0.2, 1.1, t + 0.22, C.gold), ball(0.2, 1.0, 0.8, t + 0.22, C.white));
  }
  return out;
}

function shop(v) {
  const g = DIM.shop, { w, d, h } = g, tea = v === 'teahouse';
  const out = [box(w, d, h, 0, C.wall, 0), gable(w + g.over, d + g.over, g.roofRise, h, tea ? C.roofDark : C.roof)];
  const col = tea ? [C.white, C.blue] : [C.roof, C.white];
  for (let i = 0; i < 4; i++) out.push(at(wedge(w / 4, 1.0, 0.55, 1.3, col[i % 2]), -w / 2 + w / 8 + (i * w) / 4, d / 2 + 0.5));
  out.push(patch(-1.2, d / 2, 0.7, 1.2, 0, C.woodDark));
  if (tea) {
    out.push(ball(0.34, 1.85, d / 2 + 0.25, 1.5, C.roof));
    out.push(at(box(0.08, 0.08, 0.4, 1.7, C.woodDark, 0), 1.85, d / 2 + 0.25));
  } else {
    out.push(at(box(0.7, 0.7, 2.0, 0, C.stoneDark, 0), 1.0, -0.6, h + 0.4), ...smokeBalls(1.0, -0.6, h + 2.9).slice(0, 1));
    out.push(ball(0.28, 1.2, d / 2 + 0.3, 0.9, C.bread), ball(0.25, 1.8, d / 2 + 0.3, 0.9, C.bread));
  }
  return out;
}

// ---------------------------------------------------------------- the entry points
const FORMS = { lighthouse, tower, dome, manor, workshop, clinic, greenhouse, windmill, market, pier, flat, shop };

/** The parts of a landmark: `type` and `variant` as buildings.js landmarkForm()
 * gives them. An unknown type becomes a manor. */
export function landmarkMesh(type, variant = '') {
  const fn = Object.hasOwn(FORMS, type) ? FORMS[type] : manor;
  return fn(variant);
}

/** { h, rr }: the height and a footprint radius, for the soft shadow. */
export function landmarkSize(type, variant = '') {
  let h = 0;
  let rr = 0;
  for (const p of landmarkMesh(type, variant)) {
    for (const t of p.tris) for (const [x, y, z] of t) { h = Math.max(h, z); rr = Math.max(rr, Math.hypot(x, y)); }
  }
  return { h, rr: rr * 0.8 };
}

// Pools of light for the night: [x, y, z, radius, strength, colour?] in world
// units (a lit window, a lamp). The old drawing lit the same places.
const LIT = {
  lighthouse: [[0, 0, 7.4, 3.4, 0.85, '#FFE27A']],
  'tower:clock': [[0, 1.4, 3.75, 1.9, 0.6]],
  'tower:watch': [[0, 1.0, 5.5, 1.6, 0.6]],
  'dome:observatory': [[0, 1.6, 3.4, 2.2, 0.55, '#CFE6FF']],
  'dome:music': [[0, 1.7, 1.0, 2.4, 0.55]],
  'manor:library': [[-1.9, 1.7, 1.5, 1.1, 0.5], [-1.0, 1.7, 1.5, 1.1, 0.5], [1.0, 1.7, 1.5, 1.1, 0.5], [1.9, 1.7, 1.5, 1.1, 0.5]],
  'manor:gallery': [[-1.8, 1.7, 1.4, 1.0, 0.5, '#FF9A8F'], [-0.95, 1.7, 1.4, 1.0, 0.5], [1.0, 1.7, 1.4, 1.0, 0.5], [1.85, 1.7, 1.4, 1.0, 0.5]],
  'manor:school': [[-1.7, 1.7, 1.4, 1.2, 0.55], [1.7, 1.7, 1.4, 1.2, 0.55]],
  'manor:theater': [[-1.7, 1.7, 1.4, 1.2, 0.55], [1.7, 1.7, 1.4, 1.2, 0.55]],
  'manor:default': [[-1.7, 1.7, 1.4, 1.2, 0.55], [1.7, 1.7, 1.4, 1.2, 0.55]],
  'workshop:workshop': [[-1.0, 1.6, 0.8, 1.5, 0.6, '#FF9A50']],
  'workshop:smithy': [[-1.0, 1.6, 0.8, 1.5, 0.6, '#FF9A50'], [1.0, 2.1, 0.8, 1.0, 0.6, '#FF9A50']],
  'clinic:lab': [[0.2, 1.7, 1.6, 1.2, 0.5, '#CFE6FF'], [1.4, 1.7, 1.6, 1.2, 0.5, '#CFE6FF']],
  'clinic:clinic': [[0.0, 1.7, 1.3, 1.2, 0.5], [2.0, 1.7, 1.3, 1.2, 0.5]],
  greenhouse: [[0, 0, 1.4, 3.0, 0.35, '#C9FFB8']],
  windmill: [[0, 1.4, 1.2, 1.3, 0.5]],
  market: [[0, 0.3, 1.2, 3.0, 0.35]],
  'pier:pier': [[-2.5, -0.6, 3.0, 2.2, 0.55]],
  'pier:fishhut': [[-1.7, 1.0, 1.7, 1.4, 0.6, '#FF9A50']],
  'flat:plaza': [[0, 0, 1.5, 3.0, 0.28]],
  'flat:farm': [[2.1, 0.1, 0.9, 1.3, 0.5]],
  'flat:field': [[0, 0, 0.6, 4.0, 0.2]],
  'flat:garden': [[0, 0, 0.7, 3.4, 0.25]],
  'shop:teahouse': [[1.85, 1.8, 1.5, 1.4, 0.6, '#FF8A8F']],
  'shop:bakery': [[0, 1.6, 1.0, 2.0, 0.55, '#FF9A8F']],
};

/** The night's pools of light of a landmark, in the picture's own units (as
 * facesOf() gives them): [{ x, y, r, a, color? }]. */
export function landmarkLights(type, variant = '') {
  const list = LIT[`${type}:${variant}`] || LIT[type] || [];
  return list.map(([x, y, z, r, a, color]) => {
    const [px, py] = project(x, y, z);
    return color ? { x: px, y: py, r, a, color } : { x: px, y: py, r, a };
  });
}
