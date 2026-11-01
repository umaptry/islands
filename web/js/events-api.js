// 会の画面（公開ページ・ゲスト用ページ・主催者の画面・投稿カード）が呼ぶサーバーの道を、ここ1か所にまとめる。
// 本番も手元も同じパス（/api/events/… と /api/public/events/…）なので、バックエンドの分岐は要らない。

import { api } from './net.js';

const enc = encodeURIComponent;

export const eventsApi = {
  // ---- 公開ページ（ログイン不要）
  /** 公開ページの数字。404 は会がないとき。visibility（public／community）も返る。 */
  info: (code) => api.get(`/api/public/events/${enc(code)}`, { auth: false }),
  /** 近い人が来るか見てみる：{ level, count, genres }。興味だけを送り、サーバーは何も覚えない。 */
  probe: (code, interests) => api.post(`/api/public/events/${enc(code)}/probe`, { interests }, { auth: false }),

  // ---- 会と自分の状態（ログイン）
  get: (code) => api.get(`/api/events/${enc(code)}`),
  /** 自分の申し込み：[{ code, title, starts_at, status }]。all を true にすると取り消し・お断り・中止も含む。 */
  mine: async ({ all = false } = {}) => ((await api.get(`/api/events/mine${all ? '?all=1' : ''}`)) || {}).events || [],
  /** 申し込み。メンバーの1タップは本文なし（同意だけ）、ゲストは名前や答えを本文で送る。 */
  apply: (code, body = { agree_terms: true }) => api.post(`/api/events/${enc(code)}/apply`, body),
  cancel: (code) => api.post(`/api/events/${enc(code)}/cancel`, {}),
  late: (code, minutes) => api.post(`/api/events/${enc(code)}/late`, { minutes }),

  // ---- 投稿カード・主催者
  /** 会の投稿のカード用：会であれば { event, me, is_host, checkin_code }。会でなければ null（404）。 */
  async byPost(postId) {
    try {
      return await api.get(`/api/events/by-post/${enc(postId)}`);
    } catch (error) {
      if (error && (error.status === 404 || error.status === 403)) return null;
      throw error;
    }
  },
  update: (code, fields) => api.patch(`/api/events/${enc(code)}`, fields),
  roster: (code) => api.get(`/api/events/${enc(code)}/roster`),
  decline: (code, accountId) =>
    api.post(`/api/events/${enc(code)}/registrations/${enc(accountId)}/decline`, {}),
  /** 会の中止＝会の投稿を消す（サーバーが会を中止にして、申し込んだ人に知らせる）。 */
  cancelEvent: (postId) => api.del(`/api/posts/${enc(postId)}`),
};
