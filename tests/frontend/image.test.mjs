import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

// No package.json "type" in this folder: load the module as a data: URL like the other tests.
const source = await readFile(new URL('../../web/js/image.js', import.meta.url), 'utf8');
const { AVATAR_IMAGE, POST_IMAGE, UPLOAD_LIMIT_BYTES, imageExtension, prepareImage } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// A stand-in browser. `encoder(type, quality, pixels)` answers what toBlob would
// hand back: { type, size } - or null, as toBlob does when it gives up.
// Returns what was drawn ({ width, height, background }) and what was asked of toBlob.
function browser(encoder, { context = true } = {}) {
  const drawn = [];
  const asked = [];
  globalThis.createImageBitmap = async (file) => {
    if (!file.picture) throw new Error('not a picture');
    return { width: file.picture.width, height: file.picture.height, close() { file.closed = true; } };
  };
  globalThis.document = {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        background: null,
        getContext: () => context && {
          fillRect() { canvas.background = this.fillStyle; },
          drawImage() { drawn.push({ width: canvas.width, height: canvas.height, background: canvas.background }); },
        },
        toBlob(resolve, type, quality) {
          asked.push(type);
          const out = encoder(type, quality, canvas.width * canvas.height);
          resolve(out && new Blob([new Uint8Array(Math.round(out.size))], { type: out.type }));
        },
      };
      return canvas;
    },
  };
  return Object.assign(drawn, { asked });
}

const photo = (width, height) => ({ picture: { width, height } });

// What Chrome and Android do: WebP and JPEG, both shrinking with the quality.
const chrome = (type, quality, pixels) => {
  if (type === 'image/webp') return { type, size: pixels * quality * 0.3 };
  if (type === 'image/jpeg') return { type, size: pixels * quality * 0.5 };
  return { type: 'image/png', size: pixels * 2.5 };
};

// What Safari does (iOS 26 included): asked for WebP it quietly writes a PNG,
// with no quality - a 1280x960 photo comes to about 3MB.
const safari = (type, quality, pixels) => {
  if (type === 'image/jpeg') return { type, size: pixels * quality * 0.5 };
  return { type: 'image/png', size: pixels * 2.5 };
};

test('Chrome: a phone photo comes out as WebP, 1280px on the long edge', async () => {
  const drawn = browser(chrome);
  const blob = await prepareImage(photo(4032, 3024), POST_IMAGE);
  assert.equal(blob.type, 'image/webp');
  assert.ok(blob.size <= POST_IMAGE.targetBytes);
  assert.deepEqual([drawn[0].width, drawn[0].height], [1280, 960]);
});

test('Safari (no WebP encoder): a phone photo comes out as JPEG within the target, not a 3MB PNG', async () => {
  const drawn = browser(safari);
  const blob = await prepareImage(photo(4032, 3024), POST_IMAGE);
  assert.equal(blob.type, 'image/jpeg');
  assert.ok(blob.size <= POST_IMAGE.targetBytes, `${blob.size} bytes`);
  const last = drawn[drawn.length - 1];
  assert.deepEqual([last.width, last.height], [1280, 960]);
  // JPEG has no transparency: it is drawn on white so a see-through PNG does not turn black.
  assert.equal(last.background, '#fff');
});

test('the WebP pass keeps transparency (no background is painted)', async () => {
  const drawn = browser(chrome);
  await prepareImage(photo(800, 600), POST_IMAGE);
  assert.equal(drawn[0].background, null);
});

test('past the target but within the upload limit: the smallest one is sent as is', async () => {
  // Even the lowest quality is ~700KB at 1280x960: above 500KB, under 1MB.
  browser((type, quality, pixels) => (type === 'image/webp' ? { type, size: pixels * 0.55 + quality } : null));
  const blob = await prepareImage(photo(4032, 3024), POST_IMAGE);
  assert.equal(blob.type, 'image/webp');
  assert.ok(blob.size > POST_IMAGE.targetBytes && blob.size <= UPLOAD_LIMIT_BYTES);
  assert.equal(Math.round(blob.size), Math.round(1280 * 960 * 0.55 + 0.45));
});

test('too big at every quality: the picture is drawn smaller rather than sent over 1MB', async () => {
  // A busy picture: about 1.2 bytes a pixel whatever the quality - 1.5MB at 1280x960.
  const drawn = browser((type, quality, pixels) => (type === 'image/jpeg' ? { type, size: pixels * 1.2 } : { type: 'image/png', size: pixels * 3 }));
  const blob = await prepareImage(photo(4032, 3024), POST_IMAGE);
  assert.equal(blob.type, 'image/jpeg');
  assert.ok(blob.size <= UPLOAD_LIMIT_BYTES, `${blob.size} bytes`);
  const last = drawn[drawn.length - 1];
  assert.deepEqual([last.width, last.height], [960, 720]);
});

test('Safari is asked for WebP once, not again at every smaller size', async () => {
  const drawn = browser((type, quality, pixels) => (type === 'image/jpeg' ? { type, size: pixels * 1.2 } : { type: 'image/png', size: pixels * 3 }));
  await prepareImage(photo(4032, 3024), POST_IMAGE);
  assert.equal(drawn.asked.filter((type) => type === 'image/webp').length, 1);
});

test('out of canvas memory (iOS answers null for the context): a Japanese message, not a TypeError', async () => {
  browser(chrome, { context: false });
  const file = photo(4032, 3024);
  await assert.rejects(prepareImage(file, POST_IMAGE),
    { message: '画像を小さくできませんでした。別の画像をお試しください。' });
  assert.equal(file.closed, true);
});

test('nothing ever fits: a clear message instead of a doomed upload', async () => {
  browser((type, quality, pixels) => ({ type, size: UPLOAD_LIMIT_BYTES + pixels }));
  await assert.rejects(prepareImage(photo(4032, 3024), POST_IMAGE),
    { message: '画像を小さくできませんでした。別の画像をお試しください。' });
});

test('an encoder that gives up (null) is passed over for the next format', async () => {
  browser((type, quality, pixels) => (type === 'image/jpeg' ? { type, size: pixels * quality * 0.5 } : null));
  const blob = await prepareImage(photo(1000, 1000), POST_IMAGE);
  assert.equal(blob.type, 'image/jpeg');
});

test('an avatar on Safari: 256px JPEG', async () => {
  const drawn = browser(safari);
  const blob = await prepareImage(photo(3024, 4032), AVATAR_IMAGE);
  assert.equal(blob.type, 'image/jpeg');
  assert.ok(blob.size <= AVATAR_IMAGE.targetBytes);
  const last = drawn[drawn.length - 1];
  assert.deepEqual([last.width, last.height], [192, 256]);
});

test('a small picture is not blown up', async () => {
  const drawn = browser(chrome);
  await prepareImage(photo(300, 200), POST_IMAGE);
  assert.deepEqual([drawn[0].width, drawn[0].height], [300, 200]);
});

test('a file that is not a picture says so', async () => {
  browser(chrome);
  await assert.rejects(prepareImage({}, POST_IMAGE),
    { message: '画像を読み込めませんでした。別の画像をお試しください。' });
});

test('the stored name ends in what the file is', () => {
  assert.equal(imageExtension('image/webp'), 'webp');
  assert.equal(imageExtension('image/jpeg'), 'jpg');
  assert.equal(imageExtension('image/png'), 'png');
  assert.equal(imageExtension(''), 'webp');
});

test('the upload limit here is the bucket limit in the schema', async () => {
  const schema = await readFile(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');
  const bucket = schema.match(/values \('post-images', 'post-images', true, (\d+),/);
  assert.ok(bucket, 'post-images bucket not found in schema.sql');
  assert.equal(Number(bucket[1]), UPLOAD_LIMIT_BYTES);
});
