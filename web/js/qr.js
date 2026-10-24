// QR codes for invite links, made in the browser (nothing is sent anywhere, no CDN).
// The maths is the vendored qrcode-generator (MIT); this file only draws it:
//   qrSvg   a crisp <svg> for the screen (always black on white, with the quiet zone)
//   qrPng   a PNG blob: the QR with what it is and until when printed under it
// Error correction is M (about 15% can be damaged); the quiet zone is the 4 modules the spec asks for.

import qrcode from './vendor/qrcode.js';

export const QUIET = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The dark/light grid of a text. The smallest version that fits is chosen. */
export function qrMatrix(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  const size = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < size; r += 1) {
    const row = [];
    for (let c = 0; c < size; c += 1) row.push(qr.isDark(r, c));
    rows.push(row);
  }
  return { size, rows };
}

/** One path of 1x1 squares; the viewBox includes the quiet zone, so the white margin is part of it. */
export function qrPathData(matrix) {
  let path = '';
  matrix.rows.forEach((row, r) => row.forEach((dark, c) => {
    if (dark) path += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
  }));
  return path;
}

/** Width of the whole picture in modules (QR + both quiet zones). */
export const qrModules = (matrix) => matrix.size + QUIET * 2;

export function qrSvg(text, label = '招待の QR コード') {
  const matrix = qrMatrix(text);
  const total = qrModules(matrix);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', 'invite-qr-svg');
  svg.dataset.modules = String(total);
  const back = document.createElementNS(SVG_NS, 'rect');
  back.setAttribute('width', String(total));
  back.setAttribute('height', String(total));
  back.setAttribute('fill', '#fff');
  const dots = document.createElementNS(SVG_NS, 'path');
  dots.setAttribute('d', qrPathData(matrix));
  dots.setAttribute('fill', '#000');
  svg.append(back, dots);
  return svg;
}

/** The title is shrunk (then cut) so a long name still fits the picture's width. */
function fitText(ctx, text, maxWidth, size, min, weight) {
  let px = size;
  ctx.font = `${weight} ${px}px "Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif`;
  while (ctx.measureText(text).width > maxWidth && px > min) {
    px -= 2;
    ctx.font = `${weight} ${px}px "Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif`;
  }
  let out = text;
  while (ctx.measureText(out).width > maxWidth && out.length > 1) out = `${out.slice(0, -2)}…`;
  return out;
}

/** The PNG to save or print. Resolves to a Blob, or null when the canvas cannot make one. */
export function qrPng(text, lines) {
  const matrix = qrMatrix(text);
  const total = qrModules(matrix);
  const scale = Math.max(1, Math.floor(640 / total));
  const side = scale * total;
  const width = 800;
  const top = 48;
  const height = top + side + 190;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  const left = Math.round((width - side) / 2);
  ctx.fillStyle = '#000';
  matrix.rows.forEach((row, r) => row.forEach((dark, c) => {
    if (dark) ctx.fillRect(left + (c + QUIET) * scale, top + (r + QUIET) * scale, scale, scale);
  }));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#111';
  const y = top + side + 60;
  ctx.fillText(fitText(ctx, lines.title, 720, 44, 24, 700), width / 2, y);
  ctx.fillStyle = '#444';
  ctx.fillText(fitText(ctx, lines.until, 720, 34, 22, 400), width / 2, y + 62);
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob || null), 'image/png');
    } catch {
      resolve(null);
    }
  });
}
