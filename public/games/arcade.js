/* ARCADE — Tic-Tac-Toe & Connect 4 clients (server authoritative) */
(function () {
  'use strict';

  const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
  const MARK = ['✕', '◯'];

  function makeModule(kind) {
    let ctx = null, state = null, root = null;

    function statusEl() { return root.querySelector('.arcade-status'); }

    function render() {
      if (!state || !root) return;
      const myMove = !state.result && state.turn === ctx.mySeat;
      statusEl().textContent = state.result
        ? (state.result.winner ? 'WINNER: ' + state.result.winner + ' — ' + state.result.reason : 'DRAW — ' + state.result.reason)
        : myMove ? 'YOUR MOVE — ' + (ctx.mySeat === 0 ? MARK[0] : MARK[1])
          : 'WAITING FOR ' + state.players[state.turn] + '…';
      statusEl().classList.toggle('mine', myMove);
      ctx.setTurn(state.result ? 'GAME OVER' : 'Turn: ' + state.players[state.turn], myMove);
    }

    return {
      mount(container, gameCtx) {
        ctx = gameCtx;
        root = document.createElement('div');
        root.className = 'arcade-wrap';
        if (kind === 'ttt') {
          root.innerHTML = `
            <div class="arcade-status"></div>
            <div class="tt-grid"></div>`;
          const grid = root.querySelector('.tt-grid');
          for (let i = 0; i < 9; i++) {
            const cell = document.createElement('button');
            cell.className = 'tt-cell';
            cell.dataset.idx = i;
            cell.addEventListener('click', () => {
              if (!state || state.result || state.turn !== ctx.mySeat) return;
              ctx.sound.play('click');
              ctx.emitAction('move', { idx: i });
            });
            grid.appendChild(cell);
          }
        } else {
          root.innerHTML = `
            <div class="arcade-status"></div>
            <div class="c4-drops"></div>
            <div class="c4-board"></div>`;
          const drops = root.querySelector('.c4-drops');
          drops.style.display = 'grid';
          drops.style.gridTemplateColumns = 'repeat(7, 56px)';
          drops.style.gap = '6px';
          drops.style.padding = '0 10px';
          const board = root.querySelector('.c4-board');
          for (let c = 0; c < 7; c++) {
            const d = document.createElement('button');
            d.className = 'c4-drop';
            d.textContent = '▼';
            d.dataset.col = c;
            d.addEventListener('click', () => {
              if (!state || state.result || state.turn !== ctx.mySeat) return;
              ctx.sound.play('click');
              ctx.emitAction('move', { col: c });
            });
            drops.appendChild(d);
          }
          for (let i = 0; i < 42; i++) {
            const cell = document.createElement('div');
            cell.className = 'c4-cell';
            cell.dataset.idx = i;
            board.appendChild(cell);
          }
        }
        container.appendChild(root);
      },
      onState(s) {
        state = s;
        if (kind === 'ttt') {
          state.grid.forEach((v, i) => {
            const cell = root.querySelector(`.tt-cell[data-idx="${i}"]`);
            cell.textContent = v === null ? '' : MARK[v];
            cell.classList.toggle('o', v === 1);
            cell.disabled = v !== null || !!state.result || state.turn !== ctx.mySeat;
            cell.classList.remove('winline');
          });
          const win = state.result && state.result.reason === 'three in a row';
          // winning line known via last event; fallback: highlight none
        } else {
          state.grid.forEach((v, i) => {
            const cell = root.querySelector(`.c4-cell[data-idx="${i}"]`);
            cell.className = 'c4-cell' + (v === 0 ? ' p0' : v === 1 ? ' p1' : '');
          });
          root.querySelectorAll('.c4-drop').forEach((d) => {
            d.disabled = !!state.result || state.turn !== ctx.mySeat;
          });
        }
        render();
      },
      onEvent(ev) {
        if (ev.ev === 'move') ctx.sound.play('move');
        if (ev.ev === 'win') {
          ctx.sound.play('capture');
          if (ev.line) {
            ev.line.forEach((i) => {
              const sel = kind === 'ttt' ? `.tt-cell[data-idx="${i}"]` : `.c4-cell[data-idx="${i}"]`;
              const cell = root && root.querySelector(sel);
              if (cell) cell.classList.add('winline');
            });
          }
        }
      },
      unmount() {
        root = null; state = null; ctx = null;
      }
    };
  }

  window.GAMES.tictactoe = makeModule('ttt');
  window.GAMES.connect4 = makeModule('c4');
})();
