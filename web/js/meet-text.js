// Words for what changed on the map while you were away. (The lines that said
// why a person was suggested went with 似ている人 and 人の札.) Pure functions,
// no imports, so node can test them.

// 「キャンプ」 -> 「キャンプ村」; a name kept from the many-islands map (「キャンプ島」, 「キャンプ大陸」)
// becomes 「キャンプ村」 too (the same rule as notify-rules.js villageName).
function villageName(name) {
  let text = String(name);
  const old = ['大陸', '島'].find((end) => text.endsWith(end) && text.length > end.length);
  if (old) text = text.slice(0, -old.length);
  return text.endsWith('村') ? text : `${text}村`;
}

const REASON_TAGS = { mine: 'あなたの村', connected: 'つながりの人の村', big: '大きな変化' };

/** 「焚き火 / 山」 -> 「焚き火村」. A name that already ends in 村 stays as it is. */
export function islandLabel(counts) {
  const name = String(counts?.name || '').split('/')[0].trim();
  if (!name) return '';
  return villageName(name);
}

/** 「みおさん」, 「みおさんとけんたさん」, 「みおさんたち3人」. */
export function namesOf(people) {
  const names = (people || []).map((person) => person.display_name).filter(Boolean)
    .map((name) => `${name}さん`);
  if (names.length <= 2) return names.join('と');
  return `${names[0]}たち${names.length}人`;
}

/** Who was behind a change, or '' when nobody is named. */
export function peopleSentence(people, role) {
  const names = namesOf(people);
  if (!names) return '';
  return role === 'posts' ? `${names}が投稿しています。` : `${names}のやりとりがきっかけです。`;
}

export function digestLabel(count) {
  return `前回から ${count}件の変化`;
}

// The changes not looked at yet stay on this device until they are (2026-11-07, the user: opening the page
// again moved 前回 on, and what was not looked at was gone): at most KEPT_MAX, none older than KEPT_DAYS
// (as far back as a first digest reaches).
export const KEPT_MAX = 60;
export const KEPT_DAYS = 14;

/** The digest to show: the new rows first, then the kept ones, each once and none too old. */
export function mergeKept(fresh, kept, now = Date.now()) {
  const floor = now - KEPT_DAYS * 864e5;
  const ids = new Set();
  const out = [];
  [...(Array.isArray(fresh) ? fresh : []), ...(Array.isArray(kept) ? kept : [])].forEach((change) => {
    if (!change || !change.id || ids.has(change.id)) return;
    const at = Date.parse(change.created_at);
    if (Number.isFinite(at) && at < floor) return;
    ids.add(change.id);
    out.push(change);
  });
  return out;
}

/** What to keep for next time: the rows not looked at yet. */
export function keptOf(changes, seen) {
  return (changes || []).filter((change) => !seen.has(change.id)).slice(0, KEPT_MAX);
}

function joinIslands(labels) {
  if (labels.length <= 2) return labels.join('と');
  return `${labels[0]}など${labels.length}つの村`;
}

/**
 * One away-digest row (an island_events row from /api/changes/digest) in words.
 * nameAt(place) gives the label of the island standing at {cx, cy} today, for
 * the kinds of change whose row carries no name.
 * Returns {tag, text, people, numbers}; people and numbers may be ''.
 */
export function describeChange(change, { nameAt = () => '' } = {}) {
  const before = change?.before || {};
  const after = change?.after || {};
  const here = islandLabel(after) || islandLabel(before) || nameAt(change?.place) || 'ある村';
  let text = '';
  let numbers = '';
  switch (change?.kind) {
    case 'merge': {
      const parts = (before.islands || []).map(islandLabel).filter(Boolean);
      const unique = [...new Set(parts)];
      text = unique.length >= 2 ? `${joinIslands(unique)}が合流しました。` : `${here}に村が合流しました。`;
      const first = (before.islands || [])[0];
      if (first && after.people != null) numbers = `人数 ${first.people}→${after.people}人`;
      break;
    }
    case 'split': {
      const pieces = (after.islands || []).map(islandLabel).filter(Boolean);
      const unique = [...new Set(pieces)];
      text = unique.length >= 2 ? `${islandLabel(before) || here}が${joinIslands(unique)}に分かれました。`
        : `${islandLabel(before) || here}が分かれました。`;
      if (before.posts != null && after.islands?.length) {
        numbers = `投稿 ${before.posts}件→${after.islands.map((piece) => `${piece.posts}件`).join('・')}`;
      }
      break;
    }
    case 'birth':
      text = `${here}が生まれました。`;
      if (after.posts != null) numbers = `投稿 ${after.posts}件・${after.people}人`;
      break;
    case 'rename': {
      const was = islandLabel({ name: before.name });
      const now = islandLabel({ name: after.name });
      text = was && now && was !== now ? `${was}が${now}になりました。` : `${here}の名前が変わりました。`;
      break;
    }
    case 'tier':
      text = (after.tier || 0) > (before.tier || 0)
        ? `${here}がにぎやかになりました。`
        : `${here}が少し静かになりました。`;
      break;
    case 'landmark':
      text = before.landmark
        ? `${here}の目印が「${before.landmark}」から「${after.landmark}」に変わりました。`
        : `${here}に目印「${after.landmark}」ができました。`;
      break;
    case 'quiet':
      text = after.posts === 0 ? `${islandLabel(before) || here}がなくなりました。` : `${here}がしばらく静かです。`;
      break;
    default:
      text = `${here}が変わりました。`;
  }
  return {
    tag: REASON_TAGS[change?.reason] || '',
    text,
    people: peopleSentence(change?.people, change?.people_role),
    numbers,
  };
}
