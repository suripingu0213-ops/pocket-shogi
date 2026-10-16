// 探索を別スレッドで動かす（画面を固まらせないため）
importScripts('shogi_engine.js');
const E = self.ShogiEngine;
const searcher = new E.Searcher(19);

// 学習済みの評価関数（強い将棋ソフトの棋譜から学習した「玉の位置×駒の位置」の点数表）。
// 読み込めなければ手作りの評価関数で指す。
const ready = fetch('eval.bin')
  .then(r => (r.ok ? r.arrayBuffer() : null))
  .then(buf => { if (buf) searcher.kp = E.loadKPWeights(buf); })
  .catch(() => {});

// 対局データベース（PCの自己対局・floodgate の棋譜から作った book.json）。AIが指す時だけ読み込む
let book = null, bookTried = false;
function loadBook() {
  if (bookTried) return Promise.resolve();
  bookTried = true;
  return fetch('book.json').then(r => (r.ok ? r.json() : null)).then(j => { if (j) book = j.d; }).catch(() => {});
}
const mateSolver = new E.MateSolver(18);
const posKey = pos => (pos.h1 >>> 0).toString(16).padStart(8, '0') + (pos.h2 >>> 0).toString(16).padStart(8, '0');

function replay(sfen, moves, upto) {
  const pos = new E.Position(sfen);
  for (let i = 0; i < upto; i++) {
    const m = E.parseUSI(pos, moves[i]);
    if (!m) break;
    pos.make(m);
  }
  return pos;
}

self.onmessage = (e) => { ready.then(() => handle(e.data)); };

function handle(d) {
  if (d.ana) {
    // 振り返り: 指定された各局面を解析し、先手から見た評価値と推奨手を返す
    const plies = d.plies.slice().sort((a, b) => a - b);
    const pos = new E.Position(d.sfen);
    let cur = 0;
    for (const ply of plies) {
      while (cur < ply) {
        const m = E.parseUSI(pos, d.moves[cur]);
        if (!m) break;
        pos.make(m); cur++;
      }
      const r = searcher.search(pos, { timeMs: d.timeMs });
      const sc = r.declare ? E.MATE : r.score;
      self.postMessage({ ana: true, id: d.id, ply, s: pos.side === 0 ? sc : -sc, best: r.move ? E.moveToUSI(r.move) : null });
    }
    self.postMessage({ ana: true, id: d.id, done: true });
    return;
  }
  if (d.hint) { loadBook().then(() => hint(d)); return; }

  if (d.cand) {
    // 振り返り: 候補手だけを対局と同じ思考時間で全幅に読み、各手の評価値（先手から見た値）を返す
    const pos = replay(d.sfen, d.moves, d.moves.length);
    const only = d.cands.map(u => E.parseUSI(pos, u)).filter(Boolean);
    const r = searcher.search(pos, { timeMs: d.timeMs, only, multi: true });
    for (const [m, sc] of r.scores || []) {
      self.postMessage({ cand: true, id: d.id, usi: E.moveToUSI(m), s: pos.side === 0 ? sc : -sc });
    }
    self.postMessage({ cand: true, id: d.id, done: true });
    return;
  }
  loadBook().then(() => aiMove(d));
}

// 対局中の候補手: まず詰み（詰み探索・データベースの詰み証明）を確かめ、
// 次に上位 k 手を読んで、深さが1段進むごとに途中経過を返す（評価値は先手から見た値）
function hint(d) {
  const pos = replay(d.sfen, d.moves, d.moves.length);
  const mr = mateSolver.solve(pos, { nodeLimit: 100000 });
  let mate = null;
  if (mr.mate) mate = { usi: E.moveToUSI(mr.move), length: mr.length, src: 'search' };
  else {
    const b = book && book[posKey(pos)];
    if (b && b[1] === 1) mate = { usi: b[0], length: 0, src: 'db' };
  }
  if (mate) self.postMessage({ hint: true, id: d.id, mate });
  else {
    // データベースで決まる手（AIはこれを評価値より優先する）を候補手の欄に見せる
    const b = book && book[posKey(pos)];
    if (b && (b[1] === 2 || b[2])) {
      self.postMessage({ hint: true, id: d.id, db: {
        pick: b[1] === 2 ? b[0] : null, wins: b[3] || 0,
        bad: b[2] ? b[2].split(' ').map(x => { const [u, l] = x.split(':'); return [u, +(l || 1)]; }) : [],
      } });
    }
  }
  const toList = top => top.map(([m, sc]) => [E.moveToUSI(m), pos.side === 0 ? sc : -sc]);
  const r = searcher.search(pos, {
    timeMs: d.timeMs, multiPV: d.k,
    onInfo: info => self.postMessage({ hint: true, id: d.id, depth: info.depth, list: toList(info.top) }),
  });
  self.postMessage({ hint: true, id: d.id, done: true, depth: r.depth, list: toList(r.top || []) });
}

// AIの1手（設計どおりの順番）
// 1. 詰み探索で勝ちが証明できる手 2. データベースで詰みが証明済みの手 3. データベースで勝率100%の手
// 4. AIの探索（データベースで負けしかない手は、他に手があれば候補から外す）
function aiMove(d) {
  const pos = replay(d.sfen, d.moves, d.moves.length);
  const post = (move, score, how, extra) => self.postMessage(Object.assign({ id: d.id, move, declare: false, score, how }, extra || {}));
  const mr = mateSolver.solve(pos, { nodeLimit: 30000 });
  if (mr.mate) { post(E.moveToUSI(mr.move), E.MATE - (mr.length || 1), 'mate', { mateLen: mr.length }); return; }
  const b = book && book[posKey(pos)];
  if (b && b[1]) {
    const m = E.parseUSI(pos, b[0]);
    if (m) {
      // 評価値の表示用に、その手だけを短く読む
      const r = searcher.search(pos, { timeMs: Math.min(1500, d.opts.timeMs || 1500), only: [m] });
      post(b[0], b[1] === 1 ? E.MATE - 1 : r.score, b[1] === 1 ? 'proven' : 'db100');
      return;
    }
  }
  let only;
  if (b && b[2]) {
    const bad = new Set(b[2].split(' ').map(x => x.split(':')[0]));
    only = pos.legalMoves().filter(m => !bad.has(E.moveToUSI(m)));
    if (!only.length) only = undefined;
  }
  const r = searcher.search(pos, Object.assign({}, d.opts, { only }));
  self.postMessage({ id: d.id, move: r.move ? E.moveToUSI(r.move) : null, declare: !!r.declare, score: r.score, depth: r.depth, nodes: r.nodes, how: only ? 'search-db' : 'search' });
}
