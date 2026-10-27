// Draw the app icon (an island shaped like a speech bubble) and write every PNG the app names:
// apple-touch-icon (iPhone), icon-192/512 (installed app, notifications), maskable-512 (Android,
// cut to any shape), badge-96 (Android status bar). Prints the favicon for the three pages.
//
//   node scripts/app_icons.mjs            (Playwright's Chromium, or Chrome if that is missing)
//
// The bubble's oval sits exactly in the middle; only its tail reaches toward the bottom left.
// Everything stays inside 200px of the centre, within the maskable safe circle (40% = 204.8px),
// so a round launcher never cuts it. iPhone does not cut a circle, so its icons are drawn 8% larger.
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const OUT = new URL('../web/img/icons/', import.meta.url);
const SEA = '#46AEE6', SAND = '#F2DCA0', GRASS = '#94C973', FOREST = '#5FAE6A';
const RX = 184, RY = 140, LIMIT = 200, TAIL_ROUND = 14, IOS_SCALE = 1.08;
const WOB = [1.0, 1.05, 0.97, 1.03, 0.95, 1.04, 0.98, 1.06, 0.94, 1.02];

const f1 = (v) => +v.toFixed(1);
// Closed Catmull-Rom curve through the points.
function smooth(pts) {
  const n = pts.length, at = (p) => `${f1(p[0])},${f1(p[1])}`;
  let d = `M${at(pts[0])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [-1, 0, 1, 2].map((k) => pts[(i + k + n) % n]);
    d += `C${at([p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6])} `
      + `${at([p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6])} ${at(p2)}`;
  }
  return d + 'Z';
}
// An oval pushed in and out by `wob`, one factor per point, so it reads as a coastline.
function oval(cx, cy, rx, ry, wob, rot = 0) {
  return smooth(wob.map((k, i) => {
    const a = rot + (i / wob.length) * Math.PI * 2;
    return [cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k];
  }));
}
const deg = (d) => (d * Math.PI) / 180;
const onOval = (d, k) => [256 + Math.cos(deg(d)) * RX * k, 256 + Math.sin(deg(d)) * RY * k];
const polar = (d, r) => [256 + Math.cos(deg(d)) * r, 256 + Math.sin(deg(d)) * r];

// The beach is a plain oval; the grass and the hill sit a little higher, like a mound.
const fx = RX / 200, fy = RY / 152;
const grass = oval(256 + 6 * fx, 256 - 16 * fy, 144 * fx, 106 * fy, WOB, 0.2);
const hill = oval(256 + 12 * fx, 256 - 30 * fy, 78 * fx, 56 * fy, WOB, 0.2);
const tailPts = [onOval(140, 0.9), polar(133, LIMIT - TAIL_ROUND / 2), onOval(112, 0.9)];
const tail = 'M' + tailPts.map((p) => p.map(f1).join(',')).join('L') + 'Z';

const scaled = (s, body) => (s === 1 ? body : `<g transform="translate(256 256) scale(${s}) translate(-256 -256)">${body}</g>`);
const bubble = (fill) => `<path fill="${fill}" stroke="${fill}" stroke-width="${TAIL_ROUND}" stroke-linejoin="round" d="${tail}"/>`
  + `<ellipse fill="${fill}" cx="256" cy="256" rx="${RX}" ry="${RY}"/>`;
const island = bubble(SAND) + `<path fill="${GRASS}" d="${grass}"/><path fill="${FOREST}" d="${hill}"/>`;
const svg = (body, bg = SEA) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`
  + (bg ? `<rect width="512" height="512" fill="${bg}"/>` : '') + body + '</svg>';

// Android's badge only keeps the alpha: the bubble alone, filled. (Cutting the grass out of it
// left a ring around a dot, which reads as an eye at status-bar size.)
const badge = svg(scaled(1.2, bubble('#fff')), null);

const icons = [
  // name, size, svg, corner radius (transparent outside), as share of the side
  ['apple-touch-icon.png', 180, svg(scaled(IOS_SCALE, island)), 0],
  ['icon-192.png', 192, svg(scaled(IOS_SCALE, island)), 0.224],
  ['icon-512.png', 512, svg(scaled(IOS_SCALE, island)), 0.224],
  ['maskable-512.png', 512, svg(island), 0],
  ['badge-96.png', 96, badge, 0],
];

let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: 'chrome' }); }
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [name, size, art, corner] of icons) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">`
    + `<div style="width:${size}px;height:${size}px;overflow:hidden;border-radius:${corner * 100}%">`
    + art.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `) + '</div></body></html>');
  await writeFile(new URL(name, OUT), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  console.log('wrote', name);
}
await browser.close();

// The favicon: the same island, a bit larger on a rounded square.
const tiny = svg(scaled(1.12, island)).replace('<rect width="512" height="512"', '<rect width="512" height="512" rx="112"')
  .replace(/"/g, "'").replace(/#/g, '%23');
console.log('\nfavicon:\n<link rel="icon" href="data:image/svg+xml,' + tiny + '">');
