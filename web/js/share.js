// ほかのコミュニティにも出す (2026-10-29): the copies of one post on several communities' maps.
//
// Each community keeps a row of its own (its own likes, messages and joins), joined to the others by
// posts.share_group. The map and the profile pages both delete a post through here, so that a post
// on several maps is always asked about the same way: this community only, or every one of them.

import { api, data } from './net.js';
import { state, removePost } from './state.js';
import { chooseAction } from './ui.js';
import { communityNameIn, deleteQuestion } from './community-rules.js';

/** My copies of a post, oldest first (just the post when it is on one map). My posts are read again
 * when the copies are not known yet (the post was shared from another device, say). */
export async function copiesOf(post) {
  const known = (rows) => {
    const group = post.share_group || rows.find((row) => row.id === post.id)?.share_group;
    return group ? rows.filter((row) => row.share_group === group) : [];
  };
  let copies = known(state.myPosts);
  if (copies.length < 2 && state.account && (post.share_group || post.group_join_count != null)) {
    const fresh = await data.postsByAuthor(state.account.id).catch(() => null);
    if (Array.isArray(fresh)) {
      state.myPosts = fresh;
      copies = known(fresh);
    }
  }
  if (!copies.length) return [post];
  const time = (row) => Date.parse(row.created_at || '') || 0;
  return [...copies].sort((a, b) => time(a) - time(b));
}

/** The names of the communities the copies are in (those I know the names of). */
export const namesOf = (copies) =>
  copies.map((row) => communityNameIn(state.communities, row.community_id)).filter(Boolean);

/** Ask, then delete this copy (「このコミュニティだけ外す」) or every copy. Resolves to the ids deleted:
 * [] when the person changed their mind. Errors are thrown to the caller (which says them). */
export async function deleteOwnPost(post) {
  const copies = await copiesOf(post);
  const here = communityNameIn(state.communities, post.community_id);
  const answer = await chooseAction(deleteQuestion(namesOf(copies), here, copies.length));
  if (!answer) return [];
  const all = answer === 'all';
  await api.del(`/api/posts/${encodeURIComponent(post.id)}${all ? '?scope=all' : ''}`);
  const gone = all ? copies.map((row) => row.id) : [post.id];
  gone.forEach((id) => removePost(id));
  return gone;
}

/** Put a post on other communities' maps too. Resolves to the server's answer ({ added, posts }). */
export async function sharePost(postId, communityIds) {
  const result = await api.post(`/api/posts/${encodeURIComponent(postId)}/share`, { community_ids: communityIds });
  // The copies are mine: the profile and the next edit know them at once.
  const others = (result?.posts || []).filter((row) => !state.myPosts.some((mine) => mine.id === row.id));
  state.myPosts = state.myPosts
    .map((mine) => (result?.posts || []).find((row) => row.id === mine.id) || mine)
    .concat(others);
  return result;
}
