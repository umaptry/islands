// Talking to the two things this app talks to.
//
// `api` is our own FastAPI: the writes that need the frozen encoder, plus the
// landmass names and the similarity ruler.
//
// `data` is everything else - the map, comments, reactions, notifications,
// images. In a deployment those go straight to Supabase with the visitor's own
// JWT, and RLS decides what they may touch; the container never sees them. With
// no Supabase project configured the same operations go to /api/local/*, which
// is what makes the whole app run offline with nothing else installed.
//
// There is no supabase-js. GoTrue, PostgREST and Storage are plain REST, and a
// CDN script tag would be a runtime dependency on somebody else's uptime - the
// exact shape of the failure that took two deploys down on 2026-08-21 (see the
// comment in Dockerfile).

import { config, isLocal } from './config.js';
import { session } from './session.js';
import { attachActors } from './notify-rules.js';
import { joinRefusal } from './recruit-rules.js';
import { readPress, readSent, talkRefusal } from './talk-rules.js';
import { communitiesOn } from './community-rules.js';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// keepalive lets a request outlive the page: "no longer on screen" is said as
// the tab closes, and without it the browser would drop it on the floor.
async function request(url, { method = 'GET', body, headers = {}, auth = true, raw, keepalive, cache } = {}) {
  const merged = { accept: 'application/json', ...headers };
  if (auth) {
    const token = await session.accessToken();
    if (token) merged.authorization = `Bearer ${token}`;
  }
  if (body !== undefined && !raw) merged['content-type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: merged,
      body: raw ? body : (body === undefined ? undefined : JSON.stringify(body)),
      ...(keepalive ? { keepalive: true } : {}),
      ...(cache ? { cache } : {}),
    });
  } catch {
    throw new ApiError('接続できませんでした。通信環境をご確認ください。', 0);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    // Supabase phrases its errors for a developer reading a console; ours are
    // phrased for a person holding a phone. Prefer ours, and fall back to a
    // sentence rather than showing a raw PostgREST message to a visitor.
    const detail = payload && (payload.detail || payload.msg || payload.message);
    throw new ApiError(detail || `うまくいきませんでした (${response.status})`, response.status);
  }
  return payload;
}

export const api = {
  get: (path, options) => request(path, { ...options, method: 'GET' }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  del: (path, options) => request(path, { ...options, method: 'DELETE' }),
};

// ---------------------------------------------------------------- supabase

function rest(path, params) {
  const { url } = config().supabase;
  const query = params ? `?${new URLSearchParams(params)}` : '';
  return `${url}/rest/v1/${path}${query}`;
}

async function restCall(path, { params, method = 'GET', body, prefer, keepalive } = {}) {
  const { anon_key: key } = config().supabase;
  const headers = { apikey: key };
  if (prefer) headers.prefer = prefer;
  return request(rest(path, params), { method, body, headers, keepalive });
}

const rpc = (name, args, options) =>
  restCall(`rpc/${name}`, { method: 'POST', body: args, ...options });

const ACCOUNT_EMBED = 'accounts(id,display_name,icon_id,avatar_path)';
// Posts also reach accounts through reactions and comments, so name the key.
const POST_AUTHOR_EMBED = 'accounts!posts_author_id_fkey(id,display_name,icon_id,avatar_path)';
const POST_COLUMNS =
  'id,author_id,body,tags,motivation,image_path,x,y,cluster_id,' +
  'like_count,help_count,join_count,comment_count,energy,created_at,updated_at';
// The new columns only exist once the migration has been run; asking for them
// before that would be a 400 on every post read.
const postColumns = () =>
  (config().features?.post_extras ? `${POST_COLUMNS},prompt,recruit_deadline,recruit_capacity` : POST_COLUMNS)
  + (communitiesOn(config()) ? ',community_id' : '');

/** A refused join (recruit_closed / recruit_full) said in words for a person. */
function joinError(error) {
  const text = joinRefusal(error?.message);
  return text ? new ApiError(text, error.status) : error;
}

/** A refused press / send, said in words for a person (same idea as joinError). */
function talkError(error, context = 'talk') {
  return new ApiError(talkRefusal(error?.message, context), error?.status ?? 0);
}

// "From the beginning" for the DM poll. The filter is always written out, so the
// grant check in tests/frontend/net-grants.test.mjs sees every column it uses.
const DM_EPOCH = '1970-01-01T00:00:00Z';

/**
 * notification_feed() does not say which community a row belongs to; the notifications table does (a row
 * of my own, read under the same rules). Asked once for the whole list, and a failure only means the
 * names are not shown: the list itself is never held back by it.
 */
async function withCommunities(rows) {
  if (!communitiesOn(config()) || !rows.length) return rows;
  const ids = [...new Set(rows.flatMap((row) => (Array.isArray(row.ids) && row.ids.length ? row.ids : [row.id])))];
  try {
    const found = await restCall('notifications', {
      params: { select: 'id,community_id', id: `in.(${ids.join(',')})` },
    });
    const byId = new Map((found || []).map((row) => [row.id, row.community_id]));
    return rows.map((row) => {
      const own = (Array.isArray(row.ids) && row.ids.length ? row.ids : [row.id]).map((id) => byId.get(id)).find(Boolean);
      return own && !row.community_id ? { ...row, community_id: own } : row;
    });
  } catch {
    return rows;
  }
}

/** PostgREST nests an embedded table; every screen wants it flat. */
function flatten(row, into) {
  if (!row) return row;
  const nested = row.accounts || {};
  delete row.accounts;
  if (into) {
    row[into] = {
      id: nested.id,
      display_name: nested.display_name || '',
      icon_id: nested.icon_id || '0',
      avatar_path: nested.avatar_path || null,
    };
  } else {
    row.display_name = nested.display_name || '';
    row.icon_id = nested.icon_id || '0';
    row.avatar_path = nested.avatar_path || null;
  }
  return row;
}

const supabaseBackend = {
  async mapPosts({ minX, minY, maxX, maxY, limit }) {
    return rpc('map_posts', {
      min_x: minX, min_y: minY, max_x: maxX, max_y: maxY, limit_n: limit,
    });
  },
  // ---- communities and invites. Rows of the invite tables are never read directly:
  // the database answers through these functions.
  async communityMapPosts(community, { minX, minY, maxX, maxY, limit }) {
    return rpc('community_map_posts', {
      community, min_x: minX, min_y: minY, max_x: maxX, max_y: maxY, limit_n: limit,
    });
  },
  async myCommunities() {
    return (await rpc('my_communities', {})) || [];
  },
  /** A community's name by id (anybody may read it); null when unknown. */
  async communityInfo(id) {
    const rows = await restCall('communities', {
      params: { select: 'id,name', id: `eq.${id}`, limit: '1' },
    });
    return rows.length ? rows[0] : null;
  },
  checkInvite: (code) => rpc('check_invite', { code }),
  claimInvite: (code) => rpc('claim_invite', { code }),
  createInvite: ({ community_id: community, minutes, until_end_of_day: untilEndOfDay }) =>
    rpc('create_invite', { community, minutes, until_end_of_day: untilEndOfDay }),
  async listInvites(community) {
    return (await rpc('list_invites', { community })) || [];
  },
  async revokeInvite(invite) {
    await rpc('revoke_invite', { invite });
    return true;
  },
  /** An admin renames the community; answers the name as saved (trimmed). */
  renameCommunity: (community, name) => rpc('rename_community', { community, new_name: name }),
  async mapCells({ minX, minY, maxX, maxY }) {
    return rpc('map_cells', { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY });
  },
  // No deleted_at filter on posts: the column is not granted for select, so using it
  // in a filter is a 42501. The posts_read policy already hides deleted rows.
  async getPost(id) {
    const rows = await restCall('posts', {
      params: {
        select: `${postColumns()},${POST_AUTHOR_EMBED}`,
        id: `eq.${id}`, limit: '1',
      },
    });
    return rows.length ? flatten(rows[0]) : null;
  },
  async postsByAuthor(authorId) {
    const rows = await restCall('posts', {
      params: {
        select: `${postColumns()},${POST_AUTHOR_EMBED}`,
        author_id: `eq.${authorId}`, order: 'created_at.desc',
      },
    });
    return rows.map((row) => flatten(row));
  },
  async getAccount(id) {
    const rows = await restCall('accounts', {
      params: {
        select: 'id,display_name,affiliation,bio,link_url,icon_id,avatar_path,created_at',
        id: `eq.${id}`, limit: '1',
      },
    });
    return rows.length ? rows[0] : null;
  },
  async listComments(postId) {
    const rows = await restCall('comments', {
      params: {
        select: `id,post_id,author_id,body,reply_to,created_at,${ACCOUNT_EMBED}`,
        post_id: `eq.${postId}`, deleted_at: 'is.null', order: 'created_at.asc',
      },
    });
    return rows.map((row) => flatten(row, 'author'));
  },
  async addComment(postId, body, replyTo = null) {
    const rows = await restCall('comments', {
      method: 'POST',
      params: { select: `id,post_id,author_id,body,reply_to,created_at,${ACCOUNT_EMBED}` },
      prefer: 'return=representation',
      body: { post_id: postId, author_id: session.userId(), body, ...(replyTo ? { reply_to: replyTo } : {}) },
    });
    return flatten(rows[0], 'author');
  },
  // Through the server: setting deleted_at here hides the row from the
  // comments_read policy, and the database then refuses the update it is asked
  // to return. The server writes it with its own key, after checking the author.
  async deleteComment(commentId) {
    await api.del(`/api/comments/${encodeURIComponent(commentId)}`);
    return true;
  },
  async myReactions() {
    return restCall('reactions', {
      params: { select: 'post_id,kind', actor_id: `eq.${session.userId()}` },
    });
  },
  // Who pressed one reaction on a post (public rows), newest first.
  async reactorsOf(postId, kind) {
    const rows = await restCall('reactions', {
      params: {
        select: `created_at,${ACCOUNT_EMBED}`,
        post_id: `eq.${postId}`, kind: `eq.${kind}`, order: 'created_at.desc', limit: '200',
      },
    });
    return rows.map((row) => {
      const id = row.accounts?.id;
      return { ...flatten(row), id };
    });
  },
  async addReaction(postId, kind) {
    // resolution=ignore-duplicates: two taps racing each other must not turn
    // the second one into an error the tapper sees.
    try {
      await restCall('reactions', {
        method: 'POST',
        params: { on_conflict: 'post_id,actor_id,kind' },
        prefer: 'return=minimal,resolution=ignore-duplicates',
        body: { post_id: postId, actor_id: session.userId(), kind },
      });
    } catch (error) {
      throw joinError(error);
    }
    return true;
  },
  async removeReaction(postId, kind) {
    await restCall('reactions', {
      method: 'DELETE',
      params: {
        post_id: `eq.${postId}`, actor_id: `eq.${session.userId()}`, kind: `eq.${kind}`,
      },
    });
    return true;
  },
  // ---- 「話してみたい」 and the DM. Rows are never read from talk_wishes: the
  // database answers only through these functions (and 2-person RLS on the DM tables).
  async talkPeers() {
    const rows = await rpc('talk_peers', {});
    return (rows || []).map((row) => (typeof row === 'string' ? row : row.account_id)).filter(Boolean);
  },
  async talkState() {
    return (await rpc('my_talk_state', {})) || [];
  },
  async pressTalk(target) {
    try {
      return readPress(await rpc('press_talk', { target }));
    } catch (error) {
      throw talkError(error, 'talk');
    }
  },
  async withdrawTalk(target) {
    try {
      await rpc('withdraw_talk', { target });
    } catch (error) {
      throw talkError(error, 'talk');
    }
    return true;
  },
  async dmRooms() {
    return (await rpc('dm_room_list', {})) || [];
  },
  async dmMessages(roomId, after) {
    return restCall('dm_messages', {
      params: {
        select: 'id,room_id,sender_id,body,created_at',
        room_id: `eq.${roomId}`, created_at: `gt.${after || DM_EPOCH}`, order: 'created_at.asc', limit: '500',
      },
    });
  },
  async sendDm(roomId, body) {
    try {
      const rows = await restCall('dm_messages', {
        method: 'POST',
        params: { select: 'id,room_id,sender_id,body,created_at' },
        prefer: 'return=representation',
        body: { room_id: roomId, sender_id: session.userId(), body },
      });
      return readSent(rows);
    } catch (error) {
      throw talkError(error, 'dm');
    }
  },
  async block(blockedId) {
    await restCall('dm_blocks', {
      method: 'POST',
      params: { on_conflict: 'blocker_id,blocked_id' },
      prefer: 'return=minimal,resolution=ignore-duplicates',
      body: { blocker_id: session.userId(), blocked_id: blockedId },
    });
    return true;
  },
  async unblock(blockedId) {
    await restCall('dm_blocks', {
      method: 'DELETE',
      params: { blocker_id: `eq.${session.userId()}`, blocked_id: `eq.${blockedId}` },
    });
    return true;
  },
  /** Reactions to one post within ten minutes as one entry (item 22). */
  async listNotificationFeed(limit = 50) {
    const rows = await rpc('notification_feed', { limit_n: limit });
    // Nobody is looked up for 「誰かが…」: the row's actor is not shown, whoever it names.
    const actorIds = [...new Set(rows.filter((row) => row.type !== 'talk_wish')
      .map((row) => row.actor_id).filter(Boolean))];
    const accounts = actorIds.length
      ? await restCall('accounts', {
        params: { select: 'id,display_name,icon_id,avatar_path', id: `in.(${actorIds.join(',')})` },
      })
      : [];
    return attachActors(await withCommunities(rows), accounts);
  },
  /** The app is on screen for `seconds` (0: it is not), so nothing is pushed meanwhile. */
  async markActive(seconds, { keepalive = false } = {}) {
    await rpc('mark_active', { seconds }, { keepalive });
  },
  async markNotificationsRead(ids) {
    const params = { recipient_id: `eq.${session.userId()}`, read_at: 'is.null' };
    if (ids && ids.length) params.id = `in.(${ids.join(',')})`;
    await restCall('notifications', {
      method: 'PATCH', params, body: { read_at: new Date().toISOString() },
    });
  },
  async report({ postId, commentId, reason }) {
    await restCall('reports', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        reporter_id: session.userId(), post_id: postId || null,
        comment_id: commentId || null, reason: reason || null,
      },
    });
  },
  async uploadImage(blob) {
    const { url, anon_key: key, bucket } = config().supabase;
    const path = `${session.userId()}/${crypto.randomUUID()}.webp`;
    const token = await session.accessToken();
    const response = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${token}`,
        'content-type': blob.type || 'image/webp',
        'cache-control': '3600',
      },
      body: blob,
    });
    if (!response.ok) throw new ApiError('画像をアップロードできませんでした。', response.status);
    return path;
  },
  imageUrl(path) {
    if (!path) return null;
    const { url, bucket } = config().supabase;
    return `${url}/storage/v1/object/public/${bucket}/${path}`;
  },
};

// ---------------------------------------------------------------- local

const box = ({ minX, minY, maxX, maxY }) =>
  new URLSearchParams({ min_x: minX, min_y: minY, max_x: maxX, max_y: maxY });

const localBackend = {
  async mapPosts(bounds) {
    const params = box(bounds);
    params.set('limit', bounds.limit);
    return (await api.get(`/api/local/map?${params}`)).posts;
  },
  async mapCells(bounds) {
    return (await api.get(`/api/local/cells?${box(bounds)}`)).cells;
  },
  async communityMapPosts(community, bounds) {
    const params = box(bounds);
    params.set('limit', bounds.limit);
    return (await api.get(`/api/local/communities/${encodeURIComponent(community)}/map?${params}`)).posts;
  },
  myCommunities: async () => (await api.get('/api/local/communities/mine')).communities || [],
  // Not part of the agreed routes: a development server may or may not have it.
  communityInfo: (id) => api.get(`/api/local/communities/${encodeURIComponent(id)}`)
    .catch(() => null),
  checkInvite: (code) => api.get(`/api/local/invites/check/${encodeURIComponent(code)}`, { auth: false }),
  claimInvite: (code) => api.post('/api/local/invites/claim', { code }),
  createInvite: (body) => api.post('/api/local/invites', body),
  listInvites: async (community) =>
    (await api.get(`/api/local/invites?${new URLSearchParams({ community_id: community })}`)).invites || [],
  revokeInvite: async (invite) => {
    await api.post(`/api/local/invites/${encodeURIComponent(invite)}/revoke`, {});
    return true;
  },
  renameCommunity: (community, name) =>
    api.post(`/api/local/communities/${encodeURIComponent(community)}/rename`, { name }),
  getPost: (id) => api.get(`/api/local/post/${id}`).catch((error) => {
    if (error.status === 404) return null;
    throw error;
  }),
  postsByAuthor: async (authorId) =>
    (await api.get(`/api/local/posts?author=${encodeURIComponent(authorId)}`)).posts,
  getAccount: (id) => api.get(`/api/local/account/${id}`).catch((error) => {
    if (error.status === 404) return null;
    throw error;
  }),
  listComments: async (postId) =>
    (await api.get(`/api/local/comments?post=${encodeURIComponent(postId)}`)).comments,
  addComment: (postId, body, replyTo = null) =>
    api.post('/api/local/comments', { post_id: postId, body, ...(replyTo ? { reply_to: replyTo } : {}) }),
  deleteComment: async (commentId) => {
    await api.del(`/api/local/comments/${commentId}`);
    return true;
  },
  myReactions: async () => (await api.get('/api/local/reactions/mine')).reactions,
  reactorsOf: async (postId, kind) => {
    const params = new URLSearchParams({ kind });
    // The session goes along: with members_only on, who reacted is for the members of the post's community.
    return (await api.get(`/api/local/posts/${encodeURIComponent(postId)}/reactors?${params}`)).reactors;
  },
  addReaction: async (postId, kind) => {
    try {
      await api.post('/api/local/reactions', { post_id: postId, kind });
    } catch (error) {
      throw joinError(error);
    }
    return true;
  },
  removeReaction: async (postId, kind) => {
    const params = new URLSearchParams({ post_id: postId, kind });
    await api.del(`/api/local/reactions?${params}`);
    return true;
  },
  talkPeers: async () => (await api.get('/api/local/talk/peers')).peers || [],
  talkState: async () => (await api.get('/api/local/talk/state')).state || [],
  pressTalk: async (target) => {
    try {
      return readPress(await api.post('/api/local/talk/press', { target }));
    } catch (error) {
      throw talkError(error, 'talk');
    }
  },
  withdrawTalk: async (target) => {
    try {
      await api.post('/api/local/talk/withdraw', { target });
    } catch (error) {
      throw talkError(error, 'talk');
    }
    return true;
  },
  dmRooms: async () => (await api.get('/api/local/dm/rooms')).rooms || [],
  dmMessages: async (roomId, after) => {
    const query = after ? `?${new URLSearchParams({ after })}` : '';
    return (await api.get(`/api/local/dm/rooms/${encodeURIComponent(roomId)}/messages${query}`)).messages || [];
  },
  sendDm: async (roomId, body) => {
    try {
      return readSent(await api.post(`/api/local/dm/rooms/${encodeURIComponent(roomId)}/messages`, { body }));
    } catch (error) {
      throw talkError(error, 'dm');
    }
  },
  block: async (blockedId) => {
    await api.post('/api/local/dm/blocks', { blocked_id: blockedId });
    return true;
  },
  unblock: async (blockedId) => {
    await api.del(`/api/local/dm/blocks/${encodeURIComponent(blockedId)}`);
    return true;
  },
  listNotificationFeed: async (limit = 50) =>
    (await api.get(`/api/local/notifications/feed?limit=${limit}`)).notifications,
  markActive: async (seconds, { keepalive = false } = {}) => {
    await request('/api/local/presence', { method: 'POST', body: { seconds }, keepalive });
  },
  markNotificationsRead: (ids) =>
    api.post('/api/local/notifications/read', { ids: ids && ids.length ? ids : null }),
  report: ({ postId, commentId, reason }) =>
    api.post('/api/local/reports', {
      post_id: postId || null, comment_id: commentId || null, reason: reason || null,
    }),
  async uploadImage(blob) {
    const result = await request('/api/local/upload', {
      method: 'POST',
      body: blob,
      raw: true,
      headers: { 'content-type': blob.type || 'image/webp' },
    });
    return result.path;
  },
  imageUrl: (path) => (path ? `/api/local/image/${path}` : null),
};

let backend = null;

/** The data surface. Same operations either way; the screens never ask which. */
export const data = new Proxy({}, {
  get(_target, key) {
    if (!backend) backend = isLocal() ? localBackend : supabaseBackend;
    return backend[key];
  },
  set(_target, key, value) {
    if (!backend) backend = isLocal() ? localBackend : supabaseBackend;
    backend[key] = value;
    return true;
  },
});
