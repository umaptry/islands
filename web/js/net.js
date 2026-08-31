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

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(url, { method = 'GET', body, headers = {}, auth = true, raw } = {}) {
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

async function restCall(path, { params, method = 'GET', body, prefer } = {}) {
  const { anon_key: key } = config().supabase;
  const headers = { apikey: key };
  if (prefer) headers.prefer = prefer;
  return request(rest(path, params), { method, body, headers });
}

const rpc = (name, args) =>
  restCall(`rpc/${name}`, { method: 'POST', body: args });

const ACCOUNT_EMBED = 'accounts(id,display_name,icon_id,avatar_path)';
const POST_COLUMNS =
  'id,author_id,body,tags,motivation,image_path,x,y,cluster_id,' +
  'like_count,help_count,join_count,comment_count,energy,created_at,updated_at';

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
  async mapCells({ minX, minY, maxX, maxY }) {
    return rpc('map_cells', { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY });
  },
  async getPost(id) {
    const rows = await restCall('posts', {
      params: {
        select: `${POST_COLUMNS},${ACCOUNT_EMBED}`,
        id: `eq.${id}`, deleted_at: 'is.null', limit: '1',
      },
    });
    return rows.length ? flatten(rows[0]) : null;
  },
  async postsByAuthor(authorId) {
    const rows = await restCall('posts', {
      params: {
        select: `${POST_COLUMNS},${ACCOUNT_EMBED}`,
        author_id: `eq.${authorId}`, deleted_at: 'is.null', order: 'created_at.desc',
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
        select: `id,post_id,author_id,body,created_at,${ACCOUNT_EMBED}`,
        post_id: `eq.${postId}`, deleted_at: 'is.null', order: 'created_at.asc',
      },
    });
    return rows.map((row) => flatten(row, 'author'));
  },
  async addComment(postId, body) {
    const rows = await restCall('comments', {
      method: 'POST',
      params: { select: `id,post_id,author_id,body,created_at,${ACCOUNT_EMBED}` },
      prefer: 'return=representation',
      body: { post_id: postId, author_id: session.userId(), body },
    });
    return flatten(rows[0], 'author');
  },
  async deleteComment(commentId) {
    await restCall('comments', {
      method: 'PATCH',
      params: { id: `eq.${commentId}`, author_id: `eq.${session.userId()}` },
      body: { deleted_at: new Date().toISOString() },
    });
    return true;
  },
  async myReactions() {
    return restCall('reactions', {
      params: { select: 'post_id,kind', actor_id: `eq.${session.userId()}` },
    });
  },
  async addReaction(postId, kind) {
    // resolution=ignore-duplicates: two taps racing each other must not turn
    // the second one into an error the tapper sees.
    await restCall('reactions', {
      method: 'POST',
      params: { on_conflict: 'post_id,actor_id,kind' },
      prefer: 'return=minimal,resolution=ignore-duplicates',
      body: { post_id: postId, actor_id: session.userId(), kind },
    });
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
  async listNotifications() {
    const rows = await restCall('notifications', {
      params: {
        select: 'id,recipient_id,actor_id,post_id,comment_id,type,created_at,read_at,'
          + 'accounts!notifications_actor_id_fkey(id,display_name,icon_id,avatar_path)',
        recipient_id: `eq.${session.userId()}`,
        order: 'created_at.desc',
        limit: '100',
      },
    });
    return rows.map((row) => flatten(row, 'actor'));
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
  addComment: (postId, body) => api.post('/api/local/comments', { post_id: postId, body }),
  deleteComment: async (commentId) => {
    await api.del(`/api/local/comments/${commentId}`);
    return true;
  },
  myReactions: async () => (await api.get('/api/local/reactions/mine')).reactions,
  addReaction: async (postId, kind) => {
    await api.post('/api/local/reactions', { post_id: postId, kind });
    return true;
  },
  removeReaction: async (postId, kind) => {
    const params = new URLSearchParams({ post_id: postId, kind });
    await api.del(`/api/local/reactions?${params}`);
    return true;
  },
  listNotifications: async () => (await api.get('/api/local/notifications')).notifications,
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
});
