/* NEON ARCADE ARENA — client core: socket, views, chat, audio, game shell */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ================= AUDIO (Web Audio API synth) ================= */
  const Sound = {
    ctx: null, sfxOn: localStorage.getItem('naa_sfx') !== 'off',
    musicOn: localStorage.getItem('naa_music') === 'on', musicTimer: null, step: 0,
    ensure() {
      if (!this.ctx) {
        try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch (e) { return null; }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    tone(freq, dur, type, vol, when) {
      const ctx = this.ensure();
      if (!ctx) return;
      const t = (when || 0) + ctx.currentTime;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type || 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol || 0.15, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + dur + 0.05);
    },
    noise(dur, vol) {
      const ctx = this.ensure();
      if (!ctx) return;
      const len = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource();
      const g = ctx.createGain();
      g.gain.value = vol || 0.2;
      src.buffer = buf;
      src.connect(g); g.connect(ctx.destination);
      src.start();
    },
    seq(notes, gap, type, vol) {
      notes.forEach((n, i) => { if (n) this.tone(n, gap / 1000 * 0.9, type, vol, i * gap / 1000); });
    },
    play(name) {
      if (!this.sfxOn || !this.ensure()) return;
      switch (name) {
        case 'click': this.tone(660, .06, 'square', .1); break;
        case 'hover': this.tone(440, .04, 'square', .05); break;
        case 'dice': this.seq([300, 380, 300, 460], 70, 'square', .12); break;
        case 'move': this.tone(520, .08, 'triangle', .18); this.tone(780, .08, 'triangle', .1, .05); break;
        case 'capture': this.seq([500, 340, 200], 80, 'sawtooth', .15); break;
        case 'chat': this.tone(880, .07, 'sine', .12); this.tone(1180, .07, 'sine', .08, .06); break;
        case 'shot': this.noise(.25, .25); this.tone(140, .2, 'sawtooth', .2); break;
        case 'hit': this.noise(.12, .3); this.tone(90, .15, 'sine', .25); break;
        case 'win': this.seq([523, 659, 784, 1046, 1318], 120, 'square', .16); break;
        case 'lose': this.seq([400, 300, 200, 120], 150, 'sawtooth', .14); break;
        case 'error': this.tone(160, .2, 'sawtooth', .18); break;
        case 'join': this.seq([660, 880], 90, 'square', .12); break;
      }
    },
    startMusic() {
      const ctx = this.ensure();
      if (!ctx || this.musicTimer) return;
      this.musicOn = true;
      localStorage.setItem('naa_music', 'on');
      // 8-bit style bass/lead loop in A minor
      const bass = [110, 0, 110, 0, 130.8, 0, 130.8, 0, 98, 0, 98, 0, 130.8, 0, 146.8, 0];
      const lead = [440, 523, 659, 523, 587, 494, 440, 0, 440, 523, 659, 784, 698, 659, 587, 494];
      const tempo = 250;
      this.musicTimer = setInterval(() => {
        if (!this.musicOn) return;
        const i = this.step % 16;
        if (bass[i]) this.tone(bass[i], .22, 'triangle', .07);
        if (lead[i]) this.tone(lead[i], .16, 'square', .035);
        this.step++;
      }, tempo);
    },
    stopMusic() {
      this.musicOn = false;
      localStorage.setItem('naa_music', 'off');
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    },
    toggleSfx() {
      this.sfxOn = !this.sfxOn;
      localStorage.setItem('naa_sfx', this.sfxOn ? 'on' : 'off');
      return this.sfxOn;
    }
  };

  /* ================= APP STATE ================= */
  const socket = io({ transports: ['websocket', 'polling'] });
  const App = {
    socket, sound: Sound,
    me: null,            // {name, avatar, stats}
    meta: null,           // server meta (avatars, badges, games)
    room: null,           // current room snapshot
    gameKey: null,
    gameModule: null,
    view: 'profile'
  };
  window.App = App;
  window.GAMES = {};

  function showView(name) {
    App.view = name;
    $('#modal-profile').classList.toggle('hidden', name !== 'profile');
    $('#view-lobby').classList.toggle('hidden', name !== 'lobby');
    $('#view-room').classList.toggle('hidden', name !== 'room');
    $('#view-game').classList.toggle('hidden', name !== 'game');
    $('#topbar').classList.toggle('hidden', name === 'profile');
    $('#modal-setup').classList.add('hidden');
  }

  function toast(text, type) {
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 3200);
    setTimeout(() => t.remove(), 3700);
    if (type === 'error') Sound.play('error');
  }

  /* ================= CHAT ================= */
  function makeChat(msgsEl, formEl, inputEl, channel) {
    const push = (m, mine) => {
      const div = document.createElement('div');
      div.className = 'chat-msg';
      const time = new Date(m.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (m.system) {
        div.innerHTML = `<span class="msg-meta system">» ${esc(m.text)}</span><span class="msg-time">${time}</span>`;
      } else {
        div.innerHTML = `<span class="msg-meta ${mine ? 'me' : ''}">${esc(m.avatar || '')} ${esc(m.from)}</span>${esc(m.text)}<span class="msg-time">${time}</span>`;
      }
      msgsEl.appendChild(div);
      while (msgsEl.children.length > 120) msgsEl.firstChild.remove();
      msgsEl.scrollTop = msgsEl.scrollHeight;
    };
    const bind = (channelEmit) => {
      formEl.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = inputEl.value.trim();
        if (!text) return;
        inputEl.value = '';
        socket.emit('chat:send', { channel, text });
      });
      return channelEmit;
    };
    return { push, bind, el: msgsEl };
  }

  const globalChat = makeChat($('#global-chat-messages'), $('#global-chat-form'), $('#global-chat-input'), 'global');
  const roomChat = makeChat($('#room-chat-messages'), $('#room-chat-form'), $('#room-chat-input'), 'room');
  const gameChat = makeChat($('#game-chat-messages'), $('#game-chat-form'), $('#game-chat-input'), 'room');
  globalChat.bind(); roomChat.bind(); gameChat.bind();

  function pushRoomChat(m) {
    const mine = App.me && m.from === App.me.name;
    roomChat.push(m, mine);
    gameChat.push(m, mine);
    if (!mine) Sound.play('chat');
  }

  /* ================= PROFILE ================= */
  let selectedAvatar = null;
  function openProfile(forced) {
    $('#modal-profile').classList.remove('hidden');
    const savedName = localStorage.getItem('naa_name');
    const savedAvatar = localStorage.getItem('naa_avatar');
    if (savedName && !forced) {
      submitProfile(savedName, savedAvatar);
      return;
    }
    $('#profile-error').textContent = '';
    $('#profile-name').value = savedName || '';
    renderAvatarGrid(savedAvatar || (App.meta ? App.meta.avatars[0] : '🦊'));
  }
  function renderAvatarGrid(sel) {
    selectedAvatar = sel;
    const grid = $('#avatar-grid');
    grid.innerHTML = '';
    (App.meta ? App.meta.avatars : ['🦊']).forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'avatar-pick' + (a === sel ? ' sel' : '');
      b.textContent = a;
      b.addEventListener('click', () => { renderAvatarGrid(a); Sound.play('hover'); });
      grid.appendChild(b);
    });
  }
  function submitProfile(name, avatar) {
    socket.emit('profile', { name, avatar }, (res) => {
      if (!res || !res.ok) {
        if (res && res.error) {
          $('#profile-error').textContent = res.error;
          $('#modal-profile').classList.remove('hidden');
        }
        return;
      }
      App.me = { name, avatar, stats: res.stats };
      localStorage.setItem('naa_name', name);
      localStorage.setItem('naa_avatar', avatar);
      $('#chip-avatar').textContent = avatar;
      $('#chip-name').textContent = name;
      $('#modal-profile').classList.add('hidden');
      Sound.play('join');
      renderMyStats(res.stats);
      showView('lobby');
      maybeAutoJoin();
    });
  }
  $('#profile-enter').addEventListener('click', () => {
    const name = $('#profile-name').value.trim();
    if (!selectedAvatar) { $('#profile-error').textContent = 'Pick an avatar'; return; }
    submitProfile(name, selectedAvatar);
  });
  $('#profile-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#profile-enter').click();
  });
  $('#profile-chip').addEventListener('click', () => {
    localStorage.removeItem('naa_name');
    localStorage.removeItem('naa_avatar');
    openProfile(true);
  });

  /* ================= SOUND TOGGLES ================= */
  function refreshSoundBtns() {
    $('#btn-sound').textContent = Sound.sfxOn ? '🔊 SFX' : '🔇 SFX';
    $('#btn-sound').classList.toggle('on', Sound.sfxOn);
    $('#btn-music').textContent = Sound.musicOn ? '♫ ON' : '♫ OFF';
    $('#btn-music').classList.toggle('on', Sound.musicOn);
  }
  $('#btn-sound').addEventListener('click', () => { Sound.toggleSfx(); refreshSoundBtns(); });
  $('#btn-music').addEventListener('click', () => {
    if (Sound.musicOn) Sound.stopMusic(); else Sound.startMusic();
    refreshSoundBtns();
  });

  /* ================= LOBBY ================= */
  const GAME_META = {
    ludo: { emoji: '🎲', tag: '2-4 players · race your tokens home, capture & roll sixes' },
    chess: { emoji: '♞', tag: '1v1 · full rules, clocks, checkmate detection' },
    slingshot: { emoji: '🎯', tag: '1v1 · turn-based physics siege — raze the fortress' },
    tictactoe: { emoji: '⭕', tag: '1v1 · quick classic, best played with trash talk' },
    connect4: { emoji: '🔴', tag: '1v1 · drop discs, line up four, win glory' }
  };

  function renderGameCards() {
    const grid = $('#game-grid');
    grid.innerHTML = '';
    Object.entries(App.meta.games).forEach(([key, g]) => {
      const m = GAME_META[key] || { emoji: '🎮', tag: '' };
      const card = document.createElement('div');
      card.className = 'game-card';
      card.innerHTML = `
        <span class="game-emoji">${m.emoji}</span>
        <div class="game-name">${esc(g.name)}</div>
        <span class="game-tag">${esc(m.tag)}</span>
        <div class="game-card-btns">
          <button class="btn btn-primary" data-act="create">+ ROOM</button>
          <button class="btn btn-ghost" data-act="quick">⚡ QUICK</button>
        </div>`;
      card.querySelector('[data-act="create"]').addEventListener('click', () => {
        Sound.play('click');
        openSetup(key);
      });
      card.querySelector('[data-act="quick"]').addEventListener('click', () => {
        Sound.play('click');
        socket.emit('match:quick', { game: key }, (res) => {
          if (!res || !res.ok) toast(res && res.error || 'Could not join queue', 'error');
          else toast('Searching for opponents…');
        });
      });
      grid.appendChild(card);
    });
  }

  function renderPublicRooms(rooms) {
    const box = $('#public-rooms');
    if (!rooms.length) {
      box.innerHTML = '<p class="empty-note">No public rooms yet — create one!</p>';
      return;
    }
    box.innerHTML = '';
    rooms.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'room-row';
      row.innerHTML = `
        <span class="room-row-code">${esc(r.code)}</span>
        <span>${esc(r.gameName)}</span>
        <span class="text-dim">${r.count}/${r.max} 👥</span>
        <button class="btn btn-accent btn-sm">JOIN</button>`;
      row.querySelector('button').addEventListener('click', () => {
        Sound.play('click');
        joinRoom(r.code);
      });
      box.appendChild(row);
    });
  }

  function renderLeaderboard(lb) {
    const box = $('#leaderboard');
    if (!lb.length) { box.innerHTML = '<p class="empty-note">Be the first champion!</p>'; return; }
    box.innerHTML = '';
    lb.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'lb-row';
      row.innerHTML = `
        <span class="lb-rank ${i < 3 ? 'top' : ''}">#${i + 1}</span>
        <span class="lb-name">${esc(s.avatar)} ${esc(s.name)}</span>
        <span class="lb-wins">${s.wins}W</span>
        <span class="lb-losses">${s.losses}L</span>`;
      box.appendChild(row);
    });
  }

  function renderMyStats(st) {
    if (!st) return;
    $('#my-stats').innerHTML = `
      <div class="stat-line"><span>Wins</span><b>${st.wins}</b></div>
      <div class="stat-line"><span>Losses</span><b style="color:var(--danger)">${st.losses}</b></div>
      <div class="stat-line"><span>Matches</span><b>${st.games}</b></div>
      <div class="stat-line"><span>Badges</span><b style="color:var(--neon-purple)">${st.badges.length}/10</b></div>`;
    renderBadges(st.badges);
  }
  function renderBadges(ids) {
    const row = $('#my-badges');
    row.innerHTML = '';
    const all = App.meta ? App.meta.badges : {};
    ids.forEach((id) => {
      const b = all[id];
      if (!b) return;
      const el = document.createElement('span');
      el.className = 'badge' + (['grandmaster', 'champion'].includes(id) ? ' gold' : '');
      el.textContent = '🏆 ' + b.name;
      el.title = b.desc;
      row.appendChild(el);
    });
    if (!ids.length) row.innerHTML = '<p class="empty-note">Win matches to unlock badges!</p>';
  }

  /* ================= SETUP MODAL / CREATE ROOM ================= */
  let setupGame = null, setupPrivate = true;
  function openSetup(gameKey) {
    setupGame = gameKey;
    $('#setup-game-name').textContent = 'CREATE ' + App.meta.games[gameKey].name.toUpperCase() + ' ROOM';
    $('#setup-max-field').classList.toggle('hidden', gameKey !== 'ludo');
    $('#setup-error').textContent = '';
    $('#modal-setup').classList.remove('hidden');
  }
  function setSetupPrivate(v) {
    setupPrivate = v;
    $('#setup-private').classList.toggle('active', v);
    $('#setup-public').classList.toggle('active', !v);
  }
  $('#setup-private').addEventListener('click', () => setSetupPrivate(true));
  $('#setup-public').addEventListener('click', () => setSetupPrivate(false));
  $('#setup-cancel').addEventListener('click', () => $('#modal-setup').classList.add('hidden'));
  $('#setup-create').addEventListener('click', () => {
    socket.emit('room:create', {
      game: setupGame, isPrivate: setupPrivate,
      maxPlayers: parseInt($('#setup-max').value, 10)
    }, (res) => {
      if (!res || !res.ok) { $('#setup-error').textContent = (res && res.error) || 'Failed'; return; }
      $('#modal-setup').classList.add('hidden');
      Sound.play('join');
    });
  });

  /* ================= JOIN ROOM ================= */
  function joinRoom(code) {
    socket.emit('room:join', { code }, (res) => {
      if (!res || !res.ok) toast((res && res.error) || 'Could not join room', 'error');
      else { Sound.play('join'); showView('room'); }
    });
  }
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length !== 6) { toast('Room codes are 6 characters', 'error'); return; }
    Sound.play('click');
    joinRoom(code);
  });
  function maybeAutoJoin() {
    const m = location.hash.match(/^#([A-HJ-NP-Z2-9]{6})$/i);
    if (m) {
      joinRoom(m[1].toUpperCase());
      history.replaceState(null, '', location.pathname);
    }
  }

  /* ================= ROOM (WAITING) VIEW ================= */
  function renderRoom(room) {
    App.room = room;
    $('#room-game-name').textContent = '// ' + room.gameName.toUpperCase() + ' ROOM';
    $('#room-code').textContent = room.code;
    $('#room-hint').textContent = room.isPrivate
      ? 'Share this code (or the copy-link) with friends, then hit READY.'
      : 'Your room is listed publicly — or share the code directly.';
    const box = $('#room-players');
    box.innerHTML = '';
    const max = room.maxPlayers;
    for (let i = 0; i < max; i++) {
      const p = room.players[i];
      const slot = document.createElement('div');
      slot.className = 'player-slot' + (p && p.ready ? ' ready' : '');
      if (p) {
        let tag = '';
        if (!p.connected) tag = '<span class="offline-tag">OFFLINE</span>';
        else if (i === room.hostIndex) tag = '<span class="host-tag">HOST ★</span>';
        else if (p.ready) tag = '<span class="ready-tag">READY ✓</span>';
        slot.innerHTML = `<span class="avatar-face">${esc(p.avatar)}</span><span>${esc(p.name)}</span>${tag}`;
      } else {
        slot.innerHTML = '<span class="avatar-face" style="opacity:.3">❔</span><span style="opacity:.3">waiting…</span>';
      }
      box.appendChild(slot);
    }
    const me = room.players.find((p) => p.name === App.me.name);
    $('#btn-ready').textContent = me && me.ready ? 'UNREADY' : 'READY UP';
    $('#btn-ready').classList.toggle('btn-primary', !(me && me.ready));
    $('#btn-ready').classList.toggle('btn-ghost', !!(me && me.ready));
    const isHost = room.hostIndex >= 0 && room.players[room.hostIndex] && room.players[room.hostIndex].name === App.me.name;
    const active = room.players.filter((p) => p.connected);
    const allReady = active.length >= Math.min(2, room.maxPlayers) && active.every((p) => p.ready);
    $('#btn-start').classList.toggle('hidden', !isHost || !allReady);
    // chat history
    $('#room-chat-messages').innerHTML = '';
    $('#game-chat-messages').innerHTML = '';
    room.chat.forEach((m) => pushRoomChat(m));
    showView('room');
  }

  $('#btn-ready').addEventListener('click', () => {
    Sound.play('click');
    socket.emit('room:ready');
  });
  $('#btn-start').addEventListener('click', () => {
    Sound.play('click');
    socket.emit('room:start', {}, (res) => {
      if (!res || !res.ok) toast((res && res.error) || 'Cannot start', 'error');
    });
  });
  $('#btn-leave-room').addEventListener('click', () => {
    Sound.play('click');
    socket.emit('room:leave');
  });
  $('#btn-copy').addEventListener('click', () => {
    const link = location.origin + '/#' + App.room.code;
    navigator.clipboard.writeText(link).then(() => toast('Invite link copied: ' + link))
      .catch(() => toast(link));
  });

  /* ================= GAME SHELL ================= */
  function setTurn(text, mine) {
    const el = $('#game-turn');
    el.textContent = text;
    el.classList.toggle('mine', !!mine);
  }
  function setTimer(text, low) {
    const el = $('#game-timer');
    if (text == null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.textContent = text;
    el.classList.toggle('low', !!low);
  }

  function mountGame(gameKey, players, state) {
    unmountGame();
    App.gameKey = gameKey;
    $('#game-title').textContent = App.meta.games[gameKey].name.toUpperCase();
    $('#game-code').textContent = 'ROOM ' + App.room.code;
    $('#game-over').classList.add('hidden');
    $('#btn-resign').classList.toggle('hidden', gameKey !== 'chess');
    const container = $('#game-container');
    container.innerHTML = '';
    const mySeat = players.findIndex((p) => p.name === App.me.name);
    const ctx = {
      mySeat, players, roomCode: App.room.code,
      sound: Sound,
      emitAction(type, data) {
        socket.emit('game:action', Object.assign({ type }, data || {}));
      },
      setTurn, setTimer,
      isMyTurn(seat) { return seat === mySeat; },
      showOver(result) { displayGameOver(result); }
    };
    App.gameModule = window.GAMES[gameKey];
    App.gameModule.mount(container, ctx);
    App.gameModule.onState(state);
  }
  function unmountGame() {
    if (App.gameModule && App.gameModule.unmount) App.gameModule.unmount();
    App.gameModule = null;
    App.gameKey = null;
    $('#game-container').innerHTML = '';
    setTimer(null);
  }
  function displayGameOver(result) {
    const overlay = $('#game-over');
    const title = $('#over-title');
    if (!result.winner) { title.textContent = 'DRAW'; title.className = 'over-title draw'; }
    else if (result.winner === App.me.name) { title.textContent = '★ VICTORY ★'; title.className = 'over-title win'; }
    else { title.textContent = 'DEFEAT'; title.className = 'over-title lose'; }
    $('#over-reason').textContent = result.reason || '';
    overlay.classList.remove('hidden');
    Sound.play(result.winner === App.me.name ? 'win' : result.winner ? 'lose' : 'click');
  }

  $('#btn-leave-game').addEventListener('click', () => {
    Sound.play('click');
    socket.emit('room:leave');
  });
  $('#btn-over-leave').addEventListener('click', () => {
    Sound.play('click');
    socket.emit('room:leave');
  });
  $('#btn-rematch').addEventListener('click', () => {
    Sound.play('click');
    $('#game-over').classList.add('hidden');
    toast('Rematch requested — waiting for others…');
    socket.emit('game:rematch');
  });
  $('#btn-resign').addEventListener('click', () => {
    if (confirm('Resign this match?')) socket.emit('game:action', { type: 'resign' });
  });

  /* ================= SOCKET WIRING ================= */
  socket.on('hello', (meta) => {
    App.meta = meta;
    renderGameCards();
    (meta.globalChat || []).forEach((m) => globalChat.push(m, m.from === (App.me && App.me.name)));
    refreshSoundBtns();
    if (Sound.musicOn) Sound.startMusic();
    if (App.view === 'profile') openProfile(false);
  });
  socket.on('lobby', (lobby) => {
    renderPublicRooms(lobby.publicRooms || []);
    renderLeaderboard(lobby.leaderboard || []);
  });
  socket.on('global:chat', (m) => {
    globalChat.push(m, m.from === App.me.name);
    if (m.from !== App.me.name) Sound.play('chat');
  });
  socket.on('room:chat', pushRoomChat);
  socket.on('room:joined', () => { /* snapshot will follow */ });
  socket.on('room:state', (room) => {
    if (App.view === 'game' && room.phase !== 'over') return; // ignore stale lobby pings mid-game
    renderRoom(room);
  });
  socket.on('room:left', () => {
    unmountGame();
    App.room = null;
    showView('lobby');
  });
  socket.on('queue', (q) => {
    toast('Matchmaking: ' + App.meta.games[q.game].name + ' — ' + q.size + ' in queue');
  });
  socket.on('game:start', (data) => {
    showView('game');
    mountGame(data.game, data.players, data.state);
    Sound.play('join');
  });
  socket.on('game:state', (state) => {
    if (App.gameModule) App.gameModule.onState(state);
  });
  socket.on('game:event', (ev) => {
    if (App.gameModule && App.gameModule.onEvent) App.gameModule.onEvent(ev);
  });
  socket.on('game:clock', (c) => {
    if (App.gameModule && App.gameModule.onClock) App.gameModule.onClock(c);
  });
  socket.on('game:over', (result) => {
    if (App.gameModule && App.gameModule.onOver) App.gameModule.onOver(result);
    else displayGameOver(result);
  });
  socket.on('me:stats', renderMyStats);
  socket.on('badge', (b) => {
    toast('🏅 BADGE UNLOCKED: ' + b.name, 'badge');
    Sound.play('win');
    socket.emit('chat:send', { channel: 'global', text: 'just unlocked the "' + b.name + '" badge!' });
  });
  socket.on('notify', (n) => toast(n.text, n.type || 'error'));

  showView('profile');
})();
