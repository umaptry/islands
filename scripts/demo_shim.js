/* 通信だけを焼き込んだデータに差し替える層。app.js より前に読み込む。
 *
 * app.js の通信は api(path, options)（web/app.js:138）1か所に集約されていて、
 * それが fetch(path, ...) を呼んで .json() するだけなので、fetch を差し替えれば
 * アプリ側のロジックには1行も触らずに済む。返すオブジェクトは api() が触る
 * {ok, status, json} の3つだけあればよい。 */
(() => {
  const bundle = JSON.parse(document.getElementById('demo-bundle').textContent);
  const D = window.__DEMO = {
    bundle,
    engine: Object.keys(bundle.engines)[0],
    viewer: bundle.order[0],
  };

  const engine = () => bundle.engines[D.engine];
  const islandOf = (E, clusterId) => E.islands.find((i) => i.id === clusterId) || null;
  window.__demoEngine = engine;
  window.__demoIslandOf = islandOf;

  const reply = (payload, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => payload,
  });

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : String(input && input.url || input);
    if (!url.startsWith('/api/')) return realFetch(input, options);

    // ローディング表示が一瞬で消えると挙動が読み取れないので、ごく短い間だけ待つ。
    await new Promise((resolve) => setTimeout(resolve, 40));

    const [path, query] = url.split('?');
    const params = new URLSearchParams(query || '');
    const E = engine();

    if (path === '/api/map') {
      const viewer = params.get('viewer') || '';
      const payload = {
        seed_bounds: E.seed_bounds,
        islands: E.islands,
        users: bundle.order.map((id) => ({
          id,
          icon_id: bundle.profiles[id].icon_id,
          name: bundle.profiles[id].name,
          created_at: bundle.profiles[id].created_at,
          ...E.positions[id],
        })),
        like_counts: bundle.like_counts,
        quantiles: bundle.quantiles,
        meta: bundle.meta,
      };
      // 本番も自分自身は表に入れない（app.py:355-360）。viewer が空なら
      // similarity キー自体を出さない。
      if (viewer && E.sim[viewer]) {
        payload.similarity = {};
        bundle.order.forEach((id) => {
          if (id !== viewer) payload.similarity[id] = E.sim[viewer][id];
        });
      }
      return reply(payload);
    }

    const single = path.match(/^\/api\/user\/(.+)$/);
    if (single) {
      const id = decodeURIComponent(single[1]);
      const profile = bundle.profiles[id];
      if (!profile) return reply({ detail: '見つかりませんでした。' }, 404);
      const at = E.positions[id];
      const out = {
        id,
        icon_id: profile.icon_id,
        name: profile.name,
        text: profile.text,
        x: at.x,
        y: at.y,
        cluster_id: at.cluster_id,
        island: islandOf(E, at.cluster_id),
      };
      const viewer = params.get('viewer') || '';
      if (viewer && viewer !== id && E.positions[viewer]) {
        const me = E.positions[viewer];
        out.distance = Math.round(Math.hypot(me.x - at.x, me.y - at.y) * 100) / 100;
        out.similarity = E.sim[viewer][id];
        out.shared = bundle.shared[viewer][id];
        out.note = bundle.noteTable[E.note[viewer][id]];
      }
      return reply(out);
    }

    // 実データの like 数をそのまま返すのが必須。app.js:475 が
    // state.map.like_counts をこの counts で丸ごと置き換えるため。
    if (path === '/api/inbox') {
      return reply({ received: [], given: [], counts: bundle.like_counts });
    }

    if (path === '/api/like') {
      const body = JSON.parse(options.body || '{}');
      const total = (bundle.like_counts[body.to_id] || 0) + 1;
      bundle.like_counts[body.to_id] = total;
      return reply({ ok: true, created: true, total });
    }

    if (path === '/api/join' || path === '/api/leave') {
      return reply({
        detail: 'このデモでは投稿できません。既にある投稿の見え方を比べる画面です。',
      }, 400);
    }

    return reply({ detail: `デモでは未対応の呼び出しです: ${path}` }, 404);
  };
})();
