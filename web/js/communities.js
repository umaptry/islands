// Communities on the page: which ones I am in, which map I am looking at, and
// what the map should show. The rules are in community-rules.js; this file is the
// part that touches the network, storage and state.
//
// Silent when features.communities is false (communitiesActive() is then false and
// the map is everybody's, as before).

import { config, membersOnly } from './config.js';
import { data } from './net.js';
import { session } from './session.js';
import { notify, state } from './state.js';
import { browserStorage } from './talk.js';
import {
  chooseCommunity, communitiesOn, forgetCommunity, mapScope, normalizeCommunities,
  readJoinStatus, recallCommunity, rememberCommunity, withJoined,
} from './community-rules.js';

export function communitiesActive() {
  try {
    return communitiesOn(config());
  } catch {
    return false;
  }
}

// A person who has just signed in has no account row yet while they claim an invite.
const accountKey = () => state.account?.id || session.userId() || null;

/** Read my_communities and settle on the current one. Quiet on failure: what is on screen stays. */
export async function refreshCommunities() {
  if (!communitiesActive() || !session.signedIn()) return state.communities;
  try {
    const rows = await data.myCommunities();
    setCommunities(normalizeCommunities(rows));
  } catch { /* keep what we had */ }
  return state.communities;
}

/**
 * Read my_join_status into state.joinStatus: a list (empty = nothing is waiting or said), or null = not known
 * (the SQL is not there yet, or the read failed). What was known before is kept when a read fails, and nobody
 * is sent away for not knowing. Call it where refreshCommunities() is called at start-up, before the router moves.
 */
export async function refreshJoinStatus() {
  if (!communitiesActive() || !session.signedIn()) return state.joinStatus ?? null;
  try {
    const list = readJoinStatus(await data.myJoinStatus());
    if (list) {
      state.joinStatus = list;
      notify('community');
    } else if (state.joinStatus === undefined) {
      state.joinStatus = null;
    }
  } catch {
    if (state.joinStatus === undefined) state.joinStatus = null;
  }
  return state.joinStatus;
}

function setCommunities(list, accountId = accountKey()) {
  state.communities = list;
  state.communitiesLoaded = true;
  const chosen = chooseCommunity(list, state.communityId || recallCommunity(browserStorage(), accountId));
  state.communityId = chosen ? chosen.id : null;
  if (chosen) rememberCommunity(browserStorage(), accountId, chosen.id);
  notify('community');
}

/** A claim just succeeded: I am in this community now, and it is the one to look at. */
export function joinedCommunity(joined, accountId = accountKey()) {
  state.communities = withJoined(state.communities, joined);
  state.communitiesLoaded = true;
  state.communityId = joined.id;
  state.viewCommunity = null;
  rememberCommunity(browserStorage(), accountId, joined.id);
  notify('community');
}

/** Look at another community of mine. */
export function chooseCurrent(id) {
  const found = state.communities.find((entry) => entry.id === id);
  if (!found) return false;
  state.communityId = id;
  state.viewCommunity = null;
  rememberCommunity(browserStorage(), accountKey(), id);
  notify('community');
  return true;
}

export function clearCommunities(accountId = accountKey()) {
  state.joinStatus = null;
  state.communities = [];
  state.communitiesLoaded = false;
  state.communityId = null;
  state.viewCommunity = null;
  forgetCommunity(browserStorage(), accountId);
  notify('community');
}

/** For sign-out: forget the lists but leave the remembered choice for next time. */
export function dropCommunities() {
  postCommunities.clear();
  state.joinStatus = null;
  state.communities = [];
  state.communitiesLoaded = false;
  state.communityId = null;
  state.viewCommunity = null;
}

/** What the map should show now. `linked` is the community of a linked post, if any; `closed` (members only):
 * the link led to something this person cannot read. */
export function currentScope(linked = null, closed = false) {
  return mapScope({
    on: communitiesActive(),
    communities: state.communities,
    current: state.communityId,
    linked,
    viewing: state.viewCommunity,
    membersOnly: membersOnly(),
    closed,
  });
}

const postCommunities = new Map();   // post id -> community id ('' when the post could not be read)

/** The community a post is in: from what is already on screen, else asked once (a failure is remembered as
 * unknown for this page load, so a list of rows does not ask again and again). */
export async function communityIdOfPost(postId) {
  if (!postId) return '';
  const known = state.postsById.get(postId) || state.myPosts.find((post) => post.id === postId);
  if (known && known.community_id) return known.community_id;
  if (postCommunities.has(postId)) return postCommunities.get(postId);
  let id = '';
  let answered = false;
  try {
    const post = await data.getPost(postId);
    answered = true;
    id = (post && post.community_id) || '';
  } catch { /* unknown */ }
  // Only an answer is remembered: a dropped connection, or a time before I was a member, is asked again.
  if (answered && id) postCommunities.set(postId, id);
  return id;
}

/** A community's name: from my list, else the community table (members read it); '' when unknown. */
export async function communityNameFor(id) {
  if (!id) return '';
  const mine = state.communities.find((entry) => entry.id === id);
  if (mine) return mine.name;
  if (!state.account) return '';   // the table is for members: signed out there is nobody to ask for
  try {
    const info = await data.communityInfo(id);
    return (info && info.name) || '';
  } catch {
    return '';
  }
}

/** The community a post belongs to, with its name when I can find it. */
export async function communityOfPost(post) {
  const id = post && post.community_id;
  if (!id) return null;
  const mine = state.communities.find((entry) => entry.id === id);
  if (mine) return { id, name: mine.name };
  let name = '';
  try {
    const info = await data.communityInfo(id);
    name = (info && info.name) || '';
  } catch { /* the name is only a label */ }
  return { id, name: name || 'コミュニティ' };
}
