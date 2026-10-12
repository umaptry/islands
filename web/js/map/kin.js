// Dotted lines: who you might get on with (as in the design mock).
//
// Drawn from your own posts only, and seen only by you:
//
//   same island    straight dots to the three people there whose posts are
//                  most like yours (関わりしろ)
//   another island one arch of dots to the person over the water whose post is
//                  most like yours (相性)
//
// "Most like" is the server's ranking (/api/neighbors), the 448-dim cosine that
// 似てる度 is made from, not distance on the map: the map is a 2-D shadow of
// that space. Somebody you already have a line with (a reaction, a message)
// gets that solid line instead of dots.
//
// Pure: no DOM, no imports, so the choice can be tested on its own.

export const KIN_SAME_ISLAND = 3;
export const KIN_OTHER_ISLAND = 1;

/**
 * @param mine       your posts [{ id, x, y }]
 * @param neighbors  Map: your post id -> ranked rows [{ id, author_id, x, y }], best first
 * @param islandOf   (postId, [x, y]) -> the island it stands on, or null
 * @param linked     Set of account ids you already have a solid line with
 * @param me         your account id
 * @returns [{ key, from: { x, y }, to: { x, y }, across, mine, post, person, row }]
 */
export function kinLines({ mine, neighbors, islandOf, linked = new Set(), me }) {
  const out = [];
  // One line per person, from whichever of your posts names them first.
  const taken = new Set();
  mine.forEach((post) => {
    if (!Number.isFinite(post.x) || !Number.isFinite(post.y)) return;
    const rows = neighbors.get(post.id) || [];
    const home = islandOf(post.id, [post.x, post.y]);
    let near = 0;
    let far = 0;
    rows.forEach((row) => {
      if (!row || row.author_id === me || taken.has(row.author_id) || linked.has(row.author_id)) return;
      if (!Number.isFinite(row.x) || !Number.isFinite(row.y)) return;
      const there = islandOf(row.id, [row.x, row.y]);
      if (!home || !there) return;   // no islands yet: nothing to be on the same one
      const across = there !== home;
      if (across ? far >= KIN_OTHER_ISLAND : near >= KIN_SAME_ISLAND) return;
      if (across) far += 1;
      else near += 1;
      taken.add(row.author_id);
      out.push({
        key: `${post.id}|${row.id}`,
        from: { x: post.x, y: post.y },
        to: { x: row.x, y: row.y },
        across,
        mine: post.id,
        post: row.id,
        person: row.author_id,
        row,
      });
    });
  });
  return out;
}
