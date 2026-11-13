/* CHESS — client renderer & input (server is authoritative) */
(function () {
  'use strict';

  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const FILES = 'abcdefgh';
  const sqName = (i) => FILES[i & 7] + (8 - (i >> 3));

  let canvas, ctx2d, ctx = null, state = null, sel = null, raf = null;
  let promoPending = null;

  function myColor() {
    return state.players.w === (ctx.players[ctx.mySeat] && ctx.players[ctx.mySeat].name) ? 'w' : 'b';
  }

  function drawBoard() {
    const S = canvas.width / 8;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const light = (r + c) % 2 === 0;
      ctx2d.fillStyle = light ? '#1c2a47' : '#12203c';
      ctx2d.fillRect(c * S, r * S, S, S);
    }
    // last move highlight
    if (state.history && state.history.length) {
      ctx2d.fillStyle = 'rgba(255,210,63,.18)';
      const last = state.history[state.history.length - 1];
      if (last.fromIdx !== undefined) {
        ctx2d.fillRect((last.fromIdx & 7) * S, (last.fromIdx >> 3) * S, S, S);
        ctx2d.fillRect((last.toIdx & 7) * S, (last.toIdx >> 3) * S, S, S);
      }
    }
  }

  function legalTargets(from) {
    if (!state.legal) return [];
    return state.legal.filter((m) => m.from === from).map((m) => m.to);
  }

  function drawPieces() {
    const S = canvas.width / 8;
    state.board.forEach((p, i) => {
      if (!p) return;
      const c = i & 7, r = i >> 3;
      const x = c * S + S / 2, y = r * S + S / 2;
      ctx2d.font = `${S * 0.78}px "Segoe UI Symbol", serif`;
      ctx2d.textAlign = 'center';
      ctx2d.textBaseline = 'middle';
      ctx2d.shadowColor = 'rgba(0,0,0,.8)';
      ctx2d.shadowBlur = 6;
      ctx2d.fillStyle = p.c === 'w' ? '#f4f8ff' : '#0a0a12';
      ctx2d.fillText(GLYPH[p.t], x, y + 2);
      ctx2d.shadowBlur = 0;
      if (p.c === 'b') { // rim for visibility
        ctx2d.strokeStyle = 'rgba(255,255,255,.25)';
        ctx2d.lineWidth = 1;
        ctx2d.strokeText(GLYPH[p.t], x, y + 2);
      }
    });
  }

  function drawOverlays() {
    const S = canvas.width / 8;
    if (sel !== null) {
      ctx2d.strokeStyle = '#00f0ff';
      ctx2d.lineWidth = 3;
      ctx2d.shadowColor = '#00f0ff';
      ctx2d.shadowBlur = 12;
      ctx2d.strokeRect((sel & 7) * S + 2, (sel >> 3) * S + 2, S - 4, S - 4);
      ctx2d.shadowBlur = 0;
      for (const to of legalTargets(sel)) {
        ctx2d.fillStyle = 'rgba(43,255,136,.35)';
        ctx2d.beginPath();
        ctx2d.arc((to & 7) * S + S / 2, (to >> 3) * S + S / 2, S * 0.18, 0, Math.PI * 2);
        ctx2d.fill();
      }
    }
    if (state.result && !state.result.winner) return;
    // king in check marker
    const checked = state.turn; // color currently to move
    for (let i = 0; i < 64; i++) {
      const p = state.board[i];
      if (p && p.t === 'k' && p.c === checked && allMovesCount() === 0) {
        ctx2d.fillStyle = 'rgba(255,56,96,.25)';
        ctx2d.fillRect((i & 7) * S, (i >> 3) * S, S, S);
        ctx2d.strokeStyle = '#ff3860';
        ctx2d.lineWidth = 2;
        ctx2d.strokeRect((i & 7) * S + 1, (i >> 3) * S + 1, S - 2, S - 2);
      }
    }
  }
  function allMovesCount() { return state.legal ? state.legal.length : 0; }

  function drawCoords() {
    const S = canvas.width / 8;
    ctx2d.fillStyle = 'rgba(143,162,200,.6)';
    ctx2d.font = `${S * 0.2}px Orbitron, sans-serif`;
    for (let c = 0; c < 8; c++) ctx2d.fillText(FILES[c], c * S + S * 0.06, canvas.width - 4);
    for (let r = 0; r < 8; r++) ctx2d.fillText(String(8 - r), 2, r * S + S * 0.24);
  }

  function render() {
    if (!state || !ctx2d) return;
    drawBoard();
    drawPieces();
    drawOverlays();
    drawCoords();
    raf = requestAnimationFrame(render);
  }

  function updateSide() {
    const side = document.getElementById('chess-side');
    if (!side) return;
    const clocks = state.clocks || { w: 0, b: 0 };
    const fmt = (ms) => {
      const s = Math.max(0, Math.ceil(ms / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    side.innerHTML = `
      <div class="chess-clocks">
        <span class="chess-clock ${state.turn === 'w' && !state.result ? 'active' : ''} ${clocks.w < 30000 ? 'low' : ''}">♔ ${esc(state.players.w)} ${fmt(clocks.w)}</span>
        <span class="chess-clock ${state.turn === 'b' && !state.result ? 'active' : ''} ${clocks.b < 30000 ? 'low' : ''}">♚ ${esc(state.players.b)} ${fmt(clocks.b)}</span>
      </div>
      <div class="chess-history">
        ${state.history.map((h, i) => `<div class="chess-hist-row"><span>${Math.floor(i / 2) + 1}.</span><span>${esc(h.san)}</span></div>`).join('') || '<p class="empty-note">No moves yet</p>'}
      </div>`;
  }
  const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

  function myTurn() { return !state.result && state.turn === myColor(); }

  function onClick(e) {
    if (!state || !myTurn() || promoPending) return;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const x = (e.clientX - rect.left) * sx;
    const y = (e.clientY - rect.top) * sx;
    const c = Math.floor(x / (canvas.width / 8));
    const r = Math.floor(y / (canvas.width / 8));
    if (c < 0 || c > 7 || r < 0 || r > 7) return;
    const idx = r * 8 + c;
    if (sel !== null && legalTargets(sel).includes(idx)) {
      const piece = state.board[sel];
      const promoRank = piece && piece.t === 'p' && (idx >> 3 === 0 || idx >> 3 === 7);
      if (promoRank) { askPromotion(sel, idx); return; }
      ctx.sound.play('move');
      ctx.emitAction('move', { from: sel, to: idx });
      sel = null;
      return;
    }
    const p = state.board[idx];
    if (p && p.c === myColor() && legalTargets(idx).length) {
      sel = idx;
      ctx.sound.play('hover');
    } else {
      sel = null;
    }
  }

  function askPromotion(from, to) {
    promoPending = { from, to };
    const modal = document.getElementById('modal-promo');
    const choices = document.getElementById('promo-choices');
    choices.innerHTML = '';
    ['q', 'r', 'b', 'n'].forEach((t) => {
      const b = document.createElement('button');
      b.className = 'promo-btn';
      b.textContent = GLYPH[t];
      b.addEventListener('click', () => {
        ctx.sound.play('move');
        ctx.emitAction('move', { from: promoPending.from, to: promoPending.to, promo: t });
        promoPending = null;
        sel = null;
        modal.classList.add('hidden');
      });
      choices.appendChild(b);
    });
    modal.classList.remove('hidden');
  }

  window.GAMES.chess = {
    mount(container, gameCtx) {
      ctx = gameCtx;
      const wrap = document.createElement('div');
      wrap.className = 'chess-wrap';
      wrap.innerHTML = `
        <canvas id="chess-canvas" width="520" height="520"></canvas>
        <div class="chess-side" id="chess-side"></div>`;
      container.appendChild(wrap);
      canvas = wrap.querySelector('canvas');
      ctx2d = canvas.getContext('2d');
      canvas.addEventListener('click', onClick);
      // board is rendered mirrored for black so you always play "upward"
    },
    onState(s) {
      state = s;
      const last = state.history && state.history[state.history.length - 1];
      if (last) { /* server sends san only; keep sel simple */ }
      if (!state.result) {
        const moverName = state.players[state.turn];
        ctx.setTurn('Turn: ' + (moverName || '?') + ' (' + (state.turn === 'w' ? 'WHITE' : 'BLACK') + ')', moverName === ctx.players[ctx.mySeat].name);
      }
      updateSide();
      if (!raf && ctx2d) render();
    },
    onClock(c) {
      if (state && state.clocks) {
        state.clocks = c.clocks;
        updateSide();
      }
    },
    onEvent(ev) {
      if (ev.ev === 'move') ctx.sound.play('move');
      if (ev.ev === 'resign') ctx.sound.play('lose');
    },
    unmount() {
      cancelAnimationFrame(raf);
      raf = null;
      document.getElementById('modal-promo').classList.add('hidden');
      promoPending = null;
      ctx2d = null; canvas = null; state = null; sel = null; ctx = null;
    }
  };
})();
