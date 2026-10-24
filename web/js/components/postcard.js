// islands' PostCard.
//
// Ported piece for piece: the author row, the tag badges, the body, the
// エンジョイ↔ガチ indicator, the image, and the action footer with comments,
// いいね, 手伝えるかも and 参加. The own-post menu (edit / delete) is
// here too - in islands both of its items were an alert() saying the feature
// did not exist.
//
// Stage 5 added, for the author alone, how many people have seen the post (Q35). Nobody else
// ever sees that number, and there is no "seen but not answered" anywhere:
// a reply that does not come should not feel like one that was refused (Q46).

import { config } from '../config.js';
import { data } from '../net.js';
import { hasReacted, state, subscribe, upsertPost } from '../state.js';
import { avatar, confirmAction, el, motivationColor, timeAgo } from '../ui.js';
import { icon } from '../icons.js';
import { buzz } from '../feedback.js';
import { attachLongPress } from '../longpress.js';
import { openImageViewer } from './image-viewer.js';
import { isRecruiting } from '../map/reads.js';
import { joinTerms, joinWord } from '../recruit-rules.js';
import { talkLabelOf, talkButtonText, withdrawPrompt } from '../talk-rules.js';

// One outside-click listener for every card menu, including cards removed with a sheet.
let activeMenu = null;
document.addEventListener('pointerdown', (event) => {
  if (activeMenu && (!activeMenu.wrap.isConnected || !activeMenu.wrap.contains(event.target))) activeMenu.close();
});

// One subscription for all mounted cards; removed cards retain no subscriptions.
subscribe(() => {
  document.querySelectorAll('.post-card[data-post-id]').forEach((card) => {
    // Before the post lookup: a post opened from far away is not in the viewport list.
    card.querySelectorAll('[data-talk]').forEach((node) => node._talkPaint && node._talkPaint());
    const post = state.postsById.get(card.dataset.postId) || state.myPosts.find((p) => p.id === card.dataset.postId);
    if (!post) return;
    card.querySelectorAll('[data-count]').forEach((node) => { node.textContent = post[node.dataset.count] || 0; });
    card.querySelectorAll('[data-views]').forEach((node) => paintViews(node, post.id));
    card.querySelectorAll('[data-reaction]').forEach((node) => {
      const on = hasReacted(post.id, node.dataset.reaction);
      node.classList.toggle('on', on);
      node.setAttribute('aria-pressed', String(on));
      if (node.dataset.reaction === 'join') paintJoin(node, post);
    });
  });
});

/** 参加: the word (参加する / 参加済み / 受付終了 / 満員) and, under it, the terms
 * and the joined count. Not pressable once ended unless you have joined already.
 * The count itself is painted by the subscription through its data-count. */
function paintJoin(button, post) {
  const joined = hasReacted(post.id, 'join');
  // Before the migration the columns do not exist: show nothing of the new rules.
  const extras = Boolean(config().features?.post_extras);
  const { word, ended } = joinWord(post, { joined, extras });
  button.querySelector('.pj-word').textContent = word;
  button.querySelector('.pj-terms').textContent = extras ? joinTerms(post) : '';
  button.classList.toggle('ended', ended);
  if (!button.dataset.busy) button.disabled = ended;
}

// いいね shows only its heart and count; 手伝えるかも carries its words.
// 参加 is a wide button of its own under this row (see joinButton).
const REACTIONS = [
  { kind: 'like', label: 'いいね', icon: 'heart', countKey: 'like_count', tone: 'like', side: 'left' },
  { kind: 'help', label: '手伝えるかも', icon: 'help', countKey: 'help_count', tone: 'help', side: 'right' },
];
const JOIN = { kind: 'join', label: '参加', countKey: 'join_count', tone: 'join' };

/**
 * @param post           the post row
 * @param options.onReact  (kind) => Promise
 * @param options.onEdit / onDelete / onOpenAuthor / onReport / onComments
 * @param options.onSeeParticipants  () => void, shown on 「参加者募集中」 posts
 * @param options.talk  { state, onPress, onWithdraw, onOpenDm } for 「話してみたい」; `state`
 *                      is 'none' | 'pressed' | 'matched' | null (or a function giving one).
 *                      Absent: no button. The button's name is /api/config talk.label.
 * @param options.onSeeReactors  (kind) => void, run when you hold いいね / 手伝えるかも on your own post
 * @param options.compact  drop the image and the footer (used in list contexts)
 */
export function postCard(post, options = {}) {
  const mine = state.account && post.author_id === state.account.id;
  const card = el('article', { className: 'post-card' });
  card.dataset.postId = post.id;

  // --- author row -------------------------------------------------------
  const author = el('button', {
    className: 'post-author',
    attrs: { type: 'button' },
    on: { click: () => options.onOpenAuthor && options.onOpenAuthor(post.author_id) },
  },
    avatar(post, 40),
    el('span', { className: 'post-author-text' },
      el('span', { className: 'post-author-name', text: post.display_name || '' }),
      el('span', { className: 'post-author-time', text: timeAgo(post.created_at) }),
    ),
  );

  const tools = el('div', { className: 'post-tools' });
  if (mine && (options.onEdit || options.onDelete)) {
    tools.append(menu(post, options));
  } else if (options.onReport) {
    tools.append(el('button', {
      className: 'icon-button', attrs: { type: 'button', 'aria-label': '報告' },
      on: { click: () => options.onReport(post) },
    }, icon('more', 20)));
  }
  card.append(el('div', { className: 'post-head' }, author, tools));

  // --- tags -------------------------------------------------------------
  if ((post.tags || []).length) {
    card.append(el('div', { className: 'post-tags' },
      post.tags.map((tag) => el('span', { className: 'tag-badge', text: tag }))));
  }

  // --- body -------------------------------------------------------------
  card.append(el('p', { className: 'post-body', text: post.body || '' }));

  // --- motivation -------------------------------------------------------
  card.append(motivationBar(post.motivation));

  // --- image ------------------------------------------------------------
  if (!options.compact && post.image_path) {
    const url = data.imageUrl(post.image_path);
    if (url) {
      // A plain tap opens the in-app viewer; a middle / modified click keeps the
      // link's own behaviour (a new tab with the picture).
      const link = el('a', {
        attrs: { href: url, rel: 'noopener noreferrer', 'aria-label': '添付画像を全体表示' },
        on: {
          click: (event) => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            openImageViewer({ url, post, options, opener: link });
          },
        },
      },
        el('img', { attrs: { src: url, alt: '添付画像', loading: 'lazy' },
          on: { error: (event) => { event.target.alt = '画像を読み込めませんでした'; } } }));
      card.append(el('div', { className: 'post-image' }, link));
    }
  }

  // --- footer -----------------------------------------------------------
  // The reactions and, on a 「参加者募集中」 post, the button that shows who has
  // joined sit together at the foot of the card (as in the mock), so that the
  // half-open sheet can keep both in view.
  if (!options.compact) {
    const row = footer(post, options);
    const foot = el('div', { className: 'post-footer' }, row);
    if (row.joinButton) foot.append(row.joinButton);
    if (options.onSeeParticipants && isRecruiting(post)) {
      foot.append(el('button', {
        className: 'post-participants-button',
        attrs: { type: 'button' },
        text: '参加者を見てみる',
        on: { click: () => options.onSeeParticipants(post) },
      }));
    }
    if (options.talk) foot.append(talkButton(options.talk));
    card.append(foot);
  }
  if (mine) {
    const views = el('p', { className: 'post-views', attrs: { 'data-views': '' } });
    paintViews(views, post.id);
    card.append(views);
  }
  return card;
}

/**
 * 「話してみたい」: a wide round button under 参加, in the accent colour so it is
 * not mistaken for 参加. Three states - the name, the name with 「（押しました）」
 * and a small line under it, and 「DM を開く」. Pressing again on the second asks
 * before taking it back. It repaints itself when state.talk changes (see the
 * subscription at the top), and stays hidden (null) for people I share no 会 with.
 */
function talkButton(talk) {
  const label = talkLabelOf(config());
  const word = el('span', { className: 'pt-word' });
  const button = el('button', { className: 'post-talk-button', attrs: { type: 'button' } }, word);
  const note = el('p', { className: 'post-talk-note' });
  const wrap = el('div', { className: 'post-talk', attrs: { 'data-talk': '' } }, button, note);
  const current = () => (typeof talk.state === 'function' ? talk.state() : talk.state);

  const paint = () => {
    const now = current();
    wrap.hidden = !now;
    if (!now) return;
    const text = talkButtonText(now, label);
    word.textContent = text.word;
    note.textContent = text.note;
    note.hidden = !text.note;
    button.dataset.state = now;
    button.setAttribute('aria-pressed', String(now === 'pressed'));
  };
  wrap._talkPaint = paint;

  button.addEventListener('click', async () => {
    if (button.dataset.busy) return;
    const now = current();
    button.dataset.busy = '1';
    button.disabled = true;
    try {
      if (now === 'none') {
        button.classList.remove('pop');
        void button.offsetWidth;
        button.classList.add('pop');
        await talk.onPress?.();
      } else if (now === 'pressed') {
        if (await confirmAction(withdrawPrompt(label))) await talk.onWithdraw?.();
      } else if (now === 'matched') {
        talk.onOpenDm?.();
      }
    } finally {
      delete button.dataset.busy;
      button.disabled = false;
      paint();
    }
  });
  paint();
  return wrap;
}

/** Only ever on your own post, and only once somebody has looked. */
function paintViews(node, postId) {
  const count = state.myViews?.[postId] || 0;
  node.hidden = count < 1;
  node.textContent = `👣 ${count}人が見ました`;
}

/** Whether a post carries the 気軽に話しかけて tag (Q45). */
export function isOpen(post) {
  return Boolean(post?.tags?.includes(config().open_tag));
}

function menu(post, options) {
  const wrap = el('div', { className: 'post-menu' });
  const panel = el('div', { className: 'post-menu-panel', attrs: { hidden: true } },
    options.onEdit && el('button', {
      className: 'post-menu-item', attrs: { type: 'button' }, text: '投稿を編集',
      on: { click: () => { close(); options.onEdit(post); } },
    }),
    options.onDelete && el('button', {
      className: 'post-menu-item danger', attrs: { type: 'button' }, text: '投稿を削除',
      on: { click: () => { close(); options.onDelete(post); } },
    }),
  );
  const button = el('button', {
    className: 'icon-button',
    attrs: { type: 'button', 'aria-label': 'この投稿の操作' },
    on: {
      click: (event) => {
        event.stopPropagation();
        const opening = panel.hidden;
        activeMenu?.close();
        panel.hidden = !opening;
        button.setAttribute('aria-expanded', String(opening));
        if (opening) activeMenu = { wrap, close };
      },
    },
  }, icon('more', 20));
  function close() {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    activeMenu = null;
  }
  wrap.append(button, panel);
  return wrap;
}

/** islands' slider, read-only: a gradient bar with a vertical handle. */
function motivationBar(value) {
  const level = Math.max(0, Math.min(100, Number(value) || 0));
  const color = motivationColor(level);
  return el('div', { className: 'motivation' },
    el('div', { className: 'motivation-track' },
      el('div', {
        className: 'motivation-fill',
        style: {
          width: `${level}%`,
          background: `linear-gradient(to right, #e5e7eb, ${color})`,
        },
      }),
      el('div', {
        className: 'motivation-handle',
        style: { left: `calc(${level}% - 2px)`, backgroundColor: color },
      }),
    ),
    el('div', { className: 'motivation-labels' },
      el('span', { text: 'エンジョイ' }),
      el('span', { text: 'ガチ' }),
    ),
  );
}

function footer(post, options) {
  const row = el('div', { className: 'post-actions' });
  const left = el('div', { className: 'post-actions-group' });
  const right = el('div', { className: 'post-actions-group right' });
  row.append(left, right);

  left.append(el('button', {
    className: 'post-action',
    attrs: { type: 'button', 'aria-label': 'メッセージを開く' },
    on: { click: () => options.onComments && options.onComments(post) },
  },
    el('span', { className: 'post-action-icon' }, icon('message', 20)),
    el('span', { className: 'post-action-count num', attrs: { 'data-count': 'comment_count' }, text: post.comment_count || 0 }),
  ));

  // Somebody else's 参加 button on a post that is not recruiting would be a
  // promise nobody asked for. Your own earlier join stays visible and undoable.
  const showJoin = isRecruiting(post) || hasReacted(post.id, 'join');
  const all = showJoin ? [...REACTIONS, JOIN] : REACTIONS;

  all.forEach((reaction) => {
    const isJoin = reaction.kind === 'join';
    const button = isJoin
      ? el('button', {
        className: 'post-join-button reaction join',
        // No aria-label: the words inside (state, terms, how many) are its name.
        attrs: { type: 'button', 'data-reaction': 'join' },
      },
        el('span', { className: 'pj-word' }),
        el('span', { className: 'pj-info' },
          el('span', { className: 'pj-terms' }),
          '現在',
          el('b', { className: 'num', attrs: { 'data-count': reaction.countKey }, text: post[reaction.countKey] || 0 }),
          '人参加'))
      : el('button', {
        className: `post-action reaction ${reaction.tone}`,
        attrs: { type: 'button', 'data-reaction': reaction.kind, 'aria-label': reaction.label },
      },
        el('span', { className: 'post-action-icon' }, icon(reaction.icon, reaction.kind === 'like' ? 20 : 18)),
        reaction.kind === 'like' ? null : el('span', { className: 'post-action-label', text: reaction.label }),
        el('span', { className: 'post-action-count num', attrs: { 'data-count': reaction.countKey }, text: post[reaction.countKey] || 0 }),
      );

    const paint = () => {
      button.classList.toggle('on', hasReacted(post.id, reaction.kind));
      button.setAttribute('aria-pressed', String(hasReacted(post.id, reaction.kind)));
      const count = button.querySelector('[data-count]');
      const current = state.postsById.get(post.id) || post;
      count.textContent = String(current[reaction.countKey] || 0);
      if (reaction.kind === 'join') paintJoin(button, current);
    };
    paint();

    // Holding the button on your own post lists who pressed it. Others' posts
    // get nothing: the button stays an ordinary button.
    if (!isJoin && options.onSeeReactors && state.account && post.author_id === state.account.id) {
      button.classList.add('holdable');
      attachLongPress(button, {
        onPressing: (on) => button.classList.toggle('pressing', on),
        onHold: () => { buzz('react'); options.onSeeReactors(reaction.kind); },
      });
    }

    button.addEventListener('click', async () => {
      if (!options.onReact) return;
      // Joining is a promise to turn up, so it is asked about once; taking it
      // back, and every other reaction, is a single tap.
      if (reaction.kind === 'join' && state.account && !hasReacted(post.id, 'join')) {
        const ok = await confirmAction({
          title: '本当に参加しますか？', confirmLabel: '参加する',
        });
        if (!ok) return;
      }
      if (!hasReacted(post.id, reaction.kind) && state.account) {
        button.classList.remove('pop');
        void button.offsetWidth;
        button.classList.add('pop');
      }
      const wasOn = hasReacted(post.id, reaction.kind);
      button.disabled = true;
      button.dataset.busy = '1';
      try {
        await options.onReact(reaction.kind);
        // A refused join (closed / full) leaves it off; the row we hold is out of
        // date, so read the post again and let the button say why.
        if (reaction.kind === 'join' && !wasOn && !hasReacted(post.id, 'join')) {
          upsertPost(await data.getPost(post.id).catch(() => null));
        }
      } finally {
        delete button.dataset.busy;
        button.disabled = false;
        paint();
      }
    });
    if (isJoin) row.joinButton = button;
    else (reaction.side === 'left' ? left : right).append(button);
  });

  return row;
}
