// 会の投稿のカードの下に出る、申し込みのボタンと主催者のメニュー（2026-11-01 第2回a）。
//
// 会の投稿は「参加する」を押せない（サーバーが断る）。代わりに：
//   メンバー  「申し込む」→ 確認 → 申し込み済み（押すと取り消し）。質問はない。中止の会は「この会は中止になりました」
//   主催者    「主催者メニュー」の帯（申し込みリンクをコピー／名簿とメニューを開く）
// 名前（フルネーム）が未確認なら、先に #/fullname を出して、確認のあとこのカードに戻って確認を開く。
//
// 会かどうかは GET /api/events/by-post/{id} で調べる（会でなければ 404 ＝ ふつうの募集の投稿で、今までどおり）。
// 調べるまでは「参加」のボタンを隠しておく（会の投稿で押されないように）。

import { eventHostApi } from '../event-host-api.js';
import {
  TERMS_NEXT, PRIVACY_NEXT, applyConfirm, applyFailure, applyLink, cancelConfirm, formatWhen, hostHash,
  memberAction, needsFullnameFirst,
} from '../event-host-rules.js';
import { isRecruiting } from '../map/reads.js';
import { data } from '../net.js';
import { navigate } from '../router.js';
import { markFullnameDue, rememberFullnameReturn } from '../screens/fullname.js';
import { state, upsertPost } from '../state.js';
import { confirmAction, el, toast } from '../ui.js';
import { mapLinkFor } from '../return-post.js';

const known = new Map();        // 投稿の id → 会の情報（GET by-post の返り）、会でなければ null
let applyAfterName = null;      // 名前を確かめて戻ってきたら、この投稿の確認を開く

/** 会の情報を覚えなおす（申し込み・取り消し・会の変更のあと）。 */
export function forgetEvent(postId) {
  if (postId) known.delete(postId); else known.clear();
}

async function load(postId) {
  if (known.has(postId)) return known.get(postId);
  let view = null;
  try {
    view = await eventHostApi.byPost(postId);
  } catch {
    return undefined;           // 読めなかった（通信など）：次に開いたときにもう一度
  }
  known.set(postId, view);
  return view;
}

/** 申し込みの確認（画像 4 の B）。同意の文と、新しい規約・ポリシーへのリンクつき。 */
function askApply(event) {
  const text = applyConfirm(event);
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const backdrop = el('div', { className: 'modal-backdrop' });
    const done = (answer) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus();
      resolve(answer);
    };
    const onKey = (keyEvent) => { if (keyEvent.key === 'Escape') done(false); };
    const panel = el('div', { className: 'modal ev-modal', attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': text.title } },
      el('h3', { className: 'modal-title', text: text.title }),
      el('div', { className: 'ev-modal-card' },
        el('b', { text: text.name }),
        el('span', { text: text.when }),
        text.place ? el('span', { text: text.place }) : null),
      el('p', { className: 'modal-body', text: text.note }),
      el('p', { className: 'ev-consent' },
        '申し込むと、',
        el('a', { attrs: { href: TERMS_NEXT, target: '_blank', rel: 'noopener' }, text: '新しい利用規約' }),
        'と',
        el('a', { attrs: { href: PRIVACY_NEXT, target: '_blank', rel: 'noopener' }, text: 'プライバシーポリシー' }),
        'に同意したことになります。'),
      el('div', { className: 'modal-actions stacked' },
        el('button', { className: 'btn ev-confirm', attrs: { type: 'button' }, text: text.confirmLabel, on: { click: () => done(true) } }),
        el('button', { className: 'btn btn-quiet', attrs: { type: 'button' }, text: 'やめる', on: { click: () => done(false) } })));
    backdrop.append(panel);
    backdrop.addEventListener('pointerdown', (pointer) => { if (pointer.target === backdrop) done(false); });
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
    panel.querySelector('.ev-confirm').focus();
    requestAnimationFrame(() => backdrop.classList.add('on'));
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 投稿カードの foot に会のブロックを足す。会の投稿だと分かったら「参加」のボタンを隠す。 */
export function mountEventBlock(post, foot, joinButton) {
  if (!state.account || !isRecruiting(post) || known.get(post.id) === null) return;
  const holder = el('div', { className: 'ev-block', attrs: { 'data-event-post': post.id } });
  if (joinButton) joinButton.after(holder); else foot.append(holder);

  let view = known.get(post.id) || null;
  let phase = view ? 'event' : 'loading';        // loading ／ event ／ plain（会ではない）／ failed（読めなかった）

  const refresh = async () => {
    forgetEvent(post.id);
    const fresh = await load(post.id);
    if (fresh) {
      view = fresh;
      phase = 'event';
      paint();
    }
    // 参加の数（カードの数字）も読み直す
    upsertPost(await data.getPost(post.id).catch(() => null));
  };

  async function fromName() {
    rememberFullnameReturn(mapLinkFor(post.id));
    applyAfterName = post.id;
    markFullnameDue();
    await navigate('#/fullname');
  }

  async function apply() {
    if (needsFullnameFirst(state.account)) {
      await fromName();
      return;
    }
    const ok = await askApply(view.event);
    if (!ok) return;
    try {
      await eventHostApi.apply(view.event.code);
      toast('申し込みました。');
      await refresh();
    } catch (error) {
      const failure = applyFailure(error);
      if (failure.kind === 'name') await fromName();
      else toast(failure.message);
    }
  }

  async function cancelMine() {
    const text = cancelConfirm(view.event);
    if (!await confirmAction({ title: text.title, body: text.body, confirmLabel: text.confirmLabel })) return;
    try {
      await eventHostApi.cancel(view.event.code);
      toast('申し込みを取り消しました。');
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  }

  function hostMenu() {
    const code = view.event.code;
    return el('div', { className: 'ev-host' },
      el('p', { className: 'ev-host-head' }, el('b', { text: '主催者メニュー' }), el('span', { text: 'あなただけに見えます' })),
      el('div', { className: 'ev-host-buttons' },
        el('button', {
          className: 'ev-host-btn ev-copy', attrs: { type: 'button' }, text: '申し込みリンク',
          on: {
            click: async () => {
              const link = applyLink(location.origin, code);
              toast((await copyText(link)) ? '申し込みのリンクをコピーしました。' : link);
            },
          },
        }),
        el('button', {
          className: 'ev-host-btn ev-open-host', attrs: { type: 'button' }, text: '名簿とメニュー',
          on: { click: () => navigate(hostHash(code)) },
        })));
  }

  function paint() {
    holder.replaceChildren();
    // 会だと分かるまで・会のあいだは「参加」を隠す。会ではないとき・読めなかったときは今までどおり。
    if (joinButton) joinButton.hidden = phase === 'loading' || phase === 'event';
    if (phase !== 'event' || !view) return;
    const event = view.event;
    const action = memberAction(view);
    const capacity = event.capacity ? `${event.applied_count}／${event.capacity}人` : `${event.applied_count}人`;
    const info = el('p', { className: 'ev-info',
      text: event.cancelled ? '' : `${formatWhen(event.starts_at, event.ends_at)}　申し込み ${capacity}` });
    if (action.kind === 'host') {
      holder.append(hostMenu(), info);
      return;
    }
    const button = el('button', {
      className: `ev-apply-btn ${action.kind}`, attrs: { type: 'button', 'data-kind': action.kind },
      text: action.label,
    });
    button.disabled = action.disabled;
    if (action.kind === 'apply') button.addEventListener('click', apply);
    if (action.kind === 'applied') button.addEventListener('click', cancelMine);
    holder.append(button);
    if (!event.cancelled) holder.append(info);
  }

  const afterName = () => {
    if (applyAfterName !== post.id) return;
    applyAfterName = null;
    if (view && memberAction(view)?.kind === 'apply') apply();
  };

  paint();
  if (phase === 'event') {
    afterName();
    return;
  }
  load(post.id).then((loaded) => {
    if (loaded === undefined) phase = 'failed';
    else if (loaded === null) phase = 'plain';
    else { view = loaded; phase = 'event'; }
    paint();
    if (holder.isConnected) afterName();
  });
}
