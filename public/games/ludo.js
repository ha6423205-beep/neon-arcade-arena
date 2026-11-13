/* LUDO — client renderer & input (server is authoritative) */
(function () {
  'use strict';

  // 15x15 grid track, clockwise loop starting at (6,0)
  const PATH = [
    [6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
    [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],
    [0, 7],
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
    [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
    [7, 14],
    [8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
    [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8],
    [14, 7],
    [14, 6], [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
    [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
    [7, 0]
  ];
  const STARTS = [1, 14, 27, 40];
  const SAFE = new Set([1, 9, 14, 22, 27, 35, 40, 48]);
  // seat order: 0 red(TL) 1 blue(BL) 2 yellow(BR) 3 green(TR)
  const HOME_COL = [
    [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
    [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
    [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
    [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]]
  ];
  const BASES = [
    { x: 1, y: 1, color: '#ff3860', dark: '#7a1030' },   // red TL
    { x: 1, y: 10, color: '#38b6ff', dark: '#0a3f66' },  // blue BL
    { x: 10, y: 10, color: '#ffd23f', dark: '#6b5504' },// yellow BR
    { x: 10, y: 1, color: '#2bff88', dark: '#0a5c2c' }  // green TR
  ];
  const COLORS = ['#ff3860', '#38b6ff', '#ffd23f', '#2bff88'];

  let canvas, ctx2d, ctx = null, state = null, raf = null, anim = { dice: null, t: 0 };
  const cell = () => canvas.width / 15;

  function relOf(pl, tk) {
    if (tk.area === 'track') return (tk.pos - pl.start + 52) % 52;
    if (tk.area === 'homecol') return 50 + tk.pos;
    return 56;
  }
  function canMove(pl, tk, dice) {
    if (state.result) return false;
    if (tk.area === 'base') return dice === 6;
    if (tk.area === 'done') return false;
    return relOf(pl, tk) + dice <= 56;
  }
  function tokenCoord(pi, ti) {
    const pl = state.players[pi];
    const tk = pl.tokens[ti];
    const c = cell();
    if (tk.area === 'base') {
      const b = BASES[pi];
      const off = [[1.75, 1.75], [3.25, 1.75], [1.75, 3.25], [3.25, 3.25]][ti];
      return { x: (b.x + off[0]) * c, y: (b.y + off[1]) * c };
    }
    if (tk.area === 'track') {
      const [gc, gr] = PATH[tk.pos];
      return { x: (gc + 0.5) * c, y: (gr + 0.5) * c };
    }
    if (tk.area === 'homecol') {
      const [gc, gr] = HOME_COL[pi][tk.pos - 1];
      return { x: (gc + 0.5) * c, y: (gr + 0.5) * c };
    }
    // done — rest in the center triangle
    const ang = (pi * Math.PI) / 2 - Math.PI / 2;
    return { x: 7.5 * c + Math.cos(ang) * c * 0.7, y: 7.5 * c + Math.sin(ang) * c * 0.7 };
  }

  function drawBoard() {
    const c = cell();
    const W = canvas.width;
    // background
    ctx2d.fillStyle = '#0b1322';
    ctx2d.fillRect(0, 0, W, W);
    // bases
    BASES.forEach((b, i) => {
      ctx2d.fillStyle = b.dark;
      ctx2d.fillRect(b.x * c, b.y * c, 6 * c, 6 * c);
      ctx2d.strokeStyle = b.color;
      ctx2d.lineWidth = 2;
      ctx2d.strokeRect(b.x * c + 2, b.y * c + 2, 6 * c - 4, 6 * c - 4);
      // inner white square
      ctx2d.fillStyle = '#101a2e';
      ctx2d.fillRect((b.x + 1.25) * c, (b.y + 1.25) * c, 3.5 * c, 3.5 * c);
      ctx2d.fillStyle = b.color;
      ctx2d.globalAlpha = 0.25;
      ctx2d.fillRect((b.x + 1.25) * c, (b.y + 1.25) * c, 3.5 * c, 3.5 * c);
      ctx2d.globalAlpha = 1;
    });
    // track
    PATH.forEach(([gc, gr], abs) => {
      ctx2d.fillStyle = SAFE.has(abs) ? 'rgba(43,255,136,.14)' : '#e8f1ff';
      ctx2d.fillRect(gc * c + 1, gr * c + 1, c - 2, c - 2);
      ctx2d.strokeStyle = '#1e2a44';
      ctx2d.lineWidth = 1;
      ctx2d.strokeRect(gc * c + 1, gr * c + 1, c - 2, c - 2);
      if (SAFE.has(abs)) {
        ctx2d.fillStyle = '#2bff88';
        ctx2d.font = `${c * 0.5}px sans-serif`;
        ctx2d.textAlign = 'center';
        ctx2d.textBaseline = 'middle';
        ctx2d.fillText('★', (gc + 0.5) * c, (gr + 0.55) * c);
      }
    });
    // colored start cells
    STARTS.forEach((abs, i) => {
      const [gc, gr] = PATH[abs];
      ctx2d.fillStyle = COLORS[i];
      ctx2d.globalAlpha = 0.85;
      ctx2d.fillRect(gc * c + 1, gr * c + 1, c - 2, c - 2);
      ctx2d.globalAlpha = 1;
    });
    // home columns
    HOME_COL.forEach((col, i) => {
      col.forEach(([gc, gr]) => {
        ctx2d.fillStyle = COLORS[i];
        ctx2d.globalAlpha = 0.6;
        ctx2d.fillRect(gc * c + 1, gr * c + 1, c - 2, c - 2);
        ctx2d.globalAlpha = 1;
        ctx2d.strokeStyle = '#1e2a44';
        ctx2d.strokeRect(gc * c + 1, gr * c + 1, c - 2, c - 2);
      });
    });
    // center home triangle
    const cx = 7.5 * c, cy = 7.5 * c, r = 1.5 * c;
    COLORS.forEach((col, i) => {
      ctx2d.fillStyle = col;
      ctx2d.beginPath();
      const a0 = (i * Math.PI) / 2 - Math.PI / 4 + Math.PI / 2;
      ctx2d.moveTo(cx, cy);
      ctx2d.lineTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
      ctx2d.lineTo(cx + r * Math.cos(a0 + Math.PI / 2), cy + r * Math.sin(a0 + Math.PI / 2));
      ctx2d.closePath();
      ctx2d.fill();
    });
  }

  function drawTokens(movableSet) {
    const c = cell();
    state.players.forEach((pl, pi) => {
      if (pl.gone) return;
      pl.tokens.forEach((tk, ti) => {
        const { x, y } = tokenCoord(pi, ti);
        const r = c * 0.36;
        const isMine = ctx.mySeat === pi;
        const movable = movableSet && movableSet.has(pi + ':' + ti);
        // glow
        if (movable) {
          const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
          ctx2d.save();
          ctx2d.shadowColor = COLORS[pi];
          ctx2d.shadowBlur = 18 * pulse;
          ctx2d.fillStyle = COLORS[pi];
          ctx2d.beginPath();
          ctx2d.arc(x, y, r, 0, Math.PI * 2);
          ctx2d.fill();
          ctx2d.restore();
        }
        ctx2d.beginPath();
        ctx2d.arc(x, y, r, 0, Math.PI * 2);
        ctx2d.fillStyle = COLORS[pi];
        ctx2d.fill();
        ctx2d.lineWidth = 2;
        ctx2d.strokeStyle = isMine ? '#ffffff' : 'rgba(0,0,0,.55)';
        ctx2d.stroke();
        ctx2d.fillStyle = 'rgba(255,255,255,.85)';
        ctx2d.font = `bold ${c * 0.4}px Orbitron, sans-serif`;
        ctx2d.textAlign = 'center';
        ctx2d.textBaseline = 'middle';
        ctx2d.fillText(String(ti + 1), x, y);
      });
    });
  }

  function drawDicePanel(movableSet) {
    const diceEl = document.getElementById('ludo-dice');
    if (!diceEl) return;
    const myTurn = !state.result && state.turn === ctx.mySeat;
    const needRoll = myTurn && state.dice === null;
    const needMove = myTurn && state.dice !== null && movableSet && movableSet.size > 0;
    diceEl.innerHTML = `
      <div class="ludo-dice-label">${state.result ? 'GAME OVER'
      : myTurn ? (needRoll ? 'YOUR ROLL' : needMove ? 'PICK A TOKEN' : 'MOVING…')
        : 'WAITING: ' + (state.players[state.turn] ? state.players[state.turn].name : '')}</div>
      <div class="ludo-dice-face">${state.dice ? '⚀⚁⚂⚃⚄⚅'[state.dice - 1] : '?'}</div>
      <button class="btn btn-primary" id="ludo-roll" ${needRoll ? '' : 'disabled'}>🎲 ROLL</button>
      <div class="ludo-players">${state.players.map((p, i) => `
        <div class="ludo-pl ${i === state.turn && !state.result ? 'active' : ''} ${p.gone ? 'gone' : ''}">
          <span style="color:${COLORS[i]}">●</span> ${p.name} · ${p.tokens.filter((t) => t.area === 'done').length}/4 home
        </div>`).join('')}</div>`;
    const rollBtn = document.getElementById('ludo-roll');
    if (rollBtn) rollBtn.addEventListener('click', () => {
      ctx.sound.play('dice');
      ctx.emitAction('roll');
    });
  }

  function computeMovable() {
    if (state.dice === null || state.result) return null;
    const pl = state.players[state.turn];
    const set = new Set();
    pl.tokens.forEach((tk, ti) => { if (canMove(pl, tk, state.dice)) set.add(state.turn + ':' + ti); });
    return set.size ? set : null;
  }

  function render() {
    if (!state || !ctx2d) return;
    drawBoard();
    const movable = computeMovable();
    drawTokens(movable);
    drawDicePanel(movable);
    raf = requestAnimationFrame(render);
  }

  function canvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const x = (e.clientX - rect.left) * sx;
    const y = (e.clientY - rect.top) * sx;
    return { x, y, rect };
  }
  function onClick(e) {
    if (!state || state.result) return;
    const movable = computeMovable();
    if (!movable) return;
    const { x, y } = canvasPos(e);
    const c = cell();
    state.players[state.turn].tokens.forEach((tk, ti) => {
      if (!movable.has(state.turn + ':' + ti)) return;
      const p = tokenCoord(state.turn, ti);
      if (Math.hypot(p.x - x, p.y - y) <= c * 0.45) {
        ctx.sound.play('click');
        ctx.emitAction('move', { token: ti });
      }
    });
  }

  window.GAMES.ludo = {
    mount(container, gameCtx) {
      ctx = gameCtx;
      const wrap = document.createElement('div');
      wrap.className = 'ludo-wrap';
      wrap.innerHTML = `
        <canvas id="ludo-canvas" width="600" height="600"></canvas>
        <div class="ludo-side" id="ludo-dice"></div>`;
      container.appendChild(wrap);
      canvas = wrap.querySelector('canvas');
      ctx2d = canvas.getContext('2d');
      canvas.addEventListener('click', onClick);
      ctx.setTurn('', false);
    },
    onState(s) {
      state = s;
      if (!state.result) {
        const cur = state.players[state.turn];
        ctx.setTurn('Turn: ' + (cur ? cur.name : '?'), cur && ctx.isMyTurn(state.turn));
      }
      if (!raf && ctx2d) render();
    },
    onEvent(ev) {
      if (ev.ev === 'roll') { ctx.sound.play('dice'); }
      if (ev.ev === 'capture') { ctx.sound.play('capture'); }
      if (ev.ev === 'move' || ev.ev === 'tokenhome') { ctx.sound.play('move'); }
    },
    onOver(result) {
      if (state) state.result = state.result || result;
    },
    unmount() {
      cancelAnimationFrame(raf);
      raf = null;
      ctx2d = null;
      canvas = null;
      state = null;
      ctx = null;
    }
  };
})();
