import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// qr.js imports the vendored library by a relative path; point it at a data: URL so it loads here.
const vendor = await readFile(new URL('../../web/js/vendor/qrcode.js', import.meta.url), 'utf8');
const vendorUrl = `data:text/javascript;base64,${Buffer.from(vendor).toString('base64')}`;
const source = (await readFile(new URL('../../web/js/qr.js', import.meta.url), 'utf8')).replace("'./vendor/qrcode.js'", `'${vendorUrl}'`);
const qr = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const CODE = 'Xk3v9QpL2mZr8TnA5bYc7WdE';
const POST = '6f1c1b0e-5a53-4a43-9a52-3b8f0c2d9e11';
const plain = `https://islands-map.example.com/#/invite/${CODE}`;
const withPost = `${plain}?post=${POST}`;

test('the vendored library keeps its MIT header and is an ES module', () => {
  assert.match(vendor, /Licensed under the MIT license/);
  assert.match(vendor, /Kazuhiko Arase/);
  assert.match(vendor, /export default qrcode;/);
  assert.doesNotMatch(vendor, /module\.exports|define\(/);
});

test('a link becomes a square grid with the three finder squares', () => {
  const matrix = qr.qrMatrix(plain);
  assert.equal(matrix.rows.length, matrix.size);
  assert.ok(matrix.rows.every((row) => row.length === matrix.size));
  assert.equal((matrix.size - 17) % 4, 0);          // 21, 25, 29 ... (version * 4 + 17)
  // The corner of each finder pattern is dark: top-left, top-right, bottom-left.
  const last = matrix.size - 1;
  assert.ok(matrix.rows[0][0] && matrix.rows[0][last] && matrix.rows[last][0]);
});

test('error correction M: a damaged-but-readable level costs bigger grids than L would', () => {
  const m = qr.qrMatrix(withPost).size;
  assert.ok(m >= 37 && m <= 49, `size ${m}`);
});

test('modules stay big enough to read: at 224px a phone camera still gets 4px or more per module', () => {
  for (const url of [plain, withPost]) {
    const total = qr.qrModules(qr.qrMatrix(url));
    assert.ok(224 / total >= 4, `${url.length} chars -> ${total} modules -> ${(224 / total).toFixed(2)}px`);
  }
});

test('the SVG path has one square per dark module, inside the quiet zone', () => {
  const matrix = qr.qrMatrix(plain);
  const dark = matrix.rows.flat().filter(Boolean).length;
  const path = qr.qrPathData(matrix);
  assert.equal((path.match(/z/g) || []).length, dark);
  assert.equal(qr.qrModules(matrix), matrix.size + 8);
  assert.ok(path.startsWith(`M${qr.QUIET} ${qr.QUIET}h1v1h-1z`));
});
