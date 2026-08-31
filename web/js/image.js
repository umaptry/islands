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

const QUALITIES = [0.82, 0.7, 0.58, 0.45];

/**
 * Shrink and re-encode to WebP, stepping the quality down until it fits.
 *
 * @param file    a File or Blob from an <input type="file">
 * @param limits  { maxEdge, targetBytes } - POST_IMAGE or AVATAR_IMAGE
 * @returns a Blob, never larger than the source
 */
export async function prepareImage(file, limits = POST_IMAGE) {
  const { maxEdge, targetBytes } = { ...POST_IMAGE, ...limits };
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  for (const quality of QUALITIES) {
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/webp', quality));
    // Safari below 14 has no WebP encoder and hands back a PNG; that still
    // uploads, it is just larger, so the last pass settles for it.
    if (blob && blob.size <= targetBytes) return blob;
    if (blob && quality === QUALITIES[QUALITIES.length - 1]) return blob;
  }
  throw new Error('画像を小さくできませんでした。別の画像をお試しください。');
}
