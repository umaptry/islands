// The rules behind the 「新しい住人」 catch-up, kept free of the page so they can be
// tested: which unread rows are shown, in what order, how many, when it may
// open, and what a swipe or a key means. Self-contained on purpose (the tests
// load this file alone).

/** The most cards one catch-up shows (the newest ones). */
export const MAX_CARDS = 10;
/** How far a finger must travel before it counts as a swipe, in px. */
export const SWIPE_PX = 48;

const idsOf = (row) => (Array.isArray(row.ids) && row.ids.length ? row.ids : [row.id]);

/** A 「新しい住人」 row: type island, payload.kind resident. */
export const isResidentRow = (row) => Boolean(row) && row.type === 'island'
  && Boolean(row.payload) && row.payload.kind === 'resident';

const timeOf = (row) => {
  const time = Date.parse(row.created_at);
  return Number.isFinite(time) ? time : 0;
};

/**
 * The rows to show, oldest first. Unread residents with a post, in the community on the map (every community
 * when communities are off), that this page has not shown yet; when there are more than `max`, the newest `max`.
 *
 * @param rows        the notification list
 * @param options     communitiesOn: whether the map is split into communities; communityId: the one on the map;
 *                    shown: a Set of row ids already shown (or closed) in this page; max
 */
export function pickCatchup(rows, { communitiesOn = false, communityId = null, shown = new Set(), max = MAX_CARDS } = {}) {
  const found = (rows || []).filter((row) => isResidentRow(row) && row.unread && row.post_id
    && (!communitiesOn || (Boolean(communityId) && row.community_id === communityId))
    && !idsOf(row).some((id) => shown.has(id)));
  const newest = found.sort((a, b) => timeOf(b) - timeOf(a)).slice(0, Math.max(0, max));
  return newest.reverse();
}

/**
 * Whether the catch-up may open now. It never opens over something else: a sheet, an island card, a guidance
 * not finished, another catch-up, or a hidden page. It is simply tried again the next time the map shows.
 */
export function canOpenCatchup({
  signedIn = false, screen = '', sheetOpen = false, cardOpen = false, onboarding = null,
  active = false, visible = true,
} = {}) {
  return signedIn && screen === 'map' && !sheetOpen && !cardOpen && !onboarding && !active && visible;
}

/** The first line of a card. The sentence adds 「さん」, so a name that already ends in it is trimmed first
 * (as app.py's _plain_name does for the push): never 「はなさんさん」. */
export function slideTitle(name, island) {
  const text = String(name || '').trim();
  const plain = text.endsWith('さん') && text.length > 2 ? text.slice(0, -2) : text;
  return `${plain || 'だれか'}さんが${island || 'この島'}の住人になりました`;
}

/** 「1 / 3」. */
export const stepText = (index, total) => `${index + 1} / ${total}`;

/** A swipe to the left or upward goes on; anything shorter than SWIPE_PX is a tap. */
export function swipeAction(dx, dy, threshold = SWIPE_PX) {
  const across = Math.abs(dx);
  const along = Math.abs(dy);
  if (dx < 0 && across >= threshold && across >= along) return 'next';
  if (dy < 0 && along >= threshold && along > across) return 'next';
  return null;
}

/** Arrow keys and Escape: 'next' | 'prev' | 'close' | null. */
export function keyAction(key) {
  if (key === 'ArrowRight') return 'next';
  if (key === 'ArrowLeft') return 'prev';
  if (key === 'Escape') return 'close';
  return null;
}

/** Where to go from `index`: the next card, the one before, or 'done' after the last. */
export function stepTo(index, total, action) {
  if (action === 'prev') return Math.max(0, index - 1);
  if (action === 'next') return index + 1 >= total ? 'done' : index + 1;
  return index;
}

/** The ids of every row of the cards (a grouped row holds several). */
export const rowIdsOf = (rows) => (rows || []).flatMap(idsOf);
