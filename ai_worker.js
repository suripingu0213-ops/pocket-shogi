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
  const pos = replay(d.sfen, d.moves, d.moves.length);
  const r = searcher.search(pos, d.opts);
  self.postMessage({ id: d.id, move: r.move ? E.moveToUSI(r.move) : null, declare: !!r.declare, score: r.score, depth: r.depth, nodes: r.nodes });
};
