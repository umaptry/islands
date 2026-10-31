// The rules behind the notice band (規約・ポリシー改定のお知らせ), kept free of the page so they
// can be tested: whether the band shows, which link it may carry, and the "closed already"
// memory in localStorage (which may not exist, so every touch is guarded).

export const DISMISSED_KEY = 'islands.notice.dismissed';

/** A notice from /api/config, or null when it is missing or malformed. The link must stay on this site. */
export function readNotice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, text, url } = raw;
  if (typeof id !== 'string' || !id || typeof text !== 'string' || !text.trim()) return null;
  const sameSite = typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');
  return { id, text: text.trim(), url: sameSite ? url : null };
}

/**
 * Whether the band shows right now.
 * `chrome` is true on the everyday screens (the ones with the bottom nav); a sign-in, first profile
 * or guidance in progress is false. `dismissedId` is the id the person closed last (or '' / null).
 * `closedNow` is the id closed during this visit, for when localStorage cannot remember.
 */
export function shouldShowNotice({ notice, signedIn, chrome, dismissedId = '', closedNow = '' }) {
  const found = readNotice(notice);
  if (!found || !signedIn || !chrome) return false;
  return found.id !== dismissedId && found.id !== closedNow;
}

/** The id remembered as closed; '' when nothing is stored or storage is unusable. */
export function readDismissed(storage) {
  try {
    return storage?.getItem(DISMISSED_KEY) || '';
  } catch {
    return '';
  }
}

/** Remember that this id was closed. Returns whether it was stored (false: only this visit forgets it). */
export function writeDismissed(storage, id) {
  try {
    if (!storage) return false;
    storage.setItem(DISMISSED_KEY, String(id));
    return true;
  } catch {
    return false;
  }
}
