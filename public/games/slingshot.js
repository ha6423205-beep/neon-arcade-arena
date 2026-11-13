/* SLINGSHOT DUEL — turn-based physics siege (Matter.js, server authoritative HP) */
(function () {
  'use strict';

  const W = 960, H = 540, GROUND = 470;
  const PROJ_R = 10, MAX_LAUNCH = 27;

  let canvas, ctx2d, ctx = null, state = null;
  let engine = null, runnerRaf = null;
  let blockBodies = [];            // matter bodies for blocks
  let projectile = null, projActive = false, projStart = null, projStill = 0;
  let myShot = false, hits = [], hitIds = new Set();
  let dragging = false, drag = { x: 0, y: 0 }, aimStart = null;
  let particles = [], sending = false, animDone = false;

  const { Engine, World, Bodies, Body, Events, Composite } = Matter;

  function mySeat() { return ctx ? ctx.mySeat : 0; }
  function mySide() { return mySeat() === 0 ? 'L' : 'R'; }
  function anchorOf(side) { return side === 'L' ? { x: 430, y: 420 } : { x: 530, y: 420 }; }

  /* ---------- world ---------- */
  function clearWorld() {
    if (engine) {
      World.clear(engine.world, false);
      Engine.clear(engine);
    }
    engine = null;
    blockBodies = [];
    projectile = null; projActive = false; projStill = 0;
    particles = []; hits = []; hitIds = new Set();
    dragging = false; sending = false;
  }
  function buildWorld() {
    clearWorld();
    engine = Engine.create({ gravity: { x: 0, y: 1 } });
    const world = engine.world;
    World.add(world, [
      Bodies.rectangle(W / 2, GROUND + 35, W + 200, 70, { isStatic: true, label: 'ground' })
    ]);
    for (const side of ['L', 'R']) {
      for (const b of state.blocks[side]) {
        if (b.hp <= 0) continue;
        const body = Bodies.rectangle(b.x, b.y, b.w, b.h, {
          isStatic: true, label: 'block', blockSide: side, blockId: b.id,
          restitution: 0.1, friction: 0.6
        });
        blockBodies.push(body);
        World.add(world, body);
      }
    }
  }

  function launch(side, angle, power) {
    const a = anchorOf(side);
    const speed = 6 + power * (MAX_LAUNCH - 6);
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    projectile = Bodies.circle(a.x, a.y, PROJ_R, {
      restitution: 0.45, friction: 0.02, frictionAir: 0.001,
      label: 'projectile', density: 0.02
    });
    Body.setVelocity(projectile, { x: vx, y: vy });
    projActive = true; projStill = 0;
    hits = []; hitIds = new Set();
    World.add(engine.world, projectile);
    ctx.sound.play('shot');
  }

  function damageFromImpact(speed) {
    return Math.min(3, Math.max(1, Math.round(speed / 6)));
  }

  function setupCollisions() {
    Events.on(engine, 'collisionStart', (evt) => {
      for (const pair of evt.pairs) {
        const labels = [pair.bodyA.label, pair.bodyB.label];
        if (!labels.includes('projectile')) continue;
        const other = pair.bodyA.label === 'projectile' ? pair.bodyB : pair.bodyA;
        const speed = Math.hypot(projectile.velocity.x, projectile.velocity.y);
        if (other.label === 'block' && !hitIds.has(other.blockId)) {
          hitIds.add(other.blockId);
          hits.push({ id: other.blockId, dmg: damageFromImpact(speed) });
          spawnParticles(other.position.x, other.position.y);
          ctx.sound.play('hit');
        }
      }
    });
  }

  function spawnParticles(x, y) {
    for (let i = 0; i < 10; i++) {
      particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 8,
        vy: -Math.random() * 8 - 2,
        life: 1,
        color: ['#ffd23f', '#ff2fd0', '#00f0ff'][Math.floor(Math.random() * 3)]
      });
    }
  }

  function tick() {
    if (!engine) return;
    Engine.update(engine, 1000 / 60);
    if (projActive && projectile) {
      const v = projectile.velocity;
      const sp = Math.hypot(v.x, v.y);
      if (sp < 0.5) projStill++; else projStill = 0;
      const out = projectile.position.x < -60 || projectile.position.x > W + 60 || projectile.position.y > H + 60;
      if (projStill > 40 || out || projectile.position.y > GROUND + 40) {
        settleShot();
      }
    }
    particles = particles.filter((p) => {
      p.x += p.vx; p.y += p.vy; p.vy += 0.4; p.life -= 0.03;
      return p.life > 0;
    });
    draw();
    runnerRaf = requestAnimationFrame(tick);
  }

  function settleShot() {
    if (!projActive) return;
    projActive = false;
    if (myShot && !sending && fireParams) {
      sending = true;
      ctx.emitAction('fire', { angle: fireParams.angle, power: fireParams.power, hits });
      myShot = false;
    }
    if (projectile) {
      World.remove(engine.world, projectile);
      projectile = null;
    }
  }
  let fireParams = null;

  /* ---------- input ---------- */
  function onDown(e) {
    if (!state || state.result || state.turn !== mySeat() || projActive) return;
    const p = toCanvas(e);
    const a = anchorOf(mySide());
    if (Math.hypot(p.x - a.x, p.y - a.y) < 80) {
      dragging = true;
      drag = p;
      e.preventDefault();
    }
  }
  function onMove(e) {
    if (!dragging) return;
    const p = toCanvas(e);
    drag = p;
    e.preventDefault();
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    const a = anchorOf(mySide());
    const dx = a.x - drag.x, dy = a.y - drag.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 18) return; // too weak, cancel
    const power = Math.min(dist, 130) / 130;
    const angle = Math.atan2(-dy, -dx);
    const speed = 6 + power * (MAX_LAUNCH - 6);
    fireParams = { angle, power };
    myShot = true;
    launch(mySide(), angle, power);
  }
  function toCanvas(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = W / rect.width;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * (H / rect.height) };
  }

  /* ---------- drawing ---------- */
  function blockColor(side, type, hp, maxHp) {
    if (type === 'crown') return '#ffd23f';
    const ratio = hp / maxHp;
    const base = side === 'L' ? [43, 255, 136] : [255, 47, 208];
    const dim = Math.round(0.35 + 0.65 * ratio);
    return `rgb(${Math.round(base[0] * dim)},${Math.round(base[1] * dim)},${Math.round(base[2] * dim)})`;
  }
  function draw() {
    if (!ctx2d || !state) return;
    ctx2d.clearRect(0, 0, W, H);
    // sky
    const grad = ctx2d.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#0a0f20');
    grad.addColorStop(1, '#131c33');
    ctx2d.fillStyle = grad;
    ctx2d.fillRect(0, 0, W, H);
    // stars
    ctx2d.fillStyle = 'rgba(255,255,255,.25)';
    for (let i = 0; i < 40; i++) {
      const x = (i * 137.5) % W, y = (i * 89.7) % 300;
      ctx2d.fillRect(x, y, 2, 2);
    }
    // ground
    ctx2d.fillStyle = '#1b2b4a';
    ctx2d.fillRect(0, GROUND, W, H - GROUND);
    ctx2d.strokeStyle = '#00f0ff';
    ctx2d.shadowColor = '#00f0ff';
    ctx2d.shadowBlur = 10;
    ctx2d.beginPath();
    ctx2d.moveTo(0, GROUND); ctx2d.lineTo(W, GROUND);
    ctx2d.stroke();
    ctx2d.shadowBlur = 0;
    // blocks (from matter world so destroyed ones vanish)
    for (const body of blockBodies) {
      const b = findBlock(body.blockSide, body.blockId);
      if (!b) continue;
      const { x, y } = body.position;
      ctx2d.save();
      ctx2d.translate(x, y);
      ctx2d.rotate(body.angle);
      ctx2d.fillStyle = blockColor(body.blockSide, b.type, b.hp, b.type === 'crown' ? 3 : 2);
      ctx2d.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx2d.strokeStyle = 'rgba(255,255,255,.35)';
      ctx2d.lineWidth = 1.5;
      ctx2d.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
      if (b.type === 'crown') {
        ctx2d.fillStyle = '#05070d';
        ctx2d.font = '20px serif';
        ctx2d.textAlign = 'center';
        ctx2d.textBaseline = 'middle';
        ctx2d.fillText('♛', 0, 1);
      }
      // hp pips
      const maxHp = b.type === 'crown' ? 3 : 2;
      for (let h = 0; h < b.hp; h++) {
        ctx2d.fillStyle = '#e8f1ff';
        ctx2d.fillRect(-b.w / 2 + 4 + h * 6, b.h / 2 - 6, 4, 3);
      }
      ctx2d.restore();
    }
    // slingshots
    drawSlingshot('L');
    drawSlingshot('R');
    // aim preview
    if (dragging) {
      const a = anchorOf(mySide());
      ctx2d.strokeStyle = '#ffd23f';
      ctx2d.lineWidth = 3;
      ctx2d.setLineDash([6, 6]);
      ctx2d.beginPath();
      ctx2d.moveTo(a.x, a.y); ctx2d.lineTo(drag.x, drag.y);
      ctx2d.stroke();
      ctx2d.setLineDash([]);
      // trajectory preview
      const dx = a.x - drag.x, dy = a.y - drag.y;
      const dist = Math.min(Math.hypot(dx, dy), 130);
      const power = dist / 130;
      const speed = 6 + power * (MAX_LAUNCH - 6);
      const angle = Math.atan2(-dy, -dx);
      let px = a.x, py = a.y;
      let vx = Math.cos(angle) * speed, vy = Math.sin(angle) * speed;
      ctx2d.fillStyle = 'rgba(255,210,63,.5)';
      for (let s = 0; s < 60; s++) {
        px += vx; py += vy; vy += 1;
        if (py > GROUND) break;
        if (s % 3 === 0) ctx2d.fillRect(px - 1.5, py - 1.5, 3, 3);
      }
    }
    // projectile
    if (projectile && projActive) {
      ctx2d.fillStyle = '#ff2fd0';
      ctx2d.shadowColor = '#ff2fd0';
      ctx2d.shadowBlur = 14;
      ctx2d.beginPath();
      ctx2d.arc(projectile.position.x, projectile.position.y, PROJ_R, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.shadowBlur = 0;
    }
    // particles
    for (const p of particles) {
      ctx2d.globalAlpha = Math.max(0, p.life);
      ctx2d.fillStyle = p.color;
      ctx2d.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx2d.globalAlpha = 1;
  }
  function drawSlingshot(side) {
    const a = anchorOf(side);
    const mine = side === mySide();
    const color = mine ? '#2bff88' : '#8fa2c8';
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = 5;
    ctx2d.beginPath();
    ctx2d.moveTo(a.x - 16, GROUND);
    ctx2d.lineTo(a.x, a.y + 8);
    ctx2d.lineTo(a.x + 16, GROUND);
    ctx2d.stroke();
    ctx2d.strokeStyle = 'rgba(232,241,255,.5)';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(a.x - 12, a.y - 6);
    ctx2d.lineTo(a.x, a.y + 8);
    ctx2d.lineTo(a.x + 12, a.y - 6);
    ctx2d.stroke();
    if (mine && !state.result && state.turn === mySeat() && !projActive) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 250);
      ctx2d.strokeStyle = `rgba(43,255,136,${0.3 + 0.3 * pulse})`;
      ctx2d.beginPath();
      ctx2d.arc(a.x, a.y, 46, 0, Math.PI * 2);
      ctx2d.stroke();
    }
  }
  function findBlock(side, id) {
    return state.blocks[side].find((b) => b.id === id);
  }

  function hud() {
    const el = document.getElementById('sling-hud');
    if (!el || !state) return;
    const totalHp = (side) => state.blocks[side].reduce((s, b) => s + Math.max(0, b.hp), 0);
    el.innerHTML = `
      <div class="sling-top">
        <span class="sling-hud">⛨ ${esc(state.players[0])} L-FORCE: ${totalHp('L')}</span>
        <span class="sling-hud ammo">🎯 SHOTS: ${state.ammo[0]} / ${state.ammo[1]}</span>
        <span class="sling-hud">⛨ ${esc(state.players[1])} R-FORCE: ${totalHp('R')}</span>
      </div>
      <p class="sling-tip ${state.turn === mySeat() && !state.result ? 'mine' : ''}">
        ${state.result ? 'DUEL OVER'
      : state.turn === mySeat() ? 'YOUR TURN — drag from the glowing slingshot and release to fire!'
        : 'INCOMING — ' + state.players[state.turn] + ' is aiming…'}</p>`;
  }
  const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- sync block removal ---------- */
  function refreshWorldBlocks() {
    // remove bodies whose block hp <= 0
    blockBodies = blockBodies.filter((b) => {
      const blk = findBlock(b.blockSide, b.blockId);
      if (!blk || blk.hp <= 0) { World.remove(engine.world, b); return false; }
      return true;
    });
  }

  window.GAMES.slingshot = {
    mount(container, gameCtx) {
      ctx = gameCtx;
      const wrap = document.createElement('div');
      wrap.className = 'sling-wrap';
      wrap.innerHTML = `
        <div class="sling-top-wrap" id="sling-hud"></div>
        <canvas id="sling-canvas" width="${W}" height="${H}"></canvas>`;
      container.appendChild(wrap);
      canvas = wrap.querySelector('canvas');
      ctx2d = canvas.getContext('2d');
      canvas.addEventListener('mousedown', onDown);
      canvas.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      canvas.addEventListener('touchstart', (e) => { onDown(e.touches[0]); }, { passive: false });
      canvas.addEventListener('touchmove', (e) => { onMove(e.touches[0]); }, { passive: false });
      window.addEventListener('touchend', onUp);
    },
    onState(s) {
      state = s;
      if (!state.result) {
        const mover = state.players[state.turn];
        ctx.setTurn('Turn: ' + mover, ctx.isMyTurn(state.turn));
        if (state.turn === mySeat()) { sending = false; fireParams = null; }
      }
      const existing = engine && blockBodies.length;
      if (!existing && !state.result) buildWorld();
      refreshWorldBlocks();
      hud();
      if (engine && !runnerRaf) { setupCollisions(); runnerRaf = requestAnimationFrame(tick); }
    },
    onEvent(ev) {
      if (ev.ev === 'fire') {
        ctx.sound.play('shot');
        if (!myShot && engine) {
          // opponent's shot — replay it for visuals
          const side = state.players[ev.shooter] === state.players[0] ? 'L' : 'R';
          const a = anchorOf(side);
          const speed = 6 + ev.power * (MAX_LAUNCH - 6);
          // launch with authoritative params
          projectile = Bodies.circle(a.x, a.y, PROJ_R, {
            restitution: 0.45, friction: 0.02, frictionAir: 0.001, label: 'projectile', density: 0.02
          });
          Body.setVelocity(projectile, { x: Math.cos(ev.angle) * speed, y: Math.sin(ev.angle) * speed });
          projActive = true; projStill = 0;
          World.add(engine.world, projectile);
        }
        if (ev.destroyed && ev.destroyed.length) {
          setTimeout(() => {
            ev.destroyed.forEach((id) => {
              const b = findBlock('L', id) || findBlock('R', id);
              if (b) { b.hp = 0; spawnParticles(b.x, b.y); }
            });
            refreshWorldBlocks();
            hud();
          }, 900);
        }
      }
    },
    unmount() {
      if (runnerRaf) cancelAnimationFrame(runnerRaf);
      runnerRaf = null;
      clearWorld();
      canvas = null; ctx2d = null; state = null; ctx = null;
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
    }
  };
})();
