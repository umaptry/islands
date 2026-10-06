// Words for meeting people: why a suggested person is shown, and what changed
// on the map while you were away. Pure functions, no imports, so node can test them.

const CONTINENT_MIN_POSTS = 50; // core/config.py CONTINENT_MIN_POSTS

const REASON_TAGS = { mine: 'あなたの島', connected: 'つながりの人の島', big: '大きな変化' };

/** 「焚き火 / 山」 with 12 posts -> 「焚き火島」, as core/energy.py labels the map. */
export function islandLabel(counts) {
  const name = String(counts?.name || '').split('/')[0].trim();
  if (!name) return '';
  return `${name}${(counts.posts || 0) >= CONTINENT_MIN_POSTS ? '大陸' : '島'}`;
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

/** The one-line reason a suggested person is shown (Q15). */
export function reasonLine(person) {
  const reason = person?.reasons?.[0]?.text;
  if (reason) return reason;
  return typeof person?.score === 'number' ? `似ている度 ${Math.round(person.score * 100)}%` : '';
}

const ORBIT_TAGS = {
  seeking: '頼れそう', offering: '力になれそう', goal: '目標が近い', posts: '投稿が近い', island: '同じ島',
};

/**
 * The few words on the dotted line in 「まわりの人」: the most telling reason,
 * shortened. Being on the same island says little there, so it comes last;
 * a weak reason ("少し近い") gets no words at all.
 */
export function orbitTag(reasons) {
  const strong = (reasons || []).filter((reason) => reason?.text && !reason.text.includes('少し'));
  const reason = strong.find((row) => row.kind !== 'island') || strong[0];
  if (!reason) return '';
  if (reason.kind === 'topics') return (reason.text.match(/「[^」]+」/) || [''])[0];
  return ORBIT_TAGS[reason.kind] || '';
}

/** 「焚き火島・投稿 4件・つながり 3人」 under a person's name. */
export function personMeta(card) {
  const parts = [];
  if (card?.island) parts.push(card.island);
  if (card?.post_count) parts.push(`投稿 ${card.post_count}件`);
  if (card?.connection_count) parts.push(`つながり ${card.connection_count}人`);
  return parts.join('・');
}

export function digestLabel(count) {
  return `前回から ${count}件の変化`;
}

function joinIslands(labels) {
  if (labels.length <= 2) return labels.join('と');
  return `${labels[0]}など${labels.length}つの島`;
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
  const here = islandLabel(after) || islandLabel(before) || nameAt(change?.place) || 'ある島';
  let text = '';
  let numbers = '';
  switch (change?.kind) {
    case 'merge': {
      const parts = (before.islands || []).map(islandLabel).filter(Boolean);
      const unique = [...new Set(parts)];
      text = unique.length >= 2 ? `${joinIslands(unique)}が合流しました。` : `${here}に島が合流しました。`;
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
        ? `${here}が${before.tier_name}から${after.tier_name}に育ちました。`
        : `${here}が${before.tier_name}から${after.tier_name}に戻りました。`;
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
