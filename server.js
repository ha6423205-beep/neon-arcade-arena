'use strict';
/*
 * NEON ARCADE ARENA — real-time multiplayer game server
 * Rooms, matchmaking, live chat, leaderboards, badges and
 * authoritative game engines (Ludo, Chess, Slingshot, Tic-Tac-Toe, Connect 4).
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/matter.min.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules', 'matter-js', 'build', 'matter.min.js'))
);

/* ------------------------------------------------------------------ *
 * Persistence (stats / badges survive restarts)
 * ------------------------------------------------------------------ */
const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
let stats = {};
try {
  stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
} catch (e) {
  stats = {};
}
let saveTimer = null;
function saveStats() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    } catch (e) {
      console.error('stats save failed', e);
    }
  }, 400);
}
function ensureStats(name) {
  if (!stats[name]) stats[name] = { avatar: '👾', wins: 0, losses: 0, games: 0, chats: 0, badges: [] };
  return stats[name];
}

const AVATARS = ['🦊', '🐉', '🤖', '👾', '🐸', '🦉', '🐙', '🐲', '🚀', '⚡', '🎧', '🐺'];

const BADGES = {
  first_win:    { name: 'First Blood',      desc: 'Win your very first match' },
  champion:     { name: 'Champion',         desc: 'Win 5 matches' },
  grandmaster:  { name: 'Grandmaster',      desc: 'Win 20 matches' },
  veteran:      { name: 'Veteran',          desc: 'Play 10 matches' },
  ludo_king:    { name: 'Ludo King',        desc: 'Win a Ludo match' },
  chess_master: { name: 'Checkmate Artist', desc: 'Win a Chess match' },
  sharpshooter: { name: 'Sharpshooter',     desc: 'Win a Slingshot duel' },
  arcade_ace:   { name: 'Arcade Ace',       desc: 'Win a Tic-Tac-Toe or Connect 4 match' },
  chatty:       { name: 'Chatty',           desc: 'Send 50 chat messages' },
  unlucky:      { name: 'Never Give Up',    desc: 'Lose 5 matches' }
};
const GAME_BADGE = {
  ludo: 'ludo_king',
  chess: 'chess_master',
  slingshot: 'sharpshooter',
  tictactoe: 'arcade_ace',
  connect4: 'arcade_ace'
};

function awardBadge(socketsByName, name, id) {
  const s = ensureStats(name);
  if (s.badges.includes(id)) return;
  s.badges.push(id);
  saveStats();
  const sock = socketsByName.get(name);
  if (sock) sock.emit('badge', { id, name: BADGES[id].name, desc: BADGES[id].desc });
}

/* ------------------------------------------------------------------ *
 * Rooms & matchmaking
 * ------------------------------------------------------------------ */
const rooms = new Map(); // code -> room
const queues = new Map(); // game -> [{ id, name, avatar }]
const queueTimers = new Map(); // game -> timeout handle (ludo gather window)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
  let c;
  do {
    c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(c));
  return c;
}

/* ------------------------------------------------------------------ *
 * CHESS ENGINE (server authoritative)
 * Board: 64 array, index = row*8+col, row 0 = black back rank (top).
 * ------------------------------------------------------------------ */
const DIRS = {
  n: [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]],
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  k: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
};
const opp = (c) => (c === 'w' ? 'b' : 'w');
const FILES = 'abcdefgh';
const sqName = (i) => FILES[i & 7] + (8 - (i >> 3));

function chessInitBoard() {
  const b = new Array(64).fill(null);
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  for (let c = 0; c < 8; c++) {
    b[c] = { t: back[c], c: 'b' };
    b[8 + c] = { t: 'p', c: 'b' };
    b[48 + c] = { t: 'p', c: 'w' };
    b[56 + c] = { t: back[c], c: 'w' };
  }
  return b;
}

function isAttacked(board, idx, by) {
  const r = idx >> 3, c = idx & 7;
  const pr = by === 'w' ? r - 1 : r + 1; // white pawns attack toward row 0
  for (const dc of [-1, 1]) {
    const nr = pr, nc = c + dc;
    if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const p = board[nr * 8 + nc];
      if (p && p.c === by && p.t === 'p') return true;
    }
  }
  for (const [dr, dc] of DIRS.n) {
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const p = board[nr * 8 + nc];
      if (p && p.c === by && p.t === 'n') return true;
    }
  }
  for (const [dr, dc] of DIRS.k) {
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const p = board[nr * 8 + nc];
      if (p && p.c === by && p.t === 'k') return true;
    }
  }
  for (const [dr, dc] of DIRS.b) {
    let nr = r + dr, nc = c + dc;
    while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const p = board[nr * 8 + nc];
      if (p) { if (p.c === by && (p.t === 'b' || p.t === 'q')) return true; break; }
      nr += dr; nc += dc;
    }
  }
  for (const [dr, dc] of DIRS.r) {
    let nr = r + dr, nc = c + dc;
    while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
      const p = board[nr * 8 + nc];
      if (p) { if (p.c === by && (p.t === 'r' || p.t === 'q')) return true; break; }
      nr += dr; nc += dc;
    }
  }
  return false;
}

function pseudoMoves(state, idx) {
  const p = state.board[idx];
  if (!p) return [];
  const r = idx >> 3, c = idx & 7;
  const out = [];
  const add = (to, extra) => out.push(Object.assign({ from: idx, to }, extra || {}));
  if (p.t === 'p') {
    const dir = p.c === 'w' ? -1 : 1;
    const startRow = p.c === 'w' ? 6 : 1;
    const nr = r + dir;
    if (nr >= 0 && nr < 8 && !state.board[nr * 8 + c]) {
      add(nr * 8 + c, { promo: nr === 0 || nr === 7 });
      const tr = r + 2 * dir;
      if (r === startRow && !state.board[tr * 8 + c]) add(tr * 8 + c, { double: true });
    }
    for (const dc of [-1, 1]) {
      const nnr = r + dir, nnc = c + dc;
      if (nnr < 0 || nnr > 7 || nnc < 0 || nnc > 7) continue;
      const t = nnr * 8 + nnc, q = state.board[t];
      if (q && q.c !== p.c) add(t, { capture: true, promo: nnr === 0 || nnr === 7 });
      else if (!q && state.ep === t) add(t, { ep: true, capture: true });
    }
  } else if (p.t === 'n' || p.t === 'k') {
    for (const [dr, dc] of DIRS[p.t === 'n' ? 'n' : 'k']) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
      const t = nr * 8 + nc, q = state.board[t];
      if (!q || q.c !== p.c) add(t, { capture: !!q });
    }
    if (p.t === 'k') {
      const rights = state.castling;
      const o = opp(p.c);
      if (rights[p.c + 'K'] && !state.board[idx + 1] && !state.board[idx + 2] &&
        !isAttacked(state.board, idx, o) && !isAttacked(state.board, idx + 1, o) && !isAttacked(state.board, idx + 2, o))
        add(idx + 2, { castle: 'K' });
      if (rights[p.c + 'Q'] && !state.board[idx - 1] && !state.board[idx - 2] && !state.board[idx - 3] &&
        !isAttacked(state.board, idx, o) && !isAttacked(state.board, idx - 1, o) && !isAttacked(state.board, idx - 2, o))
        add(idx - 2, { castle: 'Q' });
    }
  } else {
    const rays = p.t === 'b' ? DIRS.b : p.t === 'r' ? DIRS.r : DIRS.b.concat(DIRS.r);
    for (const [dr, dc] of rays) {
      let nr = r + dr, nc = c + dc;
      while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const t = nr * 8 + nc, q = state.board[t];
        if (!q) add(t);
        else { if (q.c !== p.c) add(t, { capture: true }); break; }
        nr += dr; nc += dc;
      }
    }
  }
  return out;
}

function makeMove(state, mv, promoPiece) {
  const board = state.board;
  const p = board[mv.from];
  const undo = {
    mv, piece: p, captured: board[mv.to],
    ep: state.ep, castling: { ...state.castling },
    epCap: null, rook: null, promoted: false, halfmove: state.halfmove
  };
  state.ep = null;
  state.halfmove = (p.t === 'p' || mv.capture) ? 0 : state.halfmove + 1;
  board[mv.to] = p;
  board[mv.from] = null;
  if (mv.ep) {
    const capIdx = mv.to + (p.c === 'w' ? 8 : -8);
    undo.epCap = { idx: capIdx, piece: board[capIdx] };
    board[capIdx] = null;
  }
  if (mv.double) state.ep = mv.to;
  if (mv.promo) {
    board[mv.to] = { t: promoPiece || 'q', c: p.c };
    undo.promoted = true;
  }
  if (mv.castle === 'K') {
    const rf = mv.from + 3, rt = mv.from + 1;
    undo.rook = { from: rf, to: rt };
    board[rt] = board[rf]; board[rf] = null;
  } else if (mv.castle === 'Q') {
    const rf = mv.from - 4, rt = mv.from - 1;
    undo.rook = { from: rf, to: rt };
    board[rt] = board[rf]; board[rf] = null;
  }
  const f = mv.from, t = mv.to;
  if (f === 60 || t === 60 || f === 63 || t === 63) state.castling.wK = false;
  if (f === 56 || t === 56 || f === 60 || t === 60) state.castling.wQ = false;
  if (f === 4 || t === 4 || f === 7 || t === 7) state.castling.bK = false;
  if (f === 0 || t === 0 || f === 4 || t === 4) state.castling.bQ = false;
  return undo;
}
function unmakeMove(state, undo) {
  const board = state.board;
  const { mv } = undo;
  board[mv.from] = undo.piece;
  board[mv.to] = undo.captured;
  if (undo.epCap) board[undo.epCap.idx] = undo.epCap.piece;
  if (undo.rook) { board[undo.rook.from] = board[undo.rook.to]; board[undo.rook.to] = null; }
  state.ep = undo.ep;
  state.castling = undo.castling;
  state.halfmove = undo.halfmove;
}

function kingIdx(board, color) {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p && p.t === 'k' && p.c === color) return i;
  }
  return -1;
}
function inCheck(state, color) {
  return isAttacked(state.board, kingIdx(state.board, color), opp(color));
}
function allLegal(state, color) {
  const list = [];
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (!p || p.c !== color) continue;
    for (const mv of pseudoMoves(state, i)) {
      const undo = makeMove(state, mv, 'q');
      const safe = !isAttacked(state.board, kingIdx(state.board, color), opp(color));
      unmakeMove(state, undo);
      if (safe) list.push(mv);
    }
  }
  return list;
}
function insufficientMaterial(board) {
  const rest = [];
  for (const p of board) if (p && p.t !== 'k') rest.push(p.t);
  if (rest.length === 0) return true;
  if (rest.length === 1 && (rest[0] === 'n' || rest[0] === 'b')) return true;
  return false;
}

function chessInit(room) {
  return {
    board: chessInitBoard(),
    turn: 'w',
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    ep: null,
    halfmove: 0,
    history: [],
    clocks: { w: 300000, b: 300000 },
    result: null,
    players: { w: room.players[0].name, b: room.players[1].name },
    legal: []
  };
}
function chessLegalMap(state) {
  return allLegal(state, state.turn).map((m) => ({
    from: m.from, to: m.to, cap: !!m.capture, promo: !!m.promo
  }));
}
function chessFinish(state, winner, reason) {
  state.result = { winner, reason };
  state.legal = [];
}

const chessEngine = {
  init: chessInit,
  action(room, state, pi, payload) {
    if (state.result) return null;
    const p = room.players[pi];
    if (payload.type === 'resign') {
      chessFinish(state, state.players.w === p.name ? state.players.b : state.players.w, `${p.name} resigned`);
      return [{ ev: 'resign', player: p.name }];
    }
    if (payload.type !== 'move') return null;
    const myColor = state.players.w === p.name ? 'w' : 'b';
    if (state.turn !== myColor) return null;
    const from = payload.from | 0, to = payload.to | 0;
    if (from < 0 || from > 63 || to < 0 || to > 63) return null;
    const mv = allLegal(state, myColor).find((m) => m.from === from && m.to === to);
    if (!mv) return null;
    const promo = ['q', 'r', 'b', 'n'].includes(payload.promo) ? payload.promo : 'q';
    const mover = state.board[mv.from];
    const captured = mv.ep ? state.board[mv.to + (myColor === 'w' ? 8 : -8)] : state.board[mv.to];
    makeMove(state, mv, promo);
    state.turn = opp(myColor);
    state.legal = chessLegalMap(state);
    const oppCheck = inCheck(state, state.turn);
    const oppMoves = allLegal(state, state.turn);
    let san;
    if (mv.castle) san = mv.castle === 'K' ? 'O-O' : 'O-O-O';
    else {
      const L = mover.t === 'p' ? '' : mover.t.toUpperCase();
      san = `${L}${sqName(mv.from)}${captured ? 'x' : '-'}${sqName(mv.to)}${mv.promo ? '=' + promo.toUpperCase() : ''}`;
    }
    if (oppMoves.length === 0) {
      if (oppCheck) {
        san += '#';
        chessFinish(state, p.name, 'checkmate');
      } else {
        chessFinish(state, null, 'stalemate');
      }
    } else if (insufficientMaterial(state.board)) {
      chessFinish(state, null, 'insufficient material');
    } else if (state.halfmove >= 100) {
      chessFinish(state, null, '50-move rule');
    } else if (san && oppCheck) {
      san += '+';
    }
    state.history.push({ color: myColor, san, by: p.name });
    return [{ ev: 'move', player: p.name, san }];
  },
  onLeave(room, state, pi) {
    if (state.result) return null;
    const left = room.players[pi].name;
    const other = room.players.find((p, i) => i !== pi && p.connected);
    chessFinish(state, other ? other.name : null, `${left} left the game`);
    return [{ ev: 'left', player: left }];
  }
};

/* ------------------------------------------------------------------ *
 * LUDO ENGINE
 * 52-square absolute track; seat i start offsets [1,14,27,40].
 * rel 0..50 track, rel 51..55 home column, rel 56 home (done).
 * ------------------------------------------------------------------ */
const LUDO_STARTS = [1, 14, 27, 40];
const LUDO_SAFE = new Set([1, 9, 14, 22, 27, 35, 40, 48]);
const ludoRel = (pl, tk) => {
  if (tk.area === 'track') return (tk.pos - pl.start + 52) % 52;
  if (tk.area === 'homecol') return 50 + tk.pos;
  return 56;
};
function ludoCanMove(pl, tk, dice) {
  if (tk.area === 'base') return dice === 6;
  if (tk.area === 'done') return false;
  return ludoRel(pl, tk) + dice <= 56;
}
function ludoInit(room) {
  return {
    players: room.players.map((p, i) => ({
      name: p.name, avatar: p.avatar, start: LUDO_STARTS[i],
      tokens: [0, 1, 2, 3].map(() => ({ area: 'base', pos: 0 }))
    })),
    turn: 0, dice: null, sixes: 0, result: null
  };
}
function ludoAdvance(state) {
  const n = state.players.length;
  let t = state.turn;
  for (let k = 0; k < n; k++) {
    t = (t + 1) % n;
    if (!state.players[t].gone) break;
  }
  state.turn = t;
  state.sixes = 0;
}
function ludoFinish(state, winner, reason) {
  state.result = { winner, reason };
}
function ludoActiveCount(state) {
  return state.players.filter((p) => !p.gone).length;
}

const ludoEngine = {
  init: ludoInit,
  action(room, state, pi, payload) {
    if (state.result) return null;
    const p = room.players[pi];
    const pl = state.players[pi];
    if (payload.type === 'roll') {
      if (state.turn !== pi || state.dice !== null) return null;
      const dice = 1 + Math.floor(Math.random() * 6);
      state.dice = dice;
      if (dice === 6) {
        state.sixes++;
        if (state.sixes >= 3) {
          state.dice = null;
          state.sixes = 0;
          ludoAdvance(state);
          return [{ ev: 'roll', player: p.name, dice }, { ev: 'foul', player: p.name }];
        }
      } else {
        state.sixes = 0;
      }
      const movable = pl.tokens.map((t, i) => ludoCanMove(pl, t, dice) ? i : -1).filter((i) => i >= 0);
      if (movable.length === 0) {
        state.dice = null;
        state.sixes = 0;
        ludoAdvance(state);
        return [{ ev: 'roll', player: p.name, dice }, { ev: 'pass', player: p.name }];
      }
      return [{ ev: 'roll', player: p.name, dice }];
    }
    if (payload.type === 'move') {
      if (state.turn !== pi || state.dice === null) return null;
      const ti = payload.token | 0;
      if (ti < 0 || ti > 3) return null;
      if (!ludoCanMove(pl, pl.tokens[ti], state.dice)) return null;
      const dice = state.dice;
      const tk = pl.tokens[ti];
      if (tk.area === 'base') {
        tk.area = 'track'; tk.pos = pl.start;
      } else if (tk.area === 'track') {
        const nRel = ludoRel(pl, tk) + dice;
        if (nRel <= 50) tk.pos = (pl.start + nRel) % 52;
        else if (nRel <= 55) { tk.area = 'homecol'; tk.pos = nRel - 50; }
        else { tk.area = 'done'; tk.pos = 0; }
      } else {
        const nRel = 50 + tk.pos + dice;
        if (nRel <= 55) tk.pos = nRel - 50;
        else { tk.area = 'done'; tk.pos = 0; }
      }
      const events = [{ ev: 'move', player: p.name, token: ti, dice }];
      let captures = 0;
      if (tk.area === 'track' && !LUDO_SAFE.has(tk.pos)) {
        for (const op of state.players) {
          if (op === pl || op.gone) continue;
          op.tokens.forEach((ot, j) => {
            if (ot.area === 'track' && ot.pos === tk.pos) {
              ot.area = 'base'; ot.pos = 0;
              captures++;
              events.push({ ev: 'capture', by: p.name, player: op.name, token: j });
            }
          });
        }
      }
      state.dice = null;
      const reachedDone = tk.area === 'done';
      if (reachedDone) events.push({ ev: 'tokenhome', player: p.name, token: ti });
      if (pl.tokens.every((t) => t.area === 'done')) {
        ludoFinish(state, p.name, 'all tokens home');
        events.push({ ev: 'win', player: p.name });
        return events;
      }
      const extra = (dice === 6 && state.sixes < 3) || captures > 0 || reachedDone;
      if (!extra) ludoAdvance(state);
      else if (dice === 6 && state.sixes === 3) ludoAdvance(state);
      return events;
    }
    return null;
  },
  onLeave(room, state, pi) {
    if (state.result) return null;
    state.players[pi].gone = true;
    if (ludoActiveCount(state) <= 1) {
      const winner = state.players.find((p) => !p.gone);
      ludoFinish(state, winner ? winner.name : null, 'opponents left');
      return [{ ev: 'left', player: state.players[pi].name }];
    }
    if (state.turn === pi) {
      state.dice = null;
      ludoAdvance(state);
    }
    return [{ ev: 'left', player: state.players[pi].name }];
  }
};

/* ------------------------------------------------------------------ *
 * SLINGSHOT ENGINE (server stores block HP; clients run physics)
 * ------------------------------------------------------------------ */
const SLINGSHOT = { W: 960, H: 540, groundY: 470, ammo: 8, crownHP: 3, blockHP: 2 };
function slingshotInit(room) {
  // Template on the RIGHT side (x mirrored for LEFT).
  const bs = 34;
  const rows = [
    { y: 453, xs: [780, 816, 852, 888] },
    { y: 419, xs: [798, 834, 870] },
    { y: 385, xs: [816, 852] }
  ];
  let id = 0;
  const mk = (x, y, type) => ({
    id: 'R' + id++, x, y, w: bs, h: bs, type,
    hp: type === 'crown' ? SLINGSHOT.crownHP : SLINGSHOT.blockHP
  });
  const right = [];
  for (const row of rows) for (const x of row.xs) right.push(mk(x, row.y, 'block'));
  right.push(mk(834, 351, 'crown'));
  const left = right.map((b) => ({
    id: 'L' + b.id.slice(1), x: SLINGSHOT.W - b.x - b.w, y: b.y, w: b.w, h: b.h,
    type: b.type, hp: b.hp
  }));
  return {
    players: room.players.map((p) => p.name),
    turn: 0, ammo: [SLINGSHOT.ammo, SLINGSHOT.ammo],
    blocks: { L: left, R: right },
    anchors: { L: [430, 420], R: [530, 420] },
    result: null
  };
}
function slingTotalHP(blocks) {
  return blocks.reduce((s, b) => s + Math.max(0, b.hp), 0);
}
const slingshotEngine = {
  init: slingshotInit,
  action(room, state, pi, payload) {
    if (state.result) return null;
    if (payload.type !== 'fire') return null;
    if (state.turn !== pi || state.ammo[pi] <= 0) return null;
    const shooter = room.players[pi].name;
    const defSide = pi === 0 ? 'R' : 'L';
    const defender = state.blocks[defSide];
    const seen = new Set();
    let dealt = 0;
    const destroyed = [];
    const hits = [];
    if (Array.isArray(payload.hits)) {
      for (const h of payload.hits) {
        if (dealt >= 9) break;
        const b = defender.find((x) => x.id === h.id && x.hp > 0);
        if (!b || seen.has(b.id)) continue;
        const dmg = Math.min(3, Math.max(1, h.dmg | 0));
        seen.add(b.id);
        b.hp -= dmg;
        dealt += dmg;
        hits.push({ id: b.id, dmg });
        if (b.hp <= 0) destroyed.push(b.id);
      }
    }
    state.ammo[pi]--;
    const events = [{
      ev: 'fire', shooter,
      angle: +payload.angle || 0, power: Math.min(1, Math.max(0, +payload.power || 0)),
      hits, destroyed
    }];
    const crown = defender.find((b) => b.type === 'crown');
    if ((crown && crown.hp <= 0) || defender.every((b) => b.hp <= 0)) {
      state.result = { winner: shooter, reason: crown && crown.hp <= 0 ? 'crown destroyed' : 'fortress razed' };
      events.push({ ev: 'win', player: shooter });
      return events;
    }
    state.turn = 1 - state.turn;
    if (state.ammo[0] <= 0 && state.ammo[1] <= 0) {
      const hpL = slingTotalHP(state.blocks.L), hpR = slingTotalHP(state.blocks.R);
      if (hpL === hpR) state.result = { winner: null, reason: 'ammo exhausted — draw' };
      else {
        // the weaker fortress loses; seat0 owns L
        const winner = hpL < hpR ? state.players[1] : state.players[0];
        state.result = { winner, reason: 'ammo exhausted — most destruction wins' };
      }
      events.push({ ev: 'win', player: state.result.winner });
      return events;
    }
    if (state.ammo[state.turn] <= 0) { // defender also out of ammo -> back to other? end by comparison
      const hpL = slingTotalHP(state.blocks.L), hpR = slingTotalHP(state.blocks.R);
      if (hpL === hpR) state.result = { winner: null, reason: 'ammo exhausted — draw' };
      else {
        const winner = hpL < hpR ? state.players[1] : state.players[0];
        state.result = { winner, reason: 'ammo exhausted — most destruction wins' };
      }
      events.push({ ev: 'win', player: state.result.winner });
    }
    return events;
  },
  onLeave(room, state, pi) {
    if (state.result) return null;
    const other = room.players.find((p, i) => i !== pi && p.connected);
    state.result = { winner: other ? other.name : null, reason: 'opponent left the duel' };
    return [{ ev: 'left', player: room.players[pi].name }];
  }
};

/* ------------------------------------------------------------------ *
 * ARCADE ENGINES — Tic-Tac-Toe & Connect 4
 * ------------------------------------------------------------------ */
const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];
const tttEngine = {
  init: (room) => ({
    grid: new Array(9).fill(null), turn: 0,
    players: room.players.map((p) => p.name), result: null, lastMove: null
  }),
  action(room, state, pi, payload) {
    if (state.result || payload.type !== 'move' || state.turn !== pi) return null;
    const idx = payload.idx | 0;
    if (idx < 0 || idx > 8 || state.grid[idx] !== null) return null;
    state.grid[idx] = pi;
    state.lastMove = idx;
    const events = [{ ev: 'move', player: state.players[pi], idx }];
    for (const line of WIN_LINES) {
      if (line.every((i) => state.grid[i] === pi)) {
        state.result = { winner: state.players[pi], reason: 'three in a row' };
        events.push({ ev: 'win', player: state.players[pi], line });
        return events;
      }
    }
    if (state.grid.every((c) => c !== null)) {
      state.result = { winner: null, reason: 'draw' };
      events.push({ ev: 'draw' });
      return events;
    }
    state.turn = 1 - state.turn;
    return events;
  },
  onLeave(room, state, pi) {
    if (state.result) return null;
    const other = room.players.find((p, i) => i !== pi && p.connected);
    state.result = { winner: other ? other.name : null, reason: 'opponent left' };
    return [{ ev: 'left', player: state.players[pi] }];
  }
};

function c4CheckWin(grid, player) {
  const at = (r, c) => (r >= 0 && r < 6 && c >= 0 && c < 7 ? grid[r * 7 + c] : null);
  for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      if (at(r, c) === player && at(r + dr, c + dc) === player &&
        at(r + 2 * dr, c + 2 * dc) === player && at(r + 3 * dr, c + 3 * dc) === player) {
        return [0, 1, 2, 3].map((k) => (r + k * dr) * 7 + (c + k * dc));
      }
    }
  }
  return null;
}
const c4Engine = {
  init: (room) => ({
    grid: new Array(42).fill(null), turn: 0,
    players: room.players.map((p) => p.name), result: null, lastMove: null
  }),
  action(room, state, pi, payload) {
    if (state.result || payload.type !== 'move' || state.turn !== pi) return null;
    const col = payload.col | 0;
    if (col < 0 || col > 6) return null;
    for (let r = 5; r >= 0; r--) {
      const idx = r * 7 + col;
      if (state.grid[idx] === null) {
        state.grid[idx] = pi;
        state.lastMove = idx;
        const events = [{ ev: 'move', player: state.players[pi], idx }];
        const line = c4CheckWin(state.grid, pi);
        if (line) {
          state.result = { winner: state.players[pi], reason: 'four in a row' };
          events.push({ ev: 'win', player: state.players[pi], line });
        } else if (state.grid.every((c) => c !== null)) {
          state.result = { winner: null, reason: 'draw' };
          events.push({ ev: 'draw' });
        } else {
          state.turn = 1 - state.turn;
        }
        return events;
      }
    }
    return null;
  },
  onLeave(room, state, pi) {
    if (state.result) return null;
    const other = room.players.find((p, i) => i !== pi && p.connected);
    state.result = { winner: other ? other.name : null, reason: 'opponent left' };
    return [{ ev: 'left', player: state.players[pi] }];
  }
};

/* ------------------------------------------------------------------ *
 * Game registry
 * ------------------------------------------------------------------ */
const GAMES = {
  ludo:       { name: 'Ludo',            min: 2, max: 4, engine: ludoEngine },
  chess:      { name: 'Chess',           min: 2, max: 2, engine: chessEngine },
  slingshot:  { name: 'Slingshot Duel',   min: 2, max: 2, engine: slingshotEngine },
  tictactoe:  { name: 'Tic-Tac-Toe',     min: 2, max: 2, engine: tttEngine },
  connect4:   { name: 'Connect 4',       min: 2, max: 2, engine: c4Engine }
};

/* ------------------------------------------------------------------ *
 * Room helpers
 * ------------------------------------------------------------------ */
const profiles = new Map(); // socketId -> { name, avatar }
const socketsByName = new Map(); // name -> socket
const globalChat = [];

function roomSnapshot(room) {
  return {
    code: room.code,
    game: room.game,
    gameName: GAMES[room.game].name,
    isPrivate: room.isPrivate,
    maxPlayers: room.maxPlayers,
    phase: room.phase,
    hostIndex: room.players.findIndex((p) => p.id === room.hostId),
    players: room.players.map((p) => ({
      name: p.name, avatar: p.avatar, ready: p.ready, connected: p.connected
    })),
    chat: room.chat.slice(-50)
  };
}
function emitRoom(room, ev, payload) {
  io.to(room.code).emit(ev, payload);
}
function broadcastLobby() {
  const lobby = {
    publicRooms: [...rooms.values()]
      .filter((r) => !r.isPrivate && r.phase === 'lobby' && r.players.length < r.maxPlayers)
      .map((r) => ({ code: r.code, game: r.game, gameName: GAMES[r.game].name, count: r.players.filter((p) => p.connected).length, max: r.maxPlayers })),
    leaderboard: Object.entries(stats)
      .filter(([, s]) => s.games > 0)
      .sort((a, b) => b[1].wins - a[1].wins || a[1].losses - b[1].losses)
      .slice(0, 10)
      .map(([name, s]) => ({ name, avatar: s.avatar, wins: s.wins, losses: s.losses, games: s.games, badges: s.badges.length }))
  };
  io.emit('lobby', lobby);
}

function createRoom(game, isPrivate, maxPlayers, hostId) {
  const code = genCode();
  const room = {
    code, game, isPrivate,
    maxPlayers: Math.min(GAMES[game].max, Math.max(GAMES[game].min, maxPlayers || GAMES[game].min)),
    hostId,
    players: [],
    phase: 'lobby',
    state: null,
    chat: [],
    rematch: {},
    timer: null
  };
  rooms.set(code, room);
  return room;
}
function startGame(room) {
  room.phase = 'playing';
  room.rematch = {};
  room.state = GAMES[room.game].engine.init(room);
  if (room.game === 'chess') {
    room.state.legal = chessLegalMap(room.state);
    clearInterval(room.timer);
    room.timer = setInterval(() => {
      const st = room.state;
      if (!st || room.phase !== 'playing' || st.result) {
        clearInterval(room.timer);
        return;
      }
      st.clocks[st.turn] -= 1000;
      if (st.clocks[st.turn] <= 0) {
        st.clocks[st.turn] = 0;
        const winner = st.turn === 'w' ? st.players.b : st.players.w;
        chessFinish(st, winner, 'clock ran out');
        finishGame(room, winner, 'clock ran out');
      } else {
        emitRoom(room, 'game:clock', { clocks: st.clocks, turn: st.turn });
      }
    }, 1000);
  }
  emitRoom(room, 'game:start', {
    game: room.game,
    players: room.players.map((p) => ({ name: p.name, avatar: p.avatar })),
    state: room.state
  });
  broadcastLobby();
}
function finishGame(room, winnerName, reason) {
  if (room.phase === 'over') return;
  room.phase = 'over';
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
  const standings = room.players.filter((p) => p.connected).map((p) => p.name);
  const result = { winner: winnerName, reason, standings };
  for (const p of room.players) {
    if (!p.connected) continue;
    const s = ensureStats(p.name);
    s.avatar = p.avatar;
    s.games++;
    if (winnerName === p.name) s.wins++;
    else if (winnerName) s.losses++;
    if (winnerName === p.name) {
      if (s.wins === 1) awardBadge(socketsByName, p.name, 'first_win');
      if (s.wins >= 5) awardBadge(socketsByName, p.name, 'champion');
      if (s.wins >= 20) awardBadge(socketsByName, p.name, 'grandmaster');
      const gb = GAME_BADGE[room.game];
      if (gb) awardBadge(socketsByName, p.name, gb);
    }
    if (s.losses >= 5) awardBadge(socketsByName, p.name, 'unlucky');
    if (s.games >= 10) awardBadge(socketsByName, p.name, 'veteran');
    const sock = socketsByName.get(p.name);
    if (sock) sock.emit('me:stats', { wins: s.wins, losses: s.losses, games: s.games, badges: s.badges });
  }
  saveStats();
  emitRoom(room, 'game:over', result);
  broadcastLobby();
}
function destroyRoomIfEmpty(room) {
  if (room.players.filter((p) => p.connected).length === 0) {
    if (room.timer) clearInterval(room.timer);
    rooms.delete(room.code);
    broadcastLobby();
  }
}
function handleLeave(socket, silent) {
  const room = [...rooms.values()].find((r) => r.players.some((p) => p.id === socket.id));
  if (!room) return;
  const pi = room.players.findIndex((p) => p.id === socket.id);
  if (pi === -1) return;
  const player = room.players[pi];
  if (room.phase === 'playing' && room.state) {
    const events = GAMES[room.game].engine.onLeave(room, room.state, pi);
    player.connected = false;
    if (room.state.result) {
      finishGame(room, room.state.result.winner, room.state.result.reason);
    } else if (events) {
      for (const e of events) emitRoom(room, 'game:event', e);
      emitRoom(room, 'game:state', room.state);
    }
  } else {
    room.players.splice(pi, 1);
    if (room.hostId === socket.id && room.players.length) room.hostId = room.players[0].id;
  }
  if (!silent) socket.emit('room:left');
  socket.leave(room.code);
  if (room.players.length === 0 || room.players.every((p) => !p.connected)) {
    destroyRoomIfEmpty(room);
  } else {
    emitRoom(room, 'room:state', roomSnapshot(room));
    broadcastLobby();
  }
}

/* ------------------------------------------------------------------ *
 * Matchmaking queues
 * ------------------------------------------------------------------ */
function tryMatch(game) {
  const q = queues.get(game) || [];
  const def = GAMES[game];
  if (game === 'ludo') {
    if (q.length >= 4) {
      queues.set(game, []);
      launchMatch(game, q.splice(0, 4));
    }
  } else if (q.length >= 2) {
    queues.set(game, []);
    launchMatch(game, q.splice(0, 2));
  }
}
function launchMatch(game, entries) {
  const room = createRoom(game, false, entries.length, entries[0].id);
  for (const e of entries) {
    room.players.push({ id: e.id, name: e.name, avatar: e.avatar, ready: true, connected: true });
    const sock = io.sockets.sockets.get(e.id);
    if (sock) sock.join(room.code);
  }
  startGame(room);
  for (const e of entries) {
    const sock = io.sockets.sockets.get(e.id);
    if (sock) sock.emit('room:joined', { code: room.code, seat: room.players.findIndex((p) => p.id === e.id) });
  }
}
function joinQueue(socket, game) {
  if (!GAMES[game]) return;
  const prof = profiles.get(socket.id);
  if (!prof) return;
  leaveQueue(socket);
  let q = queues.get(game) || [];
  q = q.filter((e) => io.sockets.sockets.has(e.id));
  q.push({ id: socket.id, name: prof.name, avatar: prof.avatar });
  queues.set(game, q);
  socket.emit('queue', { game, size: q.length });
  for (const e of q) {
    const s = io.sockets.sockets.get(e.id);
    if (s && s !== socket) s.emit('queue', { game, size: q.length });
  }
  tryMatch(game);
  if (game === 'ludo') {
    if (!queueTimers.has(game)) {
      const t = setTimeout(() => {
        queueTimers.delete(game);
        const qq = (queues.get(game) || []).filter((e) => io.sockets.sockets.has(e.id));
        queues.set(game, qq);
        if (qq.length >= 2) launchMatch(game, qq.splice(0, qq.length));
      }, 12000);
      queueTimers.set(game, t);
    }
  }
}
function leaveQueue(socket) {
  for (const [game, q] of queues) {
    const before = q.length;
    queues.set(game, q.filter((e) => e.id !== socket.id));
    if (queues.get(game).length === 0 && queueTimers.has(game)) {
      clearTimeout(queueTimers.get(game));
      queueTimers.delete(game);
    }
    if (before !== queues.get(game).length) tryMatch(game);
  }
}

/* ------------------------------------------------------------------ *
 * Socket wiring
 * ------------------------------------------------------------------ */
const NAME_RE = /^[A-Za-z0-9_ -]{2,16}$/;

io.on('connection', (socket) => {
  let lastChat = 0;

  socket.emit('hello', {
    avatars: AVATARS, badges: BADGES,
    games: Object.fromEntries(Object.entries(GAMES).map(([k, g]) => [k, { name: g.name, min: g.min, max: g.max }])),
    globalChat: globalChat.slice(-40)
  });

  socket.on('profile', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const name = String(data && data.name || '').trim();
    const avatar = String(data && data.avatar || '👾');
    if (!NAME_RE.test(name)) return cb({ ok: false, error: 'Name must be 2-16 letters, digits, space, - or _' });
    if (!AVATARS.includes(avatar)) return cb({ ok: false, error: 'Pick an avatar' });
    const existing = socketsByName.get(name);
    if (existing && existing !== socket.id && io.sockets.sockets.has(existing)) {
      return cb({ ok: false, error: 'That name is in use right now' });
    }
    const prev = profiles.get(socket.id);
    if (prev) socketsByName.delete(prev.name);
    profiles.set(socket.id, { name, avatar });
    socketsByName.set(name, socket);
    const s = ensureStats(name);
    s.avatar = avatar;
    saveStats();
    cb({ ok: true, stats: { wins: s.wins, losses: s.losses, games: s.games, badges: s.badges } });
    socket.emit('me:stats', { wins: s.wins, losses: s.losses, games: s.games, badges: s.badges });
  });

  socket.on('room:create', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const prof = profiles.get(socket.id);
    if (!prof) return cb({ ok: false, error: 'Set your profile first' });
    const game = data && data.game;
    if (!GAMES[game]) return cb({ ok: false, error: 'Unknown game' });
    handleLeave(socket, true); // leave any current room first
    const maxPlayers = data.maxPlayers | 0;
    const room = createRoom(game, !!data.isPrivate, maxPlayers, socket.id);
    room.players.push({ id: socket.id, name: prof.name, avatar: prof.avatar, ready: false, connected: true });
    socket.join(room.code);
    cb({ ok: true, code: room.code });
    socket.emit('room:joined', { code: room.code, seat: 0 });
    emitRoom(room, 'room:state', roomSnapshot(room));
    broadcastLobby();
  });

  socket.on('room:join', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const prof = profiles.get(socket.id);
    if (!prof) return cb({ ok: false, error: 'Set your profile first' });
    const code = String(data && data.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.phase !== 'lobby') return cb({ ok: false, error: 'Match already in progress' });
    if (room.players.filter((p) => p.connected).length >= room.maxPlayers) {
      return cb({ ok: false, error: 'Room is full' });
    }
    if (room.players.some((p) => p.name === prof.name)) return cb({ ok: false, error: 'You are already in this room' });
    handleLeave(socket, true);
    room.players.push({ id: socket.id, name: prof.name, avatar: prof.avatar, ready: false, connected: true });
    socket.join(room.code);
    cb({ ok: true });
    socket.emit('room:joined', { code: room.code, seat: room.players.length - 1 });
    emitRoom(room, 'room:state', roomSnapshot(room));
    broadcastLobby();
  });

  socket.on('room:leave', () => handleLeave(socket, false));

  socket.on('room:ready', (data, cb) => {
    const room = [...rooms.values()].find((r) => r.players.some((p) => p.id === socket.id));
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.find((x) => x.id === socket.id);
    if (!p) return;
    p.ready = data && data.ready !== undefined ? !!data.ready : !p.ready;
    if (typeof cb === 'function') cb({ ok: true, ready: p.ready });
    emitRoom(room, 'room:state', roomSnapshot(room));
  });

  socket.on('room:start', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const room = [...rooms.values()].find((r) => r.players.some((p) => p.id === socket.id));
    if (!room) return cb({ ok: false, error: 'You are not in a room' });
    if (room.hostId !== socket.id) return cb({ ok: false, error: 'Only the host can start' });
    if (room.phase !== 'lobby') return cb({ ok: false, error: 'Game already running' });
    const active = room.players.filter((p) => p.connected);
    if (active.length < GAMES[room.game].min) return cb({ ok: false, error: 'Not enough players' });
    if (active.some((p) => !p.ready)) return cb({ ok: false, error: 'All players must be ready' });
    startGame(room);
    cb({ ok: true });
  });

  socket.on('match:quick', (data, cb) => {
    cb = typeof cb === 'function' ? cb : () => {};
    const prof = profiles.get(socket.id);
    if (!prof) return cb({ ok: false, error: 'Set your profile first' });
    const game = data && data.game;
    if (!GAMES[game]) return cb({ ok: false, error: 'Unknown game' });
    joinQueue(socket, game);
    cb({ ok: true });
  });

  socket.on('chat:send', (data) => {
    const prof = profiles.get(socket.id);
    if (!prof) return;
    const now = Date.now();
    if (now - lastChat < 300) return;
    lastChat = now;
    let text = String(data && data.text || '').trim().slice(0, 300);
    if (!text) return;
    const channel = data && data.channel === 'room' ? 'room' : 'global';
    const msg = { from: prof.name, avatar: prof.avatar, text, ts: now, channel };
    if (channel === 'global') {
      globalChat.push(msg);
      if (globalChat.length > 60) globalChat.shift();
      io.emit('global:chat', msg);
    } else {
      const room = [...rooms.values()].find((r) => r.players.some((p) => p.id === socket.id));
      if (!room) return;
      room.chat.push(msg);
      if (room.chat.length > 100) room.chat.shift();
      emitRoom(room, 'room:chat', msg);
    }
    const s = ensureStats(prof.name);
    s.chats++;
    if (s.chats >= 50) awardBadge(socketsByName, prof.name, 'chatty');
    saveStats();
  });

  socket.on('game:action', (payload) => {
    const room = [...rooms.values()].find((r) => r.players.some((p) => p.id === socket.id));
    if (!room || room.phase !== 'playing' || !room.state) return;
    const pi = room.players.findIndex((p) => p.id === socket.id);
    if (pi === -1) return;
    if (payload && payload.type === 'resign' && room.game === 'chess') {
      const events = GAMES[room.game].engine.action(room, room.state, pi, { type: 'resign' });
      if (events) {
        for (const e of events) emitRoom(room, 'game:event', e);
        emitRoom(room, 'game:state', room.state);
        finishGame(room, room.state.result.winner, room.state.result.reason);
      }
      return;
    }
    const events = GAMES[room.game].engine.action(room, room.state, pi, payload || {});
    if (!events) {
      socket.emit('notify', { type: 'error', text: 'Invalid move' });
      return;
    }
    for (const e of events) emitRoom(room, 'game:event', e);
    emitRoom(room, 'game:state', room.state);
    if (room.state.result) finishGame(room, room.state.result.winner, room.state.result.reason);
  });

  socket.on('game:rematch', () => {
    const room = [...rooms.values()].find((r) => r.players.some((p) => p.id === socket.id));
    if (!room || room.phase !== 'over') return;
    room.rematch[socket.id] = true;
    const active = room.players.filter((p) => p.connected);
    if (active.length >= GAMES[room.game].min && active.every((p) => room.rematch[p.id])) {
      room.players = active;
      room.hostId = room.players[0].id;
      startGame(room);
    } else {
      emitRoom(room, 'room:state', roomSnapshot(room));
    }
  });

  socket.on('disconnect', () => {
    leaveQueue(socket);
    handleLeave(socket, true);
    const prof = profiles.get(socket.id);
    if (prof && socketsByName.get(prof.name) === socket.id) socketsByName.delete(prof.name);
    profiles.delete(socket.id);
  });
});

setInterval(() => {
  // prune stale rooms (safety net)
  for (const room of [...rooms.values()]) destroyRoomIfEmpty(room);
}, 60000);

broadcastLobby();
server.listen(PORT, () => {
  console.log(`⚡ NEON ARCADE ARENA running → http://localhost:${PORT}`);
});
