// 会（主催者とメンバーの画面）が呼ぶサーバーの道。本番も手元も同じパス（/api/events/…）なので分岐は要らない。
// 設計 D の 5-1 は web/js/events-api.js にまとめる案。公開側の担当と同じファイルを同時に作らないよう、
// こちらは別の名前にした（合流のときに events-api.js へ寄せてよい）。

import { api } from './net.js';

const enc = encodeURIComponent;

export const eventHostApi = {
  /** 会の投稿のカード用：会であれば { event, me, is_host, checkin_code }。会でなければ null（404）。 */
  async byPost(postId) {
    try {
      return await api.get(`/api/events/by-post/${enc(postId)}`);
    } catch (error) {
      if (error && (error.status === 404 || error.status === 403)) return null;
      throw error;
    }
  },
  get: (code) => api.get(`/api/events/${enc(code)}`),
  update: (code, fields) => api.patch(`/api/events/${enc(code)}`, fields),
  roster: (code) => api.get(`/api/events/${enc(code)}/roster`),
  decline: (code, accountId) =>
    api.post(`/api/events/${enc(code)}/registrations/${enc(accountId)}/decline`, {}),
  /** メンバーの1タップ申し込み（質問なし）。 */
  apply: (code) => api.post(`/api/events/${enc(code)}/apply`, { agree_terms: true }),
  cancel: (code) => api.post(`/api/events/${enc(code)}/cancel`, {}),
  /** 会の中止＝会の投稿を消す（サーバーが会を中止にして、申し込んだ人に知らせる）。 */
  cancelEvent: (postId) => api.del(`/api/posts/${enc(postId)}`),
};
