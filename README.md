# ⚡ Neon Arcade Arena

A real-time online multiplayer gaming platform. Play **Ludo**, **Chess**, a **Slingshot physics duel**, **Tic-Tac-Toe** and **Connect 4** with friends remotely — private rooms with 6-character codes, shareable links, or instant public matchmaking.

Built with **Node.js + Express + Socket.io** on the backend, and vanilla JS + HTML5 Canvas (+ **Matter.js** physics) + the **Web Audio API** (synthesized retro SFX & music) on the frontend.

---

## 🎮 Features

- **Profile setup** — unique gamer name + avatar, stored for the session
- **Private rooms** — 6-char code (`#ABC123` links auto-join) with ready-up flow
- **Public matchmaking** — "⚡ QUICK" button pairs you instantly (Ludo gathers up to 4 players for 12s)
- **Real-time chat** — global lobby chat **and** chat inside every room/match
- **Leaderboards & badges** — wins/losses tracked (persisted in `data/stats.json`), 10 unlockable badges
- **Arcade UI** — dark neon theme, glowing borders, animated grid, retro synth SFX + looping background music (both toggleable)

### Games

| Game | Players | Highlights |
|---|---|---|
| 🎲 Ludo | 2–4 | synchronized dice, capture logic, safe stars, home columns, three-sixes foul |
| ♞ Chess | 1v1 | full legal-move validation (castling, en-passant, promotion), 5-min clocks, check/checkmate/stalemate/50-move detection, move history |
| 🎯 Slingshot Duel | 1v1 | turn-based Matter.js physics siege — drag the glowing slingshot, raze the fortress or smash the crown; 8 shots each, most destruction wins |
| ⭕ Tic-Tac-Toe | 1v1 | instant matches with win-line highlight |
| 🔴 Connect 4 | 1v1 | full 7×6 board, four-in-a-row detection |

All game state is **validated server-side** — clients render and send intents, the server computes authoritative state and broadcasts it.

---

## 🚀 Run locally

Requirements: **Node.js ≥ 18**.

```bash
# 1. install dependencies
npm install

# 2. start the server
npm start

# 3. open in your browser
#    http://localhost:3000
```

Open the same URL in a second browser window (or on phones on the same Wi-Fi via `http://<your-LAN-IP>:3000`) to test multiplayer.

### Automated smoke test

```bash
npm run smoke
```

Connects two simulated clients, plays a Scholar's-Mate chess game, a Ludo turn, an arcade match and exchanges chat messages against a locally running server.

---

## 🌐 Deploy for free

The app is a single Node process — works on any Node host.

### Render (recommended)

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com) → **New +** → **Web Service** → connect the repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment:** Node 18+
4. Deploy — you get `https://your-app.onrender.com`. Share room links like `https://your-app.onrender.com/#ABC123`.

> Render free tier sleeps after inactivity; the first page load after sleep takes ~30s.

### Railway

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. It auto-detects Node (`npm install` / `npm start`). No extra config needed.

### Glitch

1. Go to [glitch.com](https://glitch.com) → **New Project** → **Import from GitHub** (paste your repo).
2. A `start` script is already defined in `package.json`, so it boots automatically.

### Any VPS / Docker

```bash
PORT=8080 npm start
```

The server honors the `PORT` environment variable.

---

## 🕹️ How to play with friends

1. Both visit the site, enter a **gamer name** and pick an **avatar**.
2. Host: pick a game → **+ ROOM** → share the **6-char code** (or the copy-link).
3. Friends: enter the code under **JOIN WITH CODE** (or just open the link).
4. Everyone hits **READY UP**, host hits **START MATCH**.
5. Prefer strangers? Hit **⚡ QUICK** on any game card for instant matchmaking.

Ludo rooms can be created for 2, 3 or 4 players; the other games are 1v1.

---

## 📁 Project structure

```
.
├── server.js              # Express + Socket.io backend: rooms, matchmaking,
│                          # chat, leaderboards, badges + authoritative game engines
├── package.json
├── data/stats.json         # created at runtime — persistent wins/badges
├── scripts/smoke.js       # automated multi-client test
└── public/
    ├── index.html         # profile modal, lobby, room, game views
    ├── style.css          # neon arcade theme, animations, responsive layout
    ├── client.js          # socket logic, view router, chat, Web Audio synth
    └── games/
        ├── ludo.js        # 15×15 board renderer, token/dice interaction
        ├── chess.js       # board renderer, move selection, clocks, history
        ├── slingshot.js   # Matter.js physics duel client
        └── arcade.js      # Tic-Tac-Toe + Connect 4 clients
```

## ⚙️ Notes

- **Matter.js** is served locally from `node_modules` (`/vendor/matter.min.js`) so the physics game works without extra CDNs.
- Tailwind (CDN) and Google Fonts improve the look but the custom `style.css` carries the core neon theme — the app remains fully playable offline except for those cosmetic CDN assets.
- Ludo uses a simplified rule set (no token blocking on shared squares); everything else follows standard rules.
- Chat is rate-limited (300ms) and capped at 300 chars; game actions are validated server-side.

MIT licensed. Have fun! 🎮
