// Which posts this device has opened.
//
// The gold star pin on a 「参加者募集中」 post means "you have not looked at this
// yet". That is a fact about one device, not about the account, so it lives in
// localStorage and goes away the moment the post is opened. A private window or
// blocked storage only means the stars come back next visit.

export const RECRUIT_TAG = '参加者募集中';

const KEY = 'islands.readPosts';
const KEEP = 400;

let read = null;

function load() {
  if (read) return read;
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    read = new Set(Array.isArray(list) ? list : []);
  } catch {
    read = new Set();
  }
  return read;
}

export function hasRead(postId) {
  return load().has(postId);
}

export function markRead(postId) {
  if (!postId || load().has(postId)) return;
  read.add(postId);
  try {
    localStorage.setItem(KEY, JSON.stringify([...read].slice(-KEEP)));
  } catch {
    /* the star comes back next visit; nothing worse */
  }
}

/** Whether the post asks for participants. */
export function isRecruiting(post) {
  return Boolean(post) && Array.isArray(post.tags) && post.tags.includes(RECRUIT_TAG);
}

/** A recruiting post of somebody else's that this device has not opened. */
export function isUnreadRecruit(post, meId) {
  return isRecruiting(post) && post.author_id !== meId && !hasRead(post.id);
}
