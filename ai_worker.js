// 探索を別スレッドで動かす（画面を固まらせないため）
importScripts('shogi_engine.js');
const E = self.ShogiEngine;
const searcher = new E.Searcher(19);

self.onmessage = (e) => {
  const { id, sfen, moves, opts } = e.data;
  const pos = new E.Position(sfen);
  for (const u of moves) {
    const m = E.parseUSI(pos, u);
    if (!m) break;
    pos.make(m);
  }
  const r = searcher.search(pos, opts);
  self.postMessage({ id, move: r.move ? E.moveToUSI(r.move) : null, declare: !!r.declare, score: r.score, depth: r.depth, nodes: r.nodes });
};
