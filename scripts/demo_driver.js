/* デモの操作部。app.js より後に読み込む。
 *
 * app.js を classic script として読んでいるので、そこの `const state` と
 * `let orbitCache` は共有のグローバル字句スコープにある。だからここから素の名前で
 * 触れる（iframe も eval も要らない）。関数宣言は window にも乗る。 */
(() => {
  const D = window.__DEMO;
  const bundle = D.bundle;
  const engine = window.__demoEngine;
  const islandOf = window.__demoIslandOf;

  const bar = document.getElementById('demobar');
  const engineSelect = document.getElementById('demoEngine');
  const viewerSelect = document.getElementById('demoViewer');

  function measureBar() {
    // レイアウトが決まる前に測ると、折り返しだらけの高さを掴んでしまう。
    requestAnimationFrame(() => {
      document.documentElement.style.setProperty('--demobar-h', `${bar.offsetHeight}px`);
    });
  }

  Object.entries(bundle.engines).forEach(([key, value]) => {
    engineSelect.appendChild(Object.assign(document.createElement('option'), {
      value: key, textContent: value.label,
    }));
  });

  bundle.order.forEach((id) => {
    const profile = bundle.profiles[id];
    viewerSelect.appendChild(Object.assign(document.createElement('option'), {
      value: id, textContent: `${profile.name}｜${profile.text.slice(0, 16)}…`,
    }));
  });

  // ビューの切り替えはタブのクリックハンドラ（web/app.js:527）にしかない。
  // switchTo() は「自分の投稿を切り替える」別物なので、ここから呼んでも何も起きない。
  function showView(name) {
    const tab = document.querySelector(`.tab[data-view="${name}"]`);
    if (tab && state.view !== name) tab.click();
  }
  window.__demoShowView = showView;

  /* 誰の視点で見るか。localStorage は使わない。boot() は保存が空だと intro を
     出して一度も通信しないので、state を直接組んで enterMain() を呼ぶのが一番
     きれいで、file:// の localStorage 制限も踏まない。 */
  async function beViewer(id) {
    const E = engine();
    const profile = bundle.profiles[id];
    const at = E.positions[id];
    D.viewer = id;
    // 選んだ1人だけを myPosts に入れる。全員入れると mine() が全員 true になり、
    // 画面上の全アバターが「自分の投稿」として描かれてしまう。
    state.myPosts = [{
      id, edit_token: 'demo', icon_id: profile.icon_id, name: profile.name,
    }];
    state.me = {
      ...profile, ...at, island: islandOf(E, at.cluster_id), edit_token: 'demo',
    };
    state.liked = new Set();
    state.notified = new Set();
    state.inboxReady = false;
    state.selected = null;
    orbitCache.key = '';
    closeSheet();
    await enterMain();
    // enterMain の中の refreshMap を待っている間に rAF が1フレーム描き、古い
    // state.map で周回ビューを組み直してキャッシュに載せてしまう。地図が入れ替わった
    // 「あと」にもう一度潰さないと、表示が1手ぶん遅れる。
    orbitCache.key = '';
  }

  async function setEngine(key) {
    D.engine = key;
    const E = engine();
    const id = state.me.id;
    const at = E.positions[id];
    // orbitCache のキーは similarity の「有無」しか見ていない（web/app.js:614）。
    // 潰しておかないと切り替えてもキーが一致してしまい、周回ビューの輪が動かない。
    orbitCache.key = '';
    // 自分の座標も差し替える。忘れると地図を引き直したときに、全員が
    // 「元の位置にいる幽霊」を周回することになる。
    state.me = { ...state.me, ...at, island: islandOf(E, at.cluster_id) };
    state.selected = null;
    closeSheet();
    await refreshMap();
    // refreshMap を待つ間に rAF が古い similarity でキャッシュを埋め直しているので、
    // 新しい state.map が入ったこの時点でもう一度潰す。前だけだと1手遅れる。
    orbitCache.key = '';
    syncMyIsland();
    updateIslandBadge();
    if (state.view === 'map') fitCamera();  // 地図を引き直すエンジンでは範囲が変わる
  }

  engineSelect.addEventListener('change', (event) => setEngine(event.target.value));
  viewerSelect.addEventListener('change', (event) => beViewer(event.target.value));
  window.addEventListener('resize', measureBar);

  /* ボトムシートの注記は app.js に「448次元で測っています」と直接書かれている
     （web/app.js:1419）。エンジンによっては嘘になるので、シートが描かれたら
     差し替える。app.js 側には手を入れず、出てきた DOM を見て直す。 */
  new MutationObserver(() => {
    const note = document.querySelector('#sheetBody .sim-note');
    const text = engine().sheet_note;
    if (note && text && note.textContent !== text) note.textContent = text;
  }).observe(document.getElementById('sheetBody'), { childList: true, subtree: true });

  /* ---- 自己点検（?selftest=1 か window.__demoSelftest()）------------------ */

  async function selftest() {
    const rows = [];
    for (const viewer of bundle.order.slice(0, 3)) {
      await beViewer(viewer);
      const radii = {};
      for (const key of Object.keys(bundle.engines)) {
        await setEngine(key);
        // 切り替え後、自分の座標がそのエンジンのものになっているか
        const at = engine().positions[state.me.id];
        rows.push({
          視点: bundle.profiles[viewer].name, エンジン: key,
          自分の座標: state.me.x === at.x && state.me.y === at.y ? 'OK' : 'NG',
        });
        // rAF が止まっている環境（非表示のプレビュー等）でも成立するように、
        // 半径を読む前に自分で1フレーム描かせる。
        showView('orbit');
        renderOrbit();
        radii[key] = orbitCache.placed.map((p) => Math.round(p.radius));
      }
      // 切り替えたら周回ビューの半径が実際に動いているか
      const keys = Object.keys(radii);
      keys.slice(1).forEach((key) => {
        const moved = radii[key].some((r, i) => r !== radii[keys[0]][i]);
        rows.push({
          視点: bundle.profiles[viewer].name, エンジン: `${keys[0]}→${key}`,
          輪が動く: moved ? 'OK' : 'NG',
        });
      });
    }
    console.table(rows);
    const failed = rows.filter((r) => (r.輪が動く || r.自分の座標 || '').startsWith('NG'));
    console.log(failed.length ? `[NG] ${failed.length} 件失敗` : '[OK] 自己点検すべて通過');
    window.__selftest = { rows, failed: failed.length };
    engineSelect.value = D.engine;
    viewerSelect.value = D.viewer;
    return failed.length;
  }
  window.__demoSelftest = selftest;

  engineSelect.value = D.engine;
  viewerSelect.value = D.viewer;
  beViewer(D.viewer).then(() => {
    measureBar();
    if (new URLSearchParams(location.search).get('selftest') === '1') selftest();
  });
})();
