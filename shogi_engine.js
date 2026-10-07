/*
 * 将棋エンジン（ルール判定 + 探索AI）
 * 依存なし。ブラウザ / Web Worker / Node のどれでも動く。
 *
 * ルールの根拠: 日本将棋連盟「対局規則」 https://www.shogi.or.jp/match/taikyoku_rules/
 *   - 反則: 二歩 / 打ち歩詰め / 行き所のない駒(指す・打つ) / 王手放置・自玉を利きに動かす
 *           (二手指し・待ったは手番管理で起こり得ないので合法手生成で自動的に排除)
 *   - 成り: 移動前か移動後が敵陣(3段目以内)なら成れる。成駒は戻らない。成った状態で打てない。
 *   - 千日手: 盤面・双方の持ち駒・手番が同一の局面が4回 → 無勝負(指し直し)
 *   - 連続王手の千日手: その一連の手順中、片方の手がすべて王手 → 王手を続けた側の負け
 *   - 持将棋: 500手に達したら無勝負
 *   - 入玉宣言法: 手番側が宣言。(1)玉が敵陣3段目以内 (2)敵陣内の自駒が玉を除き10枚以上
 *                 (3)王手がかかっていない (4)敵陣内の自駒+持ち駒を大駒5点・小駒1点で数え
 *                 31点以上で勝ち、24〜30点は指し直し。条件を満たさない宣言は宣言側の負け。
 *   - 指せる手がない(詰み) → 手番側の負け
 *
 * 座標: sq = row*9 + col。row 0 = 一段目、col 0 = ９筋（先手から見て左上が 9一）。
 * 駒: 正 = 先手(▲)、負 = 後手(△)。
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- 駒
  const FU = 1, KY = 2, KE = 3, GI = 4, KI = 5, KA = 6, HI = 7, OU = 8,
        TO = 9, NY = 10, NK = 11, NG = 12, UM = 13, RY = 14;
  const BLACK = 0, WHITE = 1;
  const PROMOTE   = [0, TO, NY, NK, NG, 0, UM, RY, 0, 0, 0, 0, 0, 0, 0];
  const UNPROMOTE = [0, FU, KY, KE, GI, KI, KA, HI, OU, FU, KY, KE, GI, KA, HI];
  const PIECE_KANJI = ['', '歩', '香', '桂', '銀', '金', '角', '飛', '玉', 'と', '成香', '成桂', '成銀', '馬', '龍'];
  const PIECE_KANJI1 = ['', '歩', '香', '桂', '銀', '金', '角', '飛', '玉', 'と', '杏', '圭', '全', '馬', '龍'];
  const SFEN_CHAR = ['', 'P', 'L', 'N', 'S', 'G', 'B', 'R', 'K', '+P', '+L', '+N', '+S', '+B', '+R'];

  // 8方向（先手視点）。0:左上 1:上 2:右上 3:左 4:右 5:左下 6:下 7:右下。後手は d → 7-d。
  const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const GOLD_D = [0, 1, 2, 3, 4, 6];
  const STEP_D = [];
  STEP_D[FU] = [1]; STEP_D[KY] = []; STEP_D[KE] = []; STEP_D[GI] = [0, 1, 2, 5, 7];
  STEP_D[KI] = GOLD_D; STEP_D[KA] = []; STEP_D[HI] = []; STEP_D[OU] = [0, 1, 2, 3, 4, 5, 6, 7];
  STEP_D[TO] = GOLD_D; STEP_D[NY] = GOLD_D; STEP_D[NK] = GOLD_D; STEP_D[NG] = GOLD_D;
  STEP_D[UM] = [1, 3, 4, 6]; STEP_D[RY] = [0, 2, 5, 7];
  const SLIDE_D = [];
  for (let pt = 0; pt <= RY; pt++) SLIDE_D[pt] = [];
  SLIDE_D[KY] = [1]; SLIDE_D[KA] = [0, 2, 5, 7]; SLIDE_D[HI] = [1, 3, 4, 6];
  SLIDE_D[UM] = [0, 2, 5, 7]; SLIDE_D[RY] = [1, 3, 4, 6];

  const STEP_LIST = [[], []], SLIDE_LIST = [[], []], STEP_MASK = [[], []], SLIDE_MASK = [[], []];
  for (let s = 0; s < 2; s++) {
    for (let pt = 0; pt <= RY; pt++) {
      const st = (STEP_D[pt] || []).map(d => s ? 7 - d : d);
      const sl = SLIDE_D[pt].map(d => s ? 7 - d : d);
      STEP_LIST[s][pt] = st; SLIDE_LIST[s][pt] = sl;
      STEP_MASK[s][pt] = st.reduce((m, d) => m | (1 << d), 0);
      SLIDE_MASK[s][pt] = sl.reduce((m, d) => m | (1 << d), 0);
    }
  }

  // RAY[sq*8+d] = その方向に並ぶ升の配列
  const RAY = new Array(81 * 8);
  for (let sq = 0; sq < 81; sq++) {
    const r0 = (sq / 9) | 0, c0 = sq % 9;
    for (let d = 0; d < 8; d++) {
      const list = [];
      let r = r0 + DIRS[d][0], c = c0 + DIRS[d][1];
      while (r >= 0 && r < 9 && c >= 0 && c < 9) { list.push(r * 9 + c); r += DIRS[d][0]; c += DIRS[d][1]; }
      RAY[sq * 8 + d] = list;
    }
  }
  // 桂: KNIGHT_TO[s][sq] = 行き先、KNIGHT_FROM[s][sq] = sq に利いている s の桂の位置
  const KNIGHT_TO = [[], []], KNIGHT_FROM = [[], []];
  for (let sq = 0; sq < 81; sq++) {
    const r = (sq / 9) | 0, c = sq % 9;
    for (let s = 0; s < 2; s++) {
      const dr = s ? 2 : -2;
      const to = [], from = [];
      for (const dc of [-1, 1]) {
        const tr = r + dr, tc = c + dc;
        if (tr >= 0 && tr < 9 && tc >= 0 && tc < 9) to.push(tr * 9 + tc);
        const fr = r - dr, fc = c - dc;
        if (fr >= 0 && fr < 9 && fc >= 0 && fc < 9) from.push(fr * 9 + fc);
      }
      KNIGHT_TO[s][sq] = to; KNIGHT_FROM[s][sq] = from;
    }
  }
  const DIST = new Int8Array(81 * 81);
  for (let a = 0; a < 81; a++) for (let b = 0; b < 81; b++)
    DIST[a * 81 + b] = Math.max(Math.abs(((a / 9) | 0) - ((b / 9) | 0)), Math.abs(a % 9 - b % 9));

  // 先手から見た段（0 = 敵陣最奥）
  function relRow(s, sq) { const r = (sq / 9) | 0; return s ? 8 - r : r; }

  // ---------------------------------------------------------------- Zobrist
  let seed = 0x9E3779B9 | 0;
  function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; }
  const ZP1 = new Int32Array(29 * 81), ZP2 = new Int32Array(29 * 81);
  for (let i = 0; i < ZP1.length; i++) { ZP1[i] = rnd(); ZP2[i] = rnd(); }
  const ZH1 = new Int32Array(2 * 8 * 19), ZH2 = new Int32Array(2 * 8 * 19);
  for (let i = 0; i < ZH1.length; i++) { ZH1[i] = rnd(); ZH2[i] = rnd(); }
  const ZS1 = rnd(), ZS2 = rnd();

  // ---------------------------------------------------------------- 指し手
  // m = from | to<<7 | promote<<14。打つ手は from = 80 + 駒種(81..87)。m = 0 はパス(探索のnull move用)。
  const mkMove = (from, to, pr) => from | (to << 7) | (pr << 14);
  const mFrom = m => m & 127, mTo = m => (m >> 7) & 127, mPromo = m => (m >> 14) & 1;
  const isDrop = m => (m & 127) > 80;

  const MAXPLY = 4096;
  const MAXMOVES = 1024;
  const START_SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

  // ---------------------------------------------------------------- 局面
  class Position {
    constructor(sfen) {
      this.board = new Int8Array(81);
      this.hand = [new Int8Array(8), new Int8Array(8)];
      this.side = BLACK;
      this.king = [-1, -1];
      this.h1 = 0; this.h2 = 0;
      this.ply = 0;
      this.stMove = new Int32Array(MAXPLY);
      this.stCap = new Int8Array(MAXPLY);
      this.stK1 = new Int32Array(MAXPLY);
      this.stK2 = new Int32Array(MAXPLY);
      this.stCheck = new Uint8Array(MAXPLY); // その手で王手をかけたか
      this._buf = [];                          // hasLegalMove 用（再帰の深さごと）
      this._depth = 0;
      this.setSFEN(sfen || START_SFEN);
    }

    clone() { const p = new Position(this.toSFEN()); return p; }

    // ---- SFEN
    setSFEN(sfen) {
      const parts = sfen.trim().split(/\s+/);
      this.board.fill(0); this.hand[0].fill(0); this.hand[1].fill(0);
      this.king = [-1, -1];
      let row = 0, col = 0, promo = false;
      for (const ch of parts[0]) {
        if (ch === '/') { row++; col = 0; continue; }
        if (ch === '+') { promo = true; continue; }
        if (ch >= '1' && ch <= '9') { col += +ch; continue; }
        let pt = 'PLNSGBRK'.indexOf(ch.toUpperCase()) + 1;
        if (pt <= 0) throw new Error('SFEN不正: ' + ch);
        if (promo) { pt = PROMOTE[pt]; promo = false; }
        const sq = row * 9 + col;
        this.board[sq] = ch === ch.toUpperCase() ? pt : -pt;
        if (pt === OU) this.king[ch === ch.toUpperCase() ? 0 : 1] = sq;
        col++;
      }
      this.side = (parts[1] || 'b') === 'w' ? WHITE : BLACK;
      const hs = parts[2] || '-';
      if (hs !== '-') {
        let num = 0;
        for (const ch of hs) {
          if (ch >= '0' && ch <= '9') { num = num * 10 + +ch; continue; }
          const pt = 'PLNSGBR'.indexOf(ch.toUpperCase()) + 1;
          if (pt <= 0) throw new Error('SFEN持ち駒不正: ' + ch);
          this.hand[ch === ch.toUpperCase() ? 0 : 1][pt] += num || 1;
          num = 0;
        }
      }
      this.ply = 0;
      this.startMoveNumber = +(parts[3] || 1);
      this.rehash();
    }

    toSFEN() {
      let s = '';
      for (let r = 0; r < 9; r++) {
        let empty = 0;
        for (let c = 0; c < 9; c++) {
          const p = this.board[r * 9 + c];
          if (!p) { empty++; continue; }
          if (empty) { s += empty; empty = 0; }
          const ch = SFEN_CHAR[Math.abs(p)];
          s += p > 0 ? ch : ch.toLowerCase();
        }
        if (empty) s += empty;
        if (r < 8) s += '/';
      }
      let h = '';
      for (let side = 0; side < 2; side++)
        for (const pt of [HI, KA, KI, GI, KE, KY, FU]) {
          const n = this.hand[side][pt];
          if (!n) continue;
          const ch = SFEN_CHAR[pt];
          h += (n > 1 ? n : '') + (side ? ch.toLowerCase() : ch);
        }
      return `${s} ${this.side ? 'w' : 'b'} ${h || '-'} ${this.startMoveNumber + this.ply}`;
    }

    rehash() {
      let h1 = 0, h2 = 0;
      for (let sq = 0; sq < 81; sq++) {
        const p = this.board[sq];
        if (p) { h1 ^= ZP1[(p + 14) * 81 + sq]; h2 ^= ZP2[(p + 14) * 81 + sq]; }
      }
      for (let s = 0; s < 2; s++) for (let pt = 1; pt <= 7; pt++) {
        const i = (s * 8 + pt) * 19 + this.hand[s][pt];
        h1 ^= ZH1[i]; h2 ^= ZH2[i];
      }
      if (this.side) { h1 ^= ZS1; h2 ^= ZS2; }
      this.h1 = h1; this.h2 = h2;
    }

    _handAdd(s, pt, delta) {
      const base = (s * 8 + pt) * 19, n = this.hand[s][pt];
      this.h1 ^= ZH1[base + n] ^ ZH1[base + n + delta];
      this.h2 ^= ZH2[base + n] ^ ZH2[base + n + delta];
      this.hand[s][pt] = n + delta;
    }
    _hashPiece(sq, p) { this.h1 ^= ZP1[(p + 14) * 81 + sq]; this.h2 ^= ZP2[(p + 14) * 81 + sq]; }

    // ---- 利き判定: sq に by 側の駒が利いているか
    isAttacked(sq, by) {
      if (sq < 0) return false;
      const b = this.board;
      for (let d = 0; d < 8; d++) {
        const ray = RAY[sq * 8 + d];
        const rd = 7 - d; // 駒から sq への向き
        for (let i = 0; i < ray.length; i++) {
          const p = b[ray[i]];
          if (!p) continue;
          if ((p > 0 ? 0 : 1) === by) {
            const pt = p > 0 ? p : -p;
            if (i === 0 && (STEP_MASK[by][pt] & (1 << rd))) return true;
            if (SLIDE_MASK[by][pt] & (1 << rd)) return true;
          }
          break;
        }
      }
      const kn = by ? -KE : KE;
      const kf = KNIGHT_FROM[by][sq];
      for (let i = 0; i < kf.length; i++) if (b[kf[i]] === kn) return true;
      return false;
    }

    inCheck() { return this.isAttacked(this.king[this.side], this.side ^ 1); }

    // ---- 疑似合法手生成（自玉の安全と打ち歩詰めは make 後に isLegalAfterMake で判定）
    // capturesOnly: 駒を取る手のみ
    generate(buf, capturesOnly) {
      const b = this.board, s = this.side, sign = s ? -1 : 1;
      let n = 0;
      for (let sq = 0; sq < 81; sq++) {
        const p = b[sq] * sign;
        if (p <= 0) continue;
        if (p === KE) {
          const kt = KNIGHT_TO[s][sq];
          for (let i = 0; i < kt.length; i++) {
            const to = kt[i], q = b[to] * sign;
            if (q > 0 || (capturesOnly && q === 0)) continue;
            n = this._add(buf, n, sq, to, p, s);
          }
          continue;
        }
        const st = STEP_LIST[s][p];
        for (let i = 0; i < st.length; i++) {
          const ray = RAY[sq * 8 + st[i]];
          if (!ray.length) continue;
          const to = ray[0], q = b[to] * sign;
          if (q > 0 || (capturesOnly && q === 0)) continue;
          n = this._add(buf, n, sq, to, p, s);
        }
        const sl = SLIDE_LIST[s][p];
        for (let i = 0; i < sl.length; i++) {
          const ray = RAY[sq * 8 + sl[i]];
          for (let j = 0; j < ray.length; j++) {
            const to = ray[j], q = b[to] * sign;
            if (q > 0) break;
            if (q === 0) { if (!capturesOnly) n = this._add(buf, n, sq, to, p, s); continue; }
            n = this._add(buf, n, sq, to, p, s);
            break;
          }
        }
      }
      if (capturesOnly) return n;
      // 打つ手
      const hand = this.hand[s];
      let pawnFiles = 0; // 二歩チェック用: 自分の(成っていない)歩がある筋
      if (hand[FU]) for (let sq = 0; sq < 81; sq++) if (b[sq] === sign * FU) pawnFiles |= 1 << (sq % 9);
      for (let pt = 1; pt <= 7; pt++) {
        if (!hand[pt]) continue;
        for (let to = 0; to < 81; to++) {
          if (b[to]) continue;
          const rr = relRow(s, to);
          if ((pt === FU || pt === KY) && rr === 0) continue;   // 行き所のない駒
          if (pt === KE && rr <= 1) continue;
          if (pt === FU && ((pawnFiles >> (to % 9)) & 1)) continue; // 二歩
          buf[n++] = (80 + pt) | (to << 7);
        }
      }
      return n;
    }

    _add(buf, n, from, to, pt, s) {
      if (pt <= HI && pt !== KI) { // 成れる駒
        const rt = relRow(s, to);
        if (rt <= 2 || relRow(s, from) <= 2) {
          buf[n++] = from | (to << 7) | (1 << 14);
          if ((pt === FU || pt === KY) && rt === 0) return n; // 不成だと行き所がない
          if (pt === KE && rt <= 1) return n;
        }
      }
      buf[n++] = from | (to << 7);
      return n;
    }

    // ---- 着手 / 戻す
    make(m) {
      const i = this.ply, s = this.side, sign = s ? -1 : 1, b = this.board;
      this.stMove[i] = m; this.stK1[i] = this.h1; this.stK2[i] = this.h2;
      if (m !== 0) {
        const from = m & 127, to = (m >> 7) & 127;
        if (from > 80) {
          const pt = from - 80;
          this._handAdd(s, pt, -1);
          b[to] = sign * pt; this._hashPiece(to, sign * pt);
          this.stCap[i] = 0;
        } else {
          const p = b[from], cap = b[to];
          this.stCap[i] = cap;
          if (cap) { this._hashPiece(to, cap); this._handAdd(s, UNPROMOTE[cap > 0 ? cap : -cap], 1); }
          this._hashPiece(from, p);
          b[from] = 0;
          const np = (m >> 14) & 1 ? sign * PROMOTE[p * sign] : p;
          b[to] = np; this._hashPiece(to, np);
          if (p * sign === OU) this.king[s] = to;
        }
      }
      this.side = s ^ 1; this.h1 ^= ZS1; this.h2 ^= ZS2;
      this.ply = i + 1;
      this.stCheck[i] = m !== 0 && this.isAttacked(this.king[s ^ 1], s) ? 1 : 0;
    }

    unmake() {
      const i = --this.ply, m = this.stMove[i];
      const s = this.side ^ 1, sign = s ? -1 : 1, b = this.board;
      this.side = s;
      if (m !== 0) {
        const from = m & 127, to = (m >> 7) & 127;
        if (from > 80) {
          b[to] = 0; this.hand[s][from - 80]++;
        } else {
          const np = b[to], cap = this.stCap[i];
          const p = (m >> 14) & 1 ? sign * UNPROMOTE[np * sign] : np;
          b[from] = p; b[to] = cap;
          if (cap) this.hand[s][UNPROMOTE[cap > 0 ? cap : -cap]]--;
          if (p * sign === OU) this.king[s] = from;
        }
      }
      this.h1 = this.stK1[i]; this.h2 = this.stK2[i];
    }

    // make 直後に呼ぶ。直前の手が反則（自玉に利きが残る / 打ち歩詰め）なら false。
    isLegalAfterMake() {
      const mover = this.side ^ 1;
      if (this.isAttacked(this.king[mover], this.side)) return false;
      const i = this.ply - 1;
      if (this.stCheck[i] && (this.stMove[i] & 127) === 80 + FU && !this.hasLegalMove()) return false; // 打ち歩詰め
      return true;
    }

    hasLegalMove() {
      const d = this._depth++;
      const buf = this._buf[d] || (this._buf[d] = new Int32Array(MAXMOVES));
      const n = this.generate(buf, false);
      let ok = false;
      for (let k = 0; k < n && !ok; k++) {
        this.make(buf[k]);
        ok = this.isLegalAfterMake();
        this.unmake();
      }
      this._depth--;
      return ok;
    }

    legalMoves() {
      const buf = new Int32Array(MAXMOVES);
      const n = this.generate(buf, false), out = [];
      for (let k = 0; k < n; k++) {
        this.make(buf[k]);
        if (this.isLegalAfterMake()) out.push(buf[k]);
        this.unmake();
      }
      return out;
    }

    perft(depth) {
      if (depth === 0) return 1;
      const buf = new Int32Array(MAXMOVES);
      const n = this.generate(buf, false);
      let total = 0;
      for (let k = 0; k < n; k++) {
        this.make(buf[k]);
        if (this.isLegalAfterMake()) total += depth === 1 ? 1 : this.perft(depth - 1);
        this.unmake();
      }
      return total;
    }

    // ---- 入玉宣言法
    // 戻り値: null(玉が敵陣にいない等で宣言の意味がない) / {result:'win'|'draw'|'lose', points, pieces}
    declarationStatus() {
      const s = this.side, sign = s ? -1 : 1, k = this.king[s];
      if (k < 0) return null;
      const inZone = sq => relRow(s, sq) <= 2;
      let points = 0, pieces = 0;
      for (let sq = 0; sq < 81; sq++) {
        const p = this.board[sq] * sign;
        if (p <= 0 || p === OU || !inZone(sq)) continue;
        pieces++;
        points += (p === KA || p === HI || p === UM || p === RY) ? 5 : 1;
      }
      for (let pt = 1; pt <= 7; pt++) points += this.hand[s][pt] * (pt === KA || pt === HI ? 5 : 1);
      const ok = inZone(k) && pieces >= 10 && !this.inCheck();
      const result = !ok ? 'lose' : points >= 31 ? 'win' : points >= 24 ? 'draw' : 'lose';
      return { result, points, pieces, kingInZone: inZone(k), inCheck: this.inCheck() };
    }

    // ---- 評価関数（手番側から見た点数）
    evaluate() {
      const b = this.board, kB = this.king[0], kW = this.king[1];
      let sc = 0;
      for (let sq = 0; sq < 81; sq++) {
        const p = b[sq];
        if (!p) continue;
        if (p > 0) {
          sc += VAL[p];
          if (p !== OU) {
            if (kB >= 0) sc += DEF[p][DIST[sq * 81 + kB]];
            if (kW >= 0) sc += ATK[p][DIST[sq * 81 + kW]];
          }
        } else {
          const pt = -p;
          sc -= VAL[pt];
          if (pt !== OU) {
            if (kW >= 0) sc -= DEF[pt][DIST[sq * 81 + kW]];
            if (kB >= 0) sc -= ATK[pt][DIST[sq * 81 + kB]];
          }
        }
      }
      for (let pt = 1; pt <= 7; pt++) sc += (this.hand[0][pt] - this.hand[1][pt]) * HAND_VAL[pt];
      return this.side ? -sc : sc;
    }
  }

  // ---------------------------------------------------------------- 評価値テーブル
  const VAL = [0, 90, 315, 405, 495, 540, 855, 990, 0, 540, 540, 540, 540, 945, 1395];
  const HAND_VAL = [0, 105, 335, 425, 525, 570, 900, 1050];
  // 自玉との距離ごとの守りボーナス、敵玉との距離ごとの攻めボーナス（距離 0..8）
  const DEF = [], ATK = [];
  for (let pt = 0; pt <= RY; pt++) {
    const goldLike = pt === KI || pt === GI || pt === TO || pt === NY || pt === NK || pt === NG;
    DEF[pt] = goldLike ? [0, 55, 35, 12, 0, -5, -10, -10, -10] : [0, 10, 5, 0, 0, 0, 0, 0, 0];
    const big = pt === KA || pt === HI || pt === UM || pt === RY;
    ATK[pt] = big ? [0, 40, 30, 18, 8, 0, 0, 0, 0] : [0, 45, 32, 16, 4, 0, 0, 0, 0];
  }

  // ---------------------------------------------------------------- 表記
  const ZEN = '０１２３４５６７８９', KAN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const sqFile = sq => 9 - (sq % 9), sqRank = sq => ((sq / 9) | 0) + 1;
  const sqOf = (file, rank) => (rank - 1) * 9 + (9 - file);

  function moveToUSI(m) {
    if (m === 0) return 'pass';
    const f = m & 127, t = (m >> 7) & 127;
    const ts = sqFile(t) + String.fromCharCode(96 + sqRank(t));
    if (f > 80) return 'PLNSGBR'[f - 81] + '*' + ts;
    return sqFile(f) + String.fromCharCode(96 + sqRank(f)) + ts + ((m >> 14) & 1 ? '+' : '');
  }

  function parseUSI(pos, str) {
    return pos.legalMoves().find(m => moveToUSI(m) === str) || 0;
  }

  // KIF 形式の指し手表記（局面は指す前のもの）。例: "▲７六歩(77)" "△同　角成(88)" "▲５五角打"
  function moveToKif(pos, m, prevTo) {
    const s = pos.side, mark = s ? '△' : '▲';
    const f = m & 127, t = (m >> 7) & 127;
    const dest = t === prevTo ? '同　' : ZEN[sqFile(t)] + KAN[sqRank(t)];
    if (f > 80) return mark + dest + PIECE_KANJI[f - 80] + '打';
    const pt = Math.abs(pos.board[f]);
    let suffix = '';
    if ((m >> 14) & 1) suffix = '成';
    else if (pt <= HI && pt !== KI && (relRow(s, t) <= 2 || relRow(s, f) <= 2)) suffix = '不成';
    return mark + dest + PIECE_KANJI[pt] + suffix + '(' + sqFile(f) + sqRank(f) + ')';
  }

  // ---------------------------------------------------------------- 対局（公式ルールの終局判定）
  class Game {
    constructor(sfen) {
      this.pos = new Position(sfen);
      this.kif = [];
      this.result = null; // {winner: 0|1|null, reason}
      this._checkEnd();
    }
    get side() { return this.pos.side; }
    legalMoves() { return this.result ? [] : this.pos.legalMoves(); }

    play(m) {
      if (this.result) throw new Error('対局は終了しています');
      if (!this.pos.legalMoves().includes(m)) throw new Error('反則手: ' + moveToUSI(m));
      const prevTo = this.pos.ply ? (this.pos.stMove[this.pos.ply - 1] >> 7) & 127 : -1;
      this.kif.push(moveToKif(this.pos, m, prevTo));
      this.pos.make(m);
      this._checkEnd();
      return this.result;
    }

    undo() {
      if (!this.pos.ply) return false;
      this.pos.unmake(); this.kif.pop(); this.result = null;
      return true;
    }

    resign() { this.result = { winner: this.pos.side ^ 1, reason: '投了' }; return this.result; }

    declare() {
      const st = this.pos.declarationStatus();
      const s = this.pos.side;
      if (st && st.result === 'win') this.result = { winner: s, reason: '入玉宣言' };
      else if (st && st.result === 'draw') this.result = { winner: null, reason: '入玉宣言(24〜30点・指し直し)' };
      else this.result = { winner: s ^ 1, reason: '入玉宣言の条件不足' };
      return this.result;
    }

    _checkEnd() {
      const pos = this.pos, n = pos.ply;
      if (!pos.hasLegalMove()) {
        this.result = { winner: pos.side ^ 1, reason: pos.inCheck() ? '詰み' : '指す手なし' };
        return;
      }
      // 千日手: 同一局面(盤面・持ち駒・手番)が4回
      let count = 1, first = n;
      for (let i = n - 2; i >= 0; i -= 2) {
        if (pos.stK1[i] === pos.h1 && pos.stK2[i] === pos.h2) { count++; first = i; }
      }
      if (count >= 4) {
        // first..n-1 の手のうち、片方の手がすべて王手なら王手側の負け
        let allA = true, allB = true; // A: 直前に指した側, B: 手番側
        for (let i = first; i < n; i++) {
          const byA = ((n - 1 - i) & 1) === 0;
          if (!pos.stCheck[i]) { if (byA) allA = false; else allB = false; }
        }
        const mover = pos.side ^ 1;
        if (allA) this.result = { winner: pos.side, reason: '連続王手の千日手' };
        else if (allB) this.result = { winner: mover, reason: '連続王手の千日手' };
        else this.result = { winner: null, reason: '千日手' };
        return;
      }
      if (pos.startMoveNumber - 1 + n >= 500) this.result = { winner: null, reason: '持将棋(500手)' };
    }
  }

  // ---------------------------------------------------------------- 探索AI
  const INF = 32000, MATE = 30000, MATE_BOUND = MATE - 1000, PERPETUAL = 20000;
  const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;

  class Searcher {
    constructor(ttBits) {
      const size = 1 << (ttBits || 20);
      this.ttMask = size - 1;
      this.ttKey = new Int32Array(size); this.ttMove = new Int32Array(size);
      this.ttScore = new Int32Array(size); this.ttDepth = new Int8Array(size); this.ttFlag = new Uint8Array(size);
      this.buf = []; this.scoreBuf = [];
      for (let i = 0; i < 128; i++) { this.buf.push(new Int32Array(MAXMOVES)); this.scoreBuf.push(new Int32Array(MAXMOVES)); }
      this.killers = new Int32Array(128 * 2);
      this.history = new Int32Array(88 * 81);
    }

    clearTT() { this.ttKey.fill(0); this.ttFlag.fill(0); }

    // opts: {timeMs, maxDepth, noise, onInfo}
    search(pos, opts) {
      opts = opts || {};
      this.pos = pos;
      this.nodes = 0; this.stop = false;
      this.deadline = Date.now() + (opts.timeMs || 1000);
      this.killers.fill(0);
      for (let i = 0; i < this.history.length; i++) this.history[i] >>= 2;
      const maxDepth = opts.maxDepth || 64, noise = opts.noise || 0;

      const decl = pos.declarationStatus();
      if (decl && decl.result === 'win') return { move: 0, declare: true, score: MATE, depth: 0, nodes: 0, pv: [] };

      const rootMoves = pos.legalMoves();
      if (!rootMoves.length) return { move: 0, score: -MATE, depth: 0, nodes: 0, pv: [] };
      const offset = new Map(rootMoves.map(m => [m, noise ? Math.floor(Math.random() * noise) : 0]));
      let best = { move: rootMoves[0], score: 0, depth: 0, pv: [rootMoves[0]] };
      let order = rootMoves.slice();

      for (let depth = 1; depth <= maxDepth; depth++) {
        let alpha = -INF, bestMove = 0, bestScore = -INF;
        const scored = [];
        for (let k = 0; k < order.length; k++) {
          const m = order[k], off = offset.get(m);
          pos.make(m);
          let sc;
          if (k === 0) sc = -this.negamax(depth - 1, -INF, -(alpha - off), 1, true) + off;
          else {
            sc = -this.negamax(depth - 1, -(alpha - off) - 1, -(alpha - off), 1, true) + off;
            if (sc > alpha && !this.stop) sc = -this.negamax(depth - 1, -INF, -(alpha - off), 1, true) + off;
          }
          pos.unmake();
          if (this.stop) break;
          scored.push([m, sc]);
          if (sc > bestScore) { bestScore = sc; bestMove = m; }
          if (sc > alpha) alpha = sc;
        }
        if (this.stop) {
          // 途中で打ち切り: 前回の最善手より良い手が見つかっていれば採用
          if (bestMove && bestScore > best.score && scored.length) best = { move: bestMove, score: bestScore, depth, pv: [bestMove] };
          break;
        }
        scored.sort((a, b) => b[1] - a[1]);
        order = scored.map(x => x[0]);
        best = { move: bestMove, score: bestScore, depth, pv: this.extractPV(bestMove) };
        if (opts.onInfo) opts.onInfo({ depth, score: bestScore, nodes: this.nodes, pv: best.pv.map(moveToUSI) });
        if (Math.abs(bestScore) >= MATE_BOUND) break; // 詰みを読み切った
        if (Date.now() > this.deadline) break;
      }
      best.nodes = this.nodes;
      return best;
    }

    extractPV(first) {
      const pos = this.pos, pv = [first];
      pos.make(first);
      for (let i = 0; i < 20; i++) {
        const idx = pos.h1 & this.ttMask;
        if (this.ttKey[idx] !== pos.h2 || !this.ttMove[idx]) break;
        const m = this.ttMove[idx];
        if (!pos.legalMoves().includes(m)) break;
        pv.push(m); pos.make(m);
      }
      for (let i = 0; i < pv.length; i++) pos.unmake();
      return pv;
    }

    // 探索中の同一局面: 0 = 千日手(引き分け扱い)、連続王手なら王手側が負け
    repetition() {
      const pos = this.pos, n = pos.ply;
      if (n < 4 || pos.stMove[n - 1] === 0 || pos.stMove[n - 2] === 0) return null;
      for (let i = n - 4, lim = Math.max(0, n - 40); i >= lim; i -= 2) {
        if (pos.stMove[i] === 0 || pos.stMove[i + 1] === 0) return null;
        if (pos.stK1[i] === pos.h1 && pos.stK2[i] === pos.h2) {
          let allMine = true, allTheirs = true;
          for (let j = i; j < n; j++) {
            if (pos.stCheck[j]) continue;
            if (((n - j) & 1) === 0) allMine = false; else allTheirs = false;
          }
          if (allTheirs) return PERPETUAL;
          if (allMine) return -PERPETUAL;
          return 0;
        }
      }
      return null;
    }

    negamax(depth, alpha, beta, ply, allowNull) {
      const pos = this.pos;
      if ((++this.nodes & 1023) === 0 && Date.now() > this.deadline) this.stop = true;
      if (this.stop) return 0;

      const rep = this.repetition();
      if (rep !== null) return rep;

      const inCheck = pos.stCheck[pos.ply - 1] === 1;
      if (inCheck && ply < 60) depth++;
      if (depth <= 0 || ply >= 120) return this.quiesce(alpha, beta, ply, 0);

      // 詰みまでの距離による枝刈り
      alpha = Math.max(alpha, -MATE + ply); beta = Math.min(beta, MATE - ply - 1);
      if (alpha >= beta) return alpha;

      const idx = pos.h1 & this.ttMask;
      let ttMove = 0;
      if (this.ttKey[idx] === pos.h2 && this.ttFlag[idx]) {
        ttMove = this.ttMove[idx];
        if (this.ttDepth[idx] >= depth) {
          let s = this.ttScore[idx];
          if (s > MATE_BOUND) s -= ply; else if (s < -MATE_BOUND) s += ply;
          const f = this.ttFlag[idx];
          if (f === TT_EXACT || (f === TT_LOWER && s >= beta) || (f === TT_UPPER && s <= alpha)) return s;
        }
      }

      // null move pruning
      if (allowNull && !inCheck && depth >= 3 && beta < MATE_BOUND && pos.evaluate() >= beta) {
        pos.make(0);
        const s = -this.negamax(depth - 3, -beta, -beta + 1, ply + 1, false);
        pos.unmake();
        if (this.stop) return 0;
        if (s >= beta) return beta;
      }

      const buf = this.buf[ply], sc = this.scoreBuf[ply];
      const n = pos.generate(buf, false);
      const k0 = this.killers[ply * 2], k1 = this.killers[ply * 2 + 1];
      for (let i = 0; i < n; i++) sc[i] = this.orderScore(buf[i], ttMove, k0, k1);

      const alpha0 = alpha;
      let bestScore = -INF, bestMove = 0, legal = 0;
      for (let i = 0; i < n; i++) {
        // 選択ソート
        let bi = i;
        for (let j = i + 1; j < n; j++) if (sc[j] > sc[bi]) bi = j;
        const m = buf[bi]; buf[bi] = buf[i]; buf[i] = m;
        const ms = sc[bi]; sc[bi] = sc[i]; sc[i] = ms;

        const quiet = !pos.board[(m >> 7) & 127] && !((m >> 14) & 1);
        pos.make(m);
        if (!pos.isLegalAfterMake()) { pos.unmake(); continue; }
        legal++;
        const givesCheck = pos.stCheck[pos.ply - 1] === 1;
        let s;
        if (legal === 1) {
          s = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true);
        } else {
          let r = 0;
          if (depth >= 3 && legal > 4 && quiet && !inCheck && !givesCheck) r = legal > 12 ? 2 : 1;
          s = -this.negamax(depth - 1 - r, -alpha - 1, -alpha, ply + 1, true);
          if (s > alpha && r) s = -this.negamax(depth - 1, -alpha - 1, -alpha, ply + 1, true);
          if (s > alpha && s < beta) s = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true);
        }
        pos.unmake();
        if (this.stop) return 0;
        if (s > bestScore) {
          bestScore = s; bestMove = m;
          if (s > alpha) {
            alpha = s;
            if (s >= beta) {
              if (quiet) {
                if (this.killers[ply * 2] !== m) { this.killers[ply * 2 + 1] = this.killers[ply * 2]; this.killers[ply * 2] = m; }
                this.history[(m & 127) * 81 + ((m >> 7) & 127)] += depth * depth;
              }
              break;
            }
          }
        }
      }
      if (legal === 0) return -MATE + ply; // 詰み（打ち歩詰めで逃れる場合も合法手 0 なら負け）

      let st = bestScore;
      if (st > MATE_BOUND) st += ply; else if (st < -MATE_BOUND) st -= ply;
      this.ttKey[idx] = pos.h2; this.ttMove[idx] = bestMove; this.ttScore[idx] = st;
      this.ttDepth[idx] = depth;
      this.ttFlag[idx] = bestScore >= beta ? TT_LOWER : bestScore > alpha0 ? TT_EXACT : TT_UPPER;
      return bestScore;
    }

    orderScore(m, ttMove, k0, k1) {
      if (m === ttMove) return 1 << 30;
      const pos = this.pos, from = m & 127, to = (m >> 7) & 127;
      const cap = pos.board[to];
      let s = 0;
      if (cap) {
        const att = from > 80 ? 0 : Math.abs(pos.board[from]);
        s = 1e7 + VAL[Math.abs(cap)] * 16 - VAL[att];
      }
      if ((m >> 14) & 1) s += 5e6;
      if (!s) {
        if (m === k0) return 4e6;
        if (m === k1) return 3e6;
        s = this.history[from * 81 + to];
      }
      return s;
    }

    quiesce(alpha, beta, ply, qd) {
      const pos = this.pos;
      if ((++this.nodes & 1023) === 0 && Date.now() > this.deadline) this.stop = true;
      if (this.stop) return 0;
      const inCheck = pos.stCheck[pos.ply - 1] === 1;
      let best = -INF;
      if (!inCheck || qd >= 6 || ply >= 120) {
        best = pos.evaluate();
        if (best >= beta || qd >= 10 || ply >= 120) return best;
        if (best > alpha) alpha = best;
      }
      const searchAll = inCheck && qd < 6; // 王手されている時は全ての応手を読む
      const buf = this.buf[ply], sc = this.scoreBuf[ply];
      const n = pos.generate(buf, !searchAll);
      for (let i = 0; i < n; i++) sc[i] = this.orderScore(buf[i], 0, 0, 0);
      let legal = 0;
      for (let i = 0; i < n; i++) {
        let bi = i;
        for (let j = i + 1; j < n; j++) if (sc[j] > sc[bi]) bi = j;
        const m = buf[bi]; buf[bi] = buf[i]; buf[i] = m;
        const ms = sc[bi]; sc[bi] = sc[i]; sc[i] = ms;
        pos.make(m);
        if (!pos.isLegalAfterMake()) { pos.unmake(); continue; }
        legal++;
        const s = -this.quiesce(-beta, -alpha, ply + 1, qd + 1);
        pos.unmake();
        if (this.stop) return 0;
        if (s > best) { best = s; if (s > alpha) { alpha = s; if (s >= beta) break; } }
      }
      if (searchAll && legal === 0) return -MATE + ply;
      return best;
    }
  }

  const api = {
    FU, KY, KE, GI, KI, KA, HI, OU, TO, NY, NK, NG, UM, RY, BLACK, WHITE,
    PROMOTE, UNPROMOTE, PIECE_KANJI, PIECE_KANJI1, START_SFEN, MATE, MATE_BOUND,
    Position, Game, Searcher,
    mkMove, mFrom, mTo, mPromo, isDrop, moveToUSI, parseUSI, moveToKif,
    sqFile, sqRank, sqOf, relRow,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ShogiEngine = api;
})(typeof self !== 'undefined' ? self : this);
