// 探索を別スレッドで動かす（画面を固まらせないため）
importScripts('shogi_engine.js');
const E = self.ShogiEngine;
const searcher = new E.Searcher(19);

function replay(sfen, moves, upto) {
  const pos = new E.Position(sfen);
  for (let i = 0; i < upto; i++) {
    const m = E.parseUSI(pos, moves[i]);
    if (!m) break;
    pos.make(m);
  }
  return pos;
}

self.onmessage = (e) => {
  const d = e.data;
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
  if (d.cand) {
    // 振り返り: 候補手を1手ずつ指して局面を読み、先手から見た評価値を返す
    const pos = replay(d.sfen, d.moves, d.moves.length);
    for (const u of d.cands) {
      const m = E.parseUSI(pos, u);
      if (!m) continue;
      pos.make(m);
      const r = searcher.search(pos, { timeMs: d.timeMs });
      const sc = r.declare ? E.MATE : r.score;
      self.postMessage({ cand: true, id: d.id, usi: u, s: pos.side === 0 ? sc : -sc });
      pos.unmake();
    }
    self.postMessage({ cand: true, id: d.id, done: true });
    return;
  }
  const pos = replay(d.sfen, d.moves, d.moves.length);
  const r = searcher.search(pos, d.opts);
  self.postMessage({ id: d.id, move: r.move ? E.moveToUSI(r.move) : null, declare: !!r.declare, score: r.score, depth: r.depth, nodes: r.nodes });
};
