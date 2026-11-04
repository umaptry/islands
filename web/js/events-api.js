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
  /** 主催者が名簿で受付する（受付待ちの人・申し込み済みの人）：{ status, joined }。 */
  hostCheckin: (code, accountId) =>
    api.post(`/api/events/${enc(code)}/registrations/${enc(accountId)}/checkin`, {}),
  /** 受付待ちの人を却下する：{ walkin_rejects }。 */
  rejectWalkin: (code, accountId) =>
    api.post(`/api/events/${enc(code)}/registrations/${enc(accountId)}/reject-walkin`, {}),

  // ---- 限定ページ・受付・会のあと（第2回b）
  /** 参加者リスト：{ counts, people, near3 }。見られない人は 404。 */
  participants: (code) => api.get(`/api/events/${enc(code)}/participants`),
  /** 「本人に確認」の会で、受付済みの人がコミュニティに参加する：{ status, community_id }。 */
  join: (code) => api.post(`/api/events/${enc(code)}/join`, {}),
  /** 受付の画面の状態：{ event, window, me, rejects, is_member }（受付待ちの画面が数秒ごとに読む）。 */
  checkinInfo: (checkinCode) => api.get(`/api/checkin/${enc(checkinCode)}`),
  /** QR で受付する：{ result, joined }。result が need_walkin なら飛び入りの入力へ。 */
  checkin: (checkinCode) => api.post(`/api/checkin/${enc(checkinCode)}`, {}),
  /** 飛び入りの受付待ちになる：body は { display_name, affiliation, agree_terms }。 */
  walkin: (checkinCode, body) => api.post(`/api/checkin/${enc(checkinCode)}/walkin`, body),
  /** 会のあと：{ people, me_is_member, join_policy }。 */
  after: (code) => api.get(`/api/events/${enc(code)}/after`),
  /** 会えてよかった（on で付ける、false で外す）：{ on }。 */
  met: (code, to, on) => api.post(`/api/events/${enc(code)}/met`, { to, on }),
};
