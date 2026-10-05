# Star Arena

A real-time multiplayer 2D space shooter that runs in the browser. It's a working
demo of the server architecture behind a 2D space MMO: one authoritative server,
lots of ships, smooth movement, fair hit detection, and a design that scales
toward **1000 concurrent players**.

Open the page and you're watching a live battle right away. Pick one of four
ships, type a name, press **Play**, and you're flying in under a second. About 40
AI pilots keep the world busy even when you're the only human online.

| | |
|---|---|
| **Server** | Node.js + `ws` (WebSocket). One process serves both the game and the web page. |
| **Client** | PixiJS 8 (WebGL) + plain JavaScript modules. No build step. Pixi is vendored in `client/vendor/`. |
| **Art & audio** | All original: hand-written SVG sprites in `client/assets/`, a procedurally generated nebula, and sound effects synthesized with the Web Audio API (no audio files). |
| **Runtime dependencies** | One (`ws`) |

---

## What you can see in the demo

- **A real game menu.** Logo, ship selection (Falcon, Hornet, Viper, Specter),
  pilot name, and the live battle playing behind it.
- **Cartoon-style art.** Solid metallic ships with thick outlines and lighting
  from the top-left. Animated engine flames, laser bolts, muzzle flashes, white
  hit flashes, a 6-frame explosion with flying debris, smoke from damaged ships,
  meteors with craters, repair-kit pickups, and a spawn shield bubble.
- **Background.** A nebula generated from value noise at startup, two parallax
  star layers, and three distant planets.
- **Meteors.** Ships bounce off them and bullets stop on them, on the server
  and in your client's prediction.
- **Game feel.** Floating damage numbers, a red damage vignette, and subtle
  screen shake only when *you* get hit. Sounds for lasers, hits, explosions,
  respawn and pickups (`M` mutes).
- **HUD.** Health bar, kills, deaths and rank. A live top-10 leaderboard with
  ship icons, a kill feed, and a minimap.
- **Server Stats panel (`Tab`).** Ping, players online, bots, server tick time
  (split into simulation, interest management and network send), and bandwidth
  per player. The architecture working, live.
- **Interest management you can see.** The minimap draws the server's spatial
  grid and the box of cells the server is checking for you. Only ships inside
  that box are ever sent to you.

---

## Architecture

```
  Browser (PixiJS)                                Node.js server (one process)
 ┌──────────────────────────┐  inputs (20/s)     ┌──────────────────────────────────┐
 │ Input sampled at 40 Hz   ├───────────────────►│ Validate + rate-limit inputs     │
 │ Predict own ship+bullets │ keys, aim, seq,    │                                  │
 │ Reconcile on snapshot    │ view time          │ 20 Hz fixed tick:                │
 │ Interpolate others       │◄───────────────────┤  physics · bots · bullets        │
 │ (rendered 100 ms behind) │ binary snapshot    │  lag-compensated hits · respawns │
 └──────────────────────────┘ (20/s, nearby only)│  spatial grid → per-player AOI   │
                                                 └──────────────────────────────────┘
```

### 1. Authoritative server, 20 Hz fixed tick
The server owns the truth: positions, bullets, damage, kills, pickups and
respawns ([server/game.js](server/game.js)). Clients **only send inputs**: which
keys are held, the aim angle, a sequence number, and the time of the world they
were looking at. A hacked client can't teleport, speed up, fire faster or heal
itself.

### 2. Spatial grid + interest management (the key to scaling)
A naive server sends every ship to every player. That's N² work: 1000 players
means **1,000,000 ship updates per tick**.

Instead, the 8000×8000 world is divided into a **16×16 grid of 500 px cells**
([server/spatialGrid.js](server/spatialGrid.js)). Each tick, every player gets
a snapshot containing **only what's inside their area of interest**, a
2400×1600 box around their ship ([server/interest.js](server/interest.js)).
Finding those ships touches about 30 grid cells, no matter how many players
are online.

The grid is rebuilt every tick with a counting sort into flat typed arrays, so
a query reads contiguous memory instead of chasing object pointers. The same
grid is used for bullet hit detection, bot targeting, pickups and safe spawn
points.

### 3. Client-side prediction + server reconciliation
Your own ship never waits for the server. The client runs **the exact same
physics code** as the server ([shared/shared.js](shared/shared.js)), including
meteor bounces, and applies your input immediately. When a snapshot arrives,
the client resets to the server's state (sent as exact 64-bit floats),
replays the inputs the server hasn't processed yet, and blends out any
difference. Because the physics is deterministic, corrections are normally
exactly zero.

Your own bullets also appear the instant you fire. Each predicted bullet is
linked to the server's copy by input sequence number, so they never appear
twice.

### 4. Entity interpolation (other ships)
Other ships are drawn **100 ms in the past**, smoothly between two server
snapshots. Bullets are sent **once** when fired; the client simulates their
flight on the same delayed timeline, so they line up exactly with the ship
that fired them.

### 5. Lag compensation (fair hits)
Because other ships are drawn ~100 ms in the past, plus network latency, a
target you hit on screen has already moved on the server. Without compensation,
shots that clearly connect on screen don't count.

How Star Arena fixes it:

- The server keeps a **1.6-second position history** (a ring buffer) for every ship.
- Every input message carries the **server time the player was viewing**.
- When that player fires, the server tests the bullet against targets
  **rewound to where that player saw them**, capped at **200 ms** so very
  laggy players can't shoot too far into the past. The test runs in the
  target's moving frame, so fast ships can't slip between ticks.
- The bullet starts from the **muzzle position the client fired from**. The
  server only accepts that position if it's within 40 units of its own copy of
  the ship.
- The hit radius matches the ship sprites.

This is the same approach used by most competitive shooters ("favor the
shooter, within limits").

### 6. Compact binary snapshots, built once per tick
Snapshots are binary (`ArrayBuffer` / `DataView`) with fixed-size records
([server/protocol.js](server/protocol.js), decoded by
[client/js/protocol.js](client/js/protocol.js)):

```
JSON object:  {"id":12,"x":4031.24,"y":2210.0,"angle":-1.57,"hp":88,"thrust":true}  ~80 bytes
JSON array:   12,4031,2210,-157,88,1                                                ~22 bytes
Star Arena:   u32 id | u16 x | u16 y | u16 angle | u8 hp | u8 flags                  12 bytes
```

- Every ship, bullet and event is encoded **once per tick** into a shared
  buffer. A player's snapshot is then built by copying the bytes for what's in
  view.
- Names are sent only when a ship first comes into view. The leaderboard (once
  a second) and kill feed are encoded once and included in the same frame.
  Each client gets **exactly one WebSocket frame per tick**.
- WebSocket compression (`perMessageDeflate`) is **off**: it costs CPU per
  client, and the binary format is already compact.
- The meteor field comes from a fixed seed shared by server and client, so it's
  never sent over the network.

### 7. Anti-cheat and abuse protection
- Inputs are validated and **rate-limited with a token bucket** (speed hacks
  get dropped). Speed is clamped by the physics, and **weapon cooldown is
  enforced on the server**.
- Muzzle positions are distance-checked, and lag-compensation rewind is capped.
- Message size cap, per-connection message-rate limit, heartbeat to drop dead
  connections, and backpressure (slow connections skip a snapshot instead of
  piling up memory).

### 8. AI bots (fun, not frustrating)
About 40 server-side pilots ([server/bots.js](server/bots.js)) produce the same
inputs a player sends and go through the same physics and damage code. To keep
them beatable:

- **Reaction delay (300–500 ms).** Bots aim at where you were a moment ago,
  read from the server's position history, so dodging works.
- **Aim spread, a lower fire rate, and half damage against humans.**
- **Personalities.** Only "hunters" chase human players (max 2 per player).
  "Brawlers" fight other bots. "Wanderers" cruise and only fight back. Bots
  fight each other at full strength, so the world stays busy with kills.
- **3 s spawn shield** (visible bubble) for every new or respawned ship.

---

## Performance

Measured with `loadtest.js` on a development laptop (2-core 1.9 GHz Celeron,
Windows). **The load-test clients ran on the same machine and competed with the
server for CPU**, so a real server will do noticeably better:

| Clients | Avg tick (budget 50 ms) | Simulation | Interest + encode | Socket send | Download per player |
|---|---|---|---|---|---|
| 200 + 40 bots | ~13.5 ms | ~1.4 ms | ~3.3 ms | ~8.5 ms | ~6 KB/s |

At this scale most of each tick is spent writing to sockets, not running the
game. That's why the next steps below focus on the network layer.

### Load test results

_Placeholder: fill in after running on the target hardware._

| Clients | Server machine | Avg tick (ms) | Sim / Interest / Send (ms) | Bandwidth per player | Notes |
|---|---|---|---|---|---|
| 200 | | | | | |
| 500 | | | | | |
| 1000 | | | | | |

---

## Scaling to 1000+ players: next steps

1. **Delta compression.** Send only what changed since the last snapshot the
   client acknowledged, plus lower update rates for distant ships. Expect a
   further 2–4× bandwidth reduction.
2. **Faster socket layer.** Switch `ws` to **uWebSockets.js**, or put gateway
   processes in front that handle socket fan-out, so the simulation thread
   only simulates.
3. **Multiple zone servers.** Split the universe into sectors, each simulated
   by its own process or machine, with hand-off when players cross a border.
   The spatial grid already provides natural boundaries.
4. **Redis.** Shared state and pub/sub between zone servers: sessions,
   cross-zone chat, global leaderboards, and which zone each player is in.
5. **PostgreSQL.** Persistent accounts, ships, inventory, progression and match
   history. Writes happen on meaningful events, never every tick.

---

## Run it locally

Requirements: **Node.js 18+**

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP + WebSocket port |
| `BOT_COUNT` | `40` | Number of AI pilots |
| `MAX_PLAYERS` | `1000` | Max simultaneous human players |

Live server metrics as JSON: **http://localhost:3000/api/stats**

PixiJS is already vendored in `client/vendor/pixi.min.js`. To refresh it after
upgrading the `pixi.js` dev dependency, run `npm run vendor`.

### Deploy (Render)
It's a single web service: build command `npm install`, start command
`npm start`. A `render.yaml` blueprint is included.

---

## Load test

`loadtest.js` connects N headless clients that join the game and send random
inputs at the same rate as a real browser (20 messages and 40 input steps per
second, firing some of the time).

```bash
# with the server running in another terminal:
node loadtest.js 200          # 200 clients (default)
node loadtest.js 500          # 500 clients
node loadtest.js 300 wss://your-app.onrender.com/ws   # against a deployed server
```

Every second it prints: connected clients, messages and KB received per
client, and the **server's own tick time** with the
simulation / interest / send breakdown. Press `Ctrl+C` for a summary.

> **Tip:** for representative numbers, run the load test on a **different
> machine** than the server. The server's tick budget is **50 ms** (20 Hz).
> As long as the average tick stays well under that, the server is keeping up.

---

## Project layout

```
server/
  index.js        HTTP static server (gzip + ETag) + WebSocket endpoint (/ws), one port
  game.js         authoritative 20 Hz simulation, inputs, lag compensation, bullets, pickups, stats
  interest.js     per-player binary snapshot = interest management (AOI)
  spatialGrid.js  data-oriented spatial hash grid (counting sort into typed arrays)
  protocol.js     binary encoding + input validation
  bots.js         AI pilots (reaction delay, personalities)
  config.js       env-configurable limits
shared/
  shared.js       constants, ship physics, seeded meteor field (server + browser)
client/
  index.html, style.css
  vendor/pixi.min.js          PixiJS 8 (MIT), vendored
  assets/*.svg                all sprites, hand-written SVG
  js/main.js                  bootstrap + frame loop
  js/scene.js                 Pixi scene: ships, bullets, meteors, effects, damage numbers
  js/background.js            procedural nebula, parallax stars, planets
  js/world.js                 prediction, reconciliation, interpolation, events
  js/protocol.js              binary snapshot decoder
  js/net.js                   WebSocket, ping, bandwidth meter
  js/hud.js                   stats panel, leaderboard, kill feed, minimap
  js/audio.js                 Web Audio sound synthesis
  js/input.js                 keyboard + mouse
loadtest.js       headless load generator
```

## Controls

| | |
|---|---|
| Move | `W` `A` `S` `D` or arrow keys |
| Aim | Mouse |
| Fire | Left click or `Space` |
| Server stats | `Tab` |
| Mute | `M` |
