// Making a photo small enough to send, in the browser.
//
// A phone photo is ~4MB and 4032px on its long edge. It is by a wide margin
// the biggest thing this app would ever move, and nothing that displays it -
// a card in a bottom sheet, a 78px avatar - has any use for that. Shrinking
// here rather than on the server means the bytes are never sent at all.
//
// Shared by the post composer and the two profile screens, which want very
// different sizes out of the same routine.

/** A post's attachment: big enough to look at, small enough to be free. */
export const POST_IMAGE = { maxEdge: 1280, targetBytes: 500 * 1024 };

/** An avatar: drawn at 78px at most, so anything past 256 is thrown away. */
export const AVATAR_IMAGE = { maxEdge: 256, targetBytes: 120 * 1024 };

/** The bucket refuses anything bigger (file_size_limit in supabase/schema.sql). */
export const UPLOAD_LIMIT_BYTES = 1024 * 1024;

const QUALITIES = [0.82, 0.7, 0.58, 0.45];

// WebP first; JPEG where the browser cannot write WebP. Safari (iOS included,
// up to 26 at least) has no WebP encoder and quietly hands back a PNG, which
// ignores the quality and runs to 2-3MB for a 1280px photo - past the bucket's
// limit, so every photo from an iPhone was refused.
const FORMATS = ['image/webp', 'image/jpeg'];

// When even the lowest quality is too big, the picture is drawn smaller.
const SHRINK = [1, 0.75, 0.5];

const TOO_BIG = '画像を小さくできませんでした。別の画像をお試しください。';

const encode = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

function draw(source, width, height, background) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // iOS answers null once its canvas memory runs out; without this the person would read a TypeError.
  if (!ctx) throw new Error(TOO_BIG);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

/**
 * The first blob within `targetBytes`, else the smallest within the upload limit, else null.
 * A format the browser turns out not to write is taken out of `formats`, so a smaller
 * attempt does not make Safari write a useless 3MB PNG again.
 */
async function encodeWithin(source, width, height, targetBytes, formats) {
  for (const type of [...formats]) {
    // JPEG has no transparency: a see-through PNG would turn black, so it goes on white.
    const canvas = draw(source, width, height, type === 'image/jpeg' ? '#fff' : null);
    let smallest = null;
    try {
      for (const quality of QUALITIES) {
        const blob = await encode(canvas, type, quality);
        if (!blob || blob.type !== type) {   // this browser cannot write this format
          formats.splice(formats.indexOf(type), 1);
          break;
        }
        if (blob.size <= targetBytes) return blob;
        if (!smallest || blob.size < smallest.size) smallest = blob;
      }
    } finally {
      // Hand the pixels back now: iOS caps the memory all canvases may hold together.
      canvas.width = 0;
      canvas.height = 0;
    }
    if (smallest && smallest.size <= UPLOAD_LIMIT_BYTES) return smallest;
  }
  return null;
}

/**
 * Shrink and re-encode (WebP, or JPEG where WebP cannot be written), stepping the
 * quality and then the size down until it fits.
 *
 * @param file    a File or Blob from an <input type="file">
 * @param limits  { maxEdge, targetBytes } - POST_IMAGE or AVATAR_IMAGE
 * @returns a WebP or JPEG Blob, never over UPLOAD_LIMIT_BYTES
 */
export async function prepareImage(file, limits = POST_IMAGE) {
  const { maxEdge, targetBytes } = { ...POST_IMAGE, ...limits };
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // A file that is not a picture (or one the browser cannot decode).
    throw new Error('画像を読み込めませんでした。別の画像をお試しください。');
  }
  try {
    const fit = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const formats = [...FORMATS];
    for (const step of SHRINK) {
      const width = Math.max(1, Math.round(bitmap.width * fit * step));
      const height = Math.max(1, Math.round(bitmap.height * fit * step));
      const blob = await encodeWithin(bitmap, width, height, targetBytes, formats);
      if (blob) return blob;
    }
  } finally {
    bitmap.close?.();
  }
  throw new Error(TOO_BIG);
}

/** The file name ending for a prepared image, so the stored name says what it is. */
export function imageExtension(type) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png' }[type] || 'webp';
}
