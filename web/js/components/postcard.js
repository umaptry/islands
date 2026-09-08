// islands' PostCard.
//
// Ported piece for piece: the author row, the tag badges, the body, the
// エンジョイ↔ガチ indicator, the image, and the action footer with comments,
// いいね, 手伝えるかも and 参加したい. The own-post menu (edit / delete) is
// here too - in islands both of its items were an alert() saying the feature
// did not exist.
//
// What is added is the pair of lines かさなり can say and islands could not:
// how alike two posts are, measured in the 448 dimensions before the map
// flattened them, and which words the two people actually share.

import { data } from '../net.js';
import { hasReacted, state, subscribe } from '../state.js';
import { avatar, clip, el, motivationColor, timeAgo } from '../ui.js';
import { icon } from '../icons.js';

// One outside-click listener for every card menu, including cards removed with a sheet.
let activeMenu = null;
document.addEventListener('pointerdown', (event) => {
  if (activeMenu && (!activeMenu.wrap.isConnected || !activeMenu.wrap.contains(event.target))) activeMenu.close();
});

// One subscription for all mounted cards; removed cards retain no subscriptions.
subscribe(() => {
  document.querySelectorAll('.post-card[data-post-id]').forEach((card) => {
    const post = state.postsById.get(card.dataset.postId) || state.myPosts.find((p) => p.id === card.dataset.postId);
    if (!post) return;
    card.querySelectorAll('[data-count]').forEach((node) => { node.textContent = post[node.dataset.count] || 0; });
    card.querySelectorAll('[data-reaction]').forEach((node) => {
      const on = hasReacted(post.id, node.dataset.reaction);
      node.classList.toggle('on', on);
      node.setAttribute('aria-pressed', String(on));
    });
  });
});

const REACTIONS = [
  { kind: 'like', label: 'いいね', icon: '♥', countKey: 'like_count', tone: 'like' },
  { kind: 'help', label: '手伝えるかも', icon: '✋', countKey: 'help_count', tone: 'help' },
  { kind: 'join', label: '参加', icon: '➕', countKey: 'join_count', tone: 'join' },
];

/**
 * @param post           the post row
 * @param options.onReact  (kind) => Promise
 * @param options.onEdit / onDelete / onOpenAuthor / onReport / onComments
 * @param options.similarity { similarity, shared, note } when viewing somebody else
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

  // --- similarity, when this is somebody else's post --------------------

  // --- tags -------------------------------------------------------------
  if ((post.tags || []).length) {
    card.append(el('div', { className: 'post-tags' },
      post.tags.map((tag) => el('span', { className: 'tag-badge', text: tag })),
    ));
  }

  // --- body -------------------------------------------------------------
  card.append(el('p', { className: 'post-body', text: post.body || '' }));

  // --- motivation -------------------------------------------------------
  card.append(motivationBar(post.motivation));

  // --- image ------------------------------------------------------------
  if (!options.compact && post.image_path) {
    const url = data.imageUrl(post.image_path);
    if (url) {
      card.append(el('div', { className: 'post-image' },
        el('a', { attrs: { href: url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': '添付画像を全体表示' } },
          el('img', { attrs: { src: url, alt: '添付画像', loading: 'lazy' },
            on: { error: (event) => { event.target.alt = '画像を読み込めませんでした'; } } }))));
    }
  }

  // --- footer -----------------------------------------------------------
  if (!options.compact) card.append(footer(post, options));
  if (options.similarity && typeof options.similarity.similarity === 'number') {
    const detail = el('details', { className: 'similarity-details' },
      el('summary', { text: `似てる度 ${options.similarity.similarity}%・共通点を見る` }), similarityBlock(options.similarity));
    card.append(detail);
  }

  return card;
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
      el('span', {},
        el('span', { text: 'エンジョイ' }),
        el('span', { className: 'motivation-sub', text: 'casual' }),
      ),
      el('span', {},
        el('span', { text: 'ガチ' }),
        el('span', { className: 'motivation-sub', text: 'hardcore' }),
      ),
    ),
  );
}

function similarityBlock({ similarity, shared, note }) {
  const block = el('div', { className: 'similarity' });
  block.append(
    el('div', { className: 'similarity-head' },
      el('span', { className: 'similarity-value num', text: `${similarity}%` }),
      el('span', { className: 'similarity-label', text: '似てる度' }),
    ),
    el('div', { className: 'similarity-bar' },
      el('div', { className: 'similarity-fill', style: { width: '0%' } })),
  );
  requestAnimationFrame(() => {
    const fill = block.querySelector('.similarity-fill');
    if (fill) fill.style.width = `${Math.max(2, similarity)}%`;
  });

  if (shared && shared.length) {
    block.append(el('div', { className: 'chips' },
      shared.map((word) => el('span', { className: 'chip', text: word }))));
  } else if (note) {
    block.append(el('p', { className: 'similarity-note', text: note }));
  }
  // Otherwise a high number next to somebody drawn on the far side of the map
  // reads as a bug rather than as the two different things they are.
  block.append(el('p', {
    className: 'similarity-foot',
    text: '似てる度は文章の意味の近さです。地図上の距離とは異なる場合があります。',
  }));
  return block;
}

function footer(post, options) {
  const row = el('div', { className: 'post-actions' });

  row.append(el('button', {
    className: 'post-action',
    attrs: { type: 'button', 'aria-label': 'メッセージを開く' },
    on: { click: () => options.onComments && options.onComments(post) },
  },
    el('span', { className: 'post-action-icon' }, icon('message', 20)),
    el('span', { className: 'post-action-count num', attrs: { 'data-count': 'comment_count' }, text: post.comment_count || 0 }),
  ));

  REACTIONS.forEach((reaction) => {
    const button = el('button', {
      className: `post-action reaction ${reaction.tone}`,
      attrs: { type: 'button', 'data-reaction': reaction.kind, 'aria-label': reaction.label },
    },
      el('span', { className: 'post-action-icon' }, icon({ like: 'heart', help: 'help', join: 'hand' }[reaction.kind], 20)),
      el('span', { className: 'post-action-label', text: reaction.label }),
      el('span', { className: 'post-action-count num', attrs: { 'data-count': reaction.countKey }, text: post[reaction.countKey] || 0 }),
    );

    const paint = () => {
      button.classList.toggle('on', hasReacted(post.id, reaction.kind));
      button.setAttribute('aria-pressed', String(hasReacted(post.id, reaction.kind)));
      const count = button.querySelector('.post-action-count');
      const current = state.postsById.get(post.id) || post;
      count.textContent = String(current[reaction.countKey] || 0);
    };
    paint();

    button.addEventListener('click', async () => {
      if (!options.onReact) return;
      button.disabled = true;
      try {
        await options.onReact(reaction.kind);
      } finally {
        button.disabled = false;
        paint();
      }
    });
    row.append(button);
  });

  return row;
}

/** A compact row for lists: reveal, profile tabs, notification targets. */
export function postRow(post, { onClick, trailing } = {}) {
  const row = el('button', {
    className: 'list-row',
    attrs: { type: 'button' },
    on: { click: () => onClick && onClick(post) },
  },
    avatar(post, 40),
    el('div', { className: 'list-row-body' },
      el('div', { className: 'list-row-title', text: post.display_name || '' }),
      el('div', { className: 'list-row-sub', text: clip(post.body || '', 42) }),
    ),
    trailing || null,
  );
  return row;
}
