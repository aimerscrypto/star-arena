'use strict';

const { performance } = require('perf_hooks');
const {
  C, BTN, C2S, EV, FLAG, stepShip, bulletFrom, segmentCircle, segmentHitsMeteor, isClearOfMeteors,
} = require('../shared/shared');
const { SpatialGrid } = require('./spatialGrid');
const { buildSnapshot } = require('./interest');
const proto = require('./protocol');
const bots = require('./bots');

const STEPS_PER_TICK = Math.round(C.INPUT_RATE / C.TICK_RATE); // 2 input steps per 50ms tick
const HIST = C.HISTORY_TICKS;
const SEND_OPTS = { binary: true, compress: false };
const scratch = [];
const P0 = { x: 0, y: 0 }, P1 = { x: 0, y: 0 };

/**
 * A bullet spawn / hit / death / pickup that happened this tick. One class (one
 * object shape) keeps the spatial-grid queries monomorphic and fast in V8.
 */
class TickEvent {
  constructor(bullet, type, a, b, x, y, value, bulletObj) {
    this.bullet = bullet;
    this.type = type;
    this.a = a;
    this.b = b;
    this.x = x;
    this.y = y;
    this.value = value;
    this.bulletObj = bulletObj;
    this.gi = -1;   // index in the event grid (set by SpatialGrid.build)
  }
}

function ensureCapacity(buf, size) {
  return buf.length >= size ? buf : Buffer.allocUnsafe(Math.max(size, buf.length * 2));
}

/**
 * The authoritative world simulation.
 *
 * Clients never tell the server where they are. They send inputs
 * (buttons + aim + sequence number); the server runs the physics, the weapon
 * cooldowns, the hit detection, damage, kills and respawns, and tells everyone
 * the result. A modified client can therefore only lie about which keys it
 * pressed, which is exactly what a real player can do anyway.
 */
class Game {
  constructor(config) {
    this.config = config;
    this.ships = new Map();       // id -> ship (players and bots)
    this.bots = [];
    this.clients = new Set();     // websocket connections (players + spectators)
    this.bullets = [];
    this.events = [];             // this tick's bullet spawns / hits / deaths / pickups
    this.kills = [];              // this tick's kill-feed entries
    this.pickups = [];
    this.alivePlayers = [];
    this.playerCount = 0;

    this.shipGrid = new SpatialGrid(C.WORLD_SIZE, C.GRID_CELL);
    this.eventGrid = new SpatialGrid(C.WORLD_SIZE, C.GRID_CELL);
    this.pickupGrid = new SpatialGrid(C.WORLD_SIZE, C.GRID_CELL);

    // Per-tick shared encodings (see protocol.js / interest.js)
    this.shipRec = Buffer.allocUnsafe(4096);
    this.eventRec = Buffer.allocUnsafe(4096);
    this.pickupRec = Buffer.allocUnsafe(1024);
    this.shipAlive = new Uint8Array(256);
    this.shipIds = new Uint32Array(256);
    this.evOff = new Int32Array(256);
    this.evBullet = new Uint8Array(256);
    this.aliveShips = [];
    this.activePickups = [];
    this.statsBuf = null;
    this.killfeedBuf = null;

    this.tick = 0;
    this.time = 0;                // simulation clock in ms (tick * 50)
    this.nextId = 1;
    this.nextBulletId = 1;
    this.nextPickupId = 1;

    this.win = this.newWindow();
    this.lastStats = null;

    for (let i = 0; i < config.BOT_COUNT; i++) this.spawnBot(i);
    for (let i = 0; i < C.PICKUP_COUNT; i++) this.pickups.push(this.newPickup(false));
  }

  newWindow() {
    return { tickSum: 0, tickN: 0, tickMax: 0, simSum: 0, aoiSum: 0, netSum: 0,
      playerBytes: 0, totalBytes: 0, droppedInputs: 0, skippedSnaps: 0, rejectedOrigins: 0 };
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    // Drift-free fixed-rate loop: ticks are scheduled against an absolute
    // timeline, so the long-run rate is exactly 20 Hz even if timers are late.
    let nextAt = performance.now();
    const loop = () => {
      const now = performance.now();
      let ran = 0;
      while (now >= nextAt && ran < 4) {
        this.step();
        nextAt += C.TICK_MS;
        ran++;
      }
      if (now - nextAt > 250) nextAt = now; // badly behind: skip instead of spiralling
      setTimeout(loop, Math.max(1, nextAt - performance.now()));
    };
    loop();

    // Drop dead TCP connections.
    setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) { client.ws.terminate(); continue; }
        client.isAlive = false;
        try { client.ws.ping(); } catch (_) { /* socket already closing */ }
      }
    }, 10000);
  }

  // ---------------------------------------------------------------- ships

  createShip(name, isBot, design) {
    const s = {
      id: this.nextId++, name, nameBytes: Buffer.from(name, 'latin1'), isBot, design,
      x: 0, y: 0, vx: 0, vy: 0, a: 0, cd: 0,
      hp: C.MAX_HP, alive: false, kills: 0, deaths: 0, rank: 0,
      respawnAt: 0, invulnUntil: 0, lastDamageAt: -1e9,
      thrust: false, attackers: 0,
      // Position history ring buffer for lag compensation + bot reaction delay.
      hx: new Float64Array(HIST), hy: new Float64Array(HIST), ht: new Int32Array(HIST).fill(-1),
      gi: -1,     // index in this tick's ship grid / encoded records (-1 = not in the grid)
      client: null, brain: null,
    };
    this.ships.set(s.id, s);
    this.respawn(s);
    return s;
  }

  spawnBot(i) {
    const bot = this.createShip(bots.botName(i), true, i % C.BOT_DESIGNS);
    bot.brain = bots.createBrain();
    this.bots.push(bot);
  }

  respawn(s) {
    const p = s.isBot ? this.botSpawnPoint() : this.findSafeSpot();
    s.x = p.x; s.y = p.y; s.vx = 0; s.vy = 0;
    s.a = Math.random() * Math.PI * 2 - Math.PI;
    s.cd = 0;
    s.hp = C.MAX_HP;
    s.alive = true;
    s.thrust = false;
    s.invulnUntil = this.time + C.SPAWN_INVULN_MS;
    s.lastDamageAt = -1e9;
    s.ht.fill(-1); // a new life has no history: you can't be hit "in the past" before you spawned
  }

  /** Random point away from ships and meteors (best of N tries). */
  findSafeSpot() {
    const W = C.WORLD_SIZE, R = 700;
    let best = null, bestD = -1;
    for (let i = 0; i < 30; i++) {
      const x = 400 + Math.random() * (W - 800), y = 400 + Math.random() * (W - 800);
      if (!isClearOfMeteors(x, y, 120)) continue;
      scratch.length = 0;
      this.shipGrid.query(x - R, y - R, x + R, y + R, scratch);
      let minD = Infinity;
      for (const s of scratch) {
        if (!s.alive) continue;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < minD) minD = d;
      }
      if (minD === Infinity) return { x, y };
      if (minD > bestD) { bestD = minD; best = { x, y }; }
    }
    return best || { x: W / 2, y: W / 2 };
  }

  /** Some bots respawn just outside a human's view, so there is traffic nearby. */
  botSpawnPoint() {
    const players = this.alivePlayers;
    if (players.length > 0 && Math.random() < 0.35) {
      const p = players[(Math.random() * players.length) | 0];
      const ang = Math.random() * Math.PI * 2, d = 1500 + Math.random() * 600;
      const clamp = (v) => Math.max(300, Math.min(C.WORLD_SIZE - 300, v));
      const x = clamp(p.x + Math.cos(ang) * d), y = clamp(p.y + Math.sin(ang) * d);
      if (isClearOfMeteors(x, y, 100)) return { x, y };
    }
    return this.findSafeSpot();
  }

  /** Point a couple of hunter bots at a newly joined player so there's action soon (not instantly). */
  rallyBots(ship) {
    const n = this.bots.length;
    if (!n) return;
    const start = (Math.random() * n) | 0;
    let sent = 0;
    for (let k = 0; k < n && sent < 3; k++) {
      const bot = this.bots[(start + k) % n];
      if (!bot.alive || bot.brain.targetId) continue;
      const ang = Math.random() * Math.PI * 2, d = 600 + Math.random() * 600;
      bots.setWaypoint(bot, ship.x + Math.cos(ang) * d, ship.y + Math.sin(ang) * d, this.time);
      sent++;
    }
  }

  /**
   * Where was `s` at simulation time t (ms)? Interpolates the history ring
   * buffer. Returns false if the ship has no history for that moment
   * (e.g. it had not spawned yet).
   */
  posAt(s, t, out) {
    if (t >= this.time) { out.x = s.x; out.y = s.y; return true; }
    const f = t / C.TICK_MS;
    const t0 = Math.floor(f);
    if (t0 < 0) return false;
    const i0 = t0 % HIST;
    if (s.ht[i0] !== t0) return false;
    const i1 = (t0 + 1) % HIST;
    if (s.ht[i1] !== t0 + 1) { out.x = s.hx[i0]; out.y = s.hy[i0]; return true; }
    const fr = f - t0;
    out.x = s.hx[i0] + (s.hx[i1] - s.hx[i0]) * fr;
    out.y = s.hy[i0] + (s.hy[i1] - s.hy[i0]) * fr;
    return true;
  }

  recordHistory() {
    const i = this.tick % HIST;
    for (const s of this.ships.values()) {
      if (!s.alive) continue;
      s.hx[i] = s.x; s.hy[i] = s.y; s.ht[i] = this.tick;
    }
  }

  // ---------------------------------------------------------------- pickups

  newPickup(temp, x, y) {
    if (x === undefined) ({ x, y } = this.randomPickupSpot());
    return { id: this.nextPickupId++, x, y, active: true, temp, respawnAt: 0, expireAt: temp ? this.time + 20000 : 0, gi: -1 };
  }

  randomPickupSpot() {
    for (let i = 0; i < 40; i++) {
      const x = 300 + Math.random() * (C.WORLD_SIZE - 600), y = 300 + Math.random() * (C.WORLD_SIZE - 600);
      if (isClearOfMeteors(x, y, 60)) return { x, y };
    }
    return { x: C.WORLD_SIZE / 2, y: C.WORLD_SIZE / 2 };
  }

  updatePickups() {
    const R = C.PICKUP_RADIUS + C.SHIP_RADIUS;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (!p.active) {
        if (this.time >= p.respawnAt) {
          const spot = this.randomPickupSpot();
          p.x = spot.x; p.y = spot.y; p.id = this.nextPickupId++; p.active = true;
        }
        continue;
      }
      if (p.temp && this.time > p.expireAt) { this.pickups.splice(i, 1); continue; }
      scratch.length = 0;
      this.shipGrid.query(p.x - R, p.y - R, p.x + R, p.y + R, scratch);
      let taker = null;
      for (const s of scratch) {
        if (!s.alive || s.hp >= C.MAX_HP) continue;
        if ((s.x - p.x) ** 2 + (s.y - p.y) ** 2 <= R * R) { taker = s; break; }
      }
      if (!taker) continue;
      const healed = Math.min(C.PICKUP_HEAL, C.MAX_HP - taker.hp);
      taker.hp += healed;
      this.events.push(new TickEvent(false, EV.PICKUP, p.id, taker.id, p.x, p.y, healed, null));
      if (p.temp) this.pickups.splice(i, 1);
      else { p.active = false; p.respawnAt = this.time + C.PICKUP_RESPAWN_MS; }
    }
  }

  // ---------------------------------------------------------------- connections

  addConnection(ws) {
    if (this.clients.size >= this.config.MAX_CONNECTIONS) {
      ws.close(1013, 'Server full');
      return;
    }
    const now = performance.now();
    const client = {
      ws, ship: null, isAlive: true,
      spectateId: 0, spectateUntil: 0,
      known: new Set(),           // ship ids whose names this client already has
      queue: [], lastQueuedSeq: 0, ackSeq: 0,
      tokens: this.config.INPUT_BURST, tokenTime: now,
      msgWindow: now, msgCount: 0,
    };
    this.clients.add(client);

    this.sendText(client, JSON.stringify([0, C.WORLD_SIZE, C.TICK_RATE, C.AOI_HALF_W, C.AOI_HALF_H]));

    ws.on('message', (data, isBinary) => this.onMessage(client, data, isBinary));
    ws.on('pong', () => { client.isAlive = true; });
    ws.on('close', () => this.removeClient(client));
    ws.on('error', () => { /* 'close' follows */ });
  }

  removeClient(client) {
    if (!this.clients.delete(client)) return;
    if (client.ship) {
      this.ships.delete(client.ship.id);
      this.playerCount--;
      client.ship = null;
    }
  }

  onMessage(client, data, isBinary) {
    if (isBinary || data.length > this.config.MAX_MSG_BYTES) return;

    // Flood protection: ignore excess messages, disconnect abusive clients.
    const now = performance.now();
    if (now - client.msgWindow >= 1000) { client.msgWindow = now; client.msgCount = 0; }
    client.msgCount++;
    if (client.msgCount > this.config.KICK_MSGS_PER_SEC) { client.ws.terminate(); return; }
    if (client.msgCount > this.config.MAX_MSGS_PER_SEC) return;

    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (!Array.isArray(msg)) return;

    switch (msg[0]) {
      case C2S.INPUT: this.queueInputs(client, msg, now); break;
      case C2S.JOIN: this.join(client, msg[1], msg[2]); break;
      case C2S.PING:
        if (typeof msg[1] === 'number' && Number.isFinite(msg[1])) this.sendText(client, '[4,' + msg[1] + ']');
        break;
    }
  }

  join(client, rawName, rawDesign) {
    if (client.ship) return;
    if (this.playerCount >= this.config.MAX_PLAYERS) return;
    const name = proto.sanitizeName(rawName) || 'Pilot-' + (100 + ((Math.random() * 900) | 0));
    const design = Number.isInteger(rawDesign) && rawDesign >= 0 && rawDesign < C.PLAYER_DESIGNS ? rawDesign : 0;
    const ship = this.createShip(name, false, design);
    ship.client = client;
    client.ship = ship;
    client.queue.length = 0;
    client.lastQueuedSeq = 0;
    client.ackSeq = 0;
    this.playerCount++;
    this.sendText(client, JSON.stringify([5, ship.id, name, design]));
    this.rallyBots(ship);
  }

  /**
   * Input validation + rate limiting.
   * A token bucket allows INPUT_RATE steps per second (+10% for clock jitter).
   * Speed hacks that send inputs faster than real time simply get dropped.
   */
  queueInputs(client, msg, now) {
    if (!client.ship) return;
    const inputs = proto.parseInputs(msg);
    if (!inputs) return;

    const cfg = this.config;
    client.tokens = Math.min(cfg.INPUT_BURST, client.tokens + (now - client.tokenTime) * C.INPUT_RATE * 1.1 / 1000);
    client.tokenTime = now;

    for (const inp of inputs) {
      if (inp.seq <= client.lastQueuedSeq) continue; // duplicate / replayed
      client.lastQueuedSeq = inp.seq;
      if (client.tokens < 1) { this.win.droppedInputs++; continue; }
      client.tokens -= 1;
      client.queue.push(inp);
    }
    if (client.queue.length > cfg.INPUT_QUEUE_MAX) client.queue.splice(0, client.queue.length - cfg.INPUT_QUEUE_MAX);
  }

  sendText(client, str) {
    if (client.ws.readyState !== 1) return;
    client.ws.send(str);
    this.win.totalBytes += str.length;
    if (client.ship) this.win.playerBytes += str.length;
  }

  // ---------------------------------------------------------------- simulation

  /** One 50ms server tick. */
  step() {
    const t0 = performance.now();
    this.tick++;
    this.time = this.tick * C.TICK_MS;
    this.events = [];

    this.alivePlayers.length = 0;
    for (const s of this.ships.values()) if (!s.isBot && s.alive) this.alivePlayers.push(s);

    this.processPlayerInputs();
    this.updateBots();
    this.updateRespawnAndRegen();
    this.recordHistory();

    // Rebuild the spatial grid with fresh positions (O(n)).
    this.aliveShips.length = 0;
    for (const s of this.ships.values()) {
      s.gi = -1;
      if (s.alive) this.aliveShips.push(s);
    }
    this.shipGrid.build(this.aliveShips);

    this.updateBullets();
    this.updatePickups();
    this.encodeTick();
    this.updateSpectators();
    this.win.simSum += performance.now() - t0;

    if (this.tick % C.TICK_RATE === 0) this.publishStats();
    this.killfeedBuf = this.kills.length ? proto.encodeKillfeed(this.kills) : null;
    this.kills.length = 0;

    this.sendSnapshots(); // one binary frame per client per tick (stats + kill feed ride along)
    this.statsBuf = null;
    this.killfeedBuf = null;

    const ms = performance.now() - t0;
    this.win.tickSum += ms;
    this.win.tickN++;
    if (ms > this.win.tickMax) this.win.tickMax = ms;
  }

  processPlayerInputs() {
    const maxErr2 = C.MAX_FIRE_ORIGIN_ERROR * C.MAX_FIRE_ORIGIN_ERROR;
    for (const client of this.clients) {
      const ship = client.ship;
      if (!ship || client.queue.length === 0) continue;
      // Normally consume exactly the steps that fit in one tick; catch up a bit if a burst arrived.
      const n = Math.min(client.queue.length, client.queue.length > STEPS_PER_TICK * 3 ? STEPS_PER_TICK * 2 : STEPS_PER_TICK);
      for (let i = 0; i < n; i++) {
        const inp = client.queue.shift();
        client.ackSeq = inp.seq;
        if (!ship.alive) continue;
        ship.thrust = (inp.b & BTN.MOVE_MASK) !== 0;
        if (!stepShip(ship, inp.b, inp.aim, C.INPUT_DT)) continue;

        // Muzzle position: use the client's predicted position if it is close to ours (anti-abuse check).
        let origin = null;
        if (inp.origin) {
          const dx = inp.origin[0] - ship.x, dy = inp.origin[1] - ship.y;
          if (dx * dx + dy * dy <= maxErr2) origin = inp.origin;
          else this.win.rejectedOrigins++;
        }
        // LAG COMPENSATION: how far back in time was the world this player was looking at?
        let rewind = this.time - inp.view;
        if (!(rewind > 0)) rewind = 0;
        else if (rewind > C.MAX_REWIND_MS) rewind = C.MAX_REWIND_MS;
        this.fireBullet(ship, inp.seq, origin, rewind);
      }
    }
  }

  updateBots() {
    for (const p of this.alivePlayers) p.attackers = 0;
    for (const bot of this.bots) {
      if (!bot.alive || !bot.brain.targetId) continue;
      const t = this.ships.get(bot.brain.targetId);
      if (t && !t.isBot) t.attackers++;
    }
    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const input = bots.think(this, bot, this.time);
      bot.thrust = (input.buttons & BTN.MOVE_MASK) !== 0;
      for (let k = 0; k < STEPS_PER_TICK; k++) {
        if (stepShip(bot, input.buttons, input.aim, C.INPUT_DT)) {
          this.fireBullet(bot, 0, null, 0);
          const t = this.ships.get(bot.brain.targetId);
          bots.onFired(bot, this.time, !!t && !t.isBot);
          input.buttons &= ~BTN.FIRE;
        }
      }
    }
  }

  updateRespawnAndRegen() {
    for (const s of this.ships.values()) {
      if (!s.alive) {
        if (this.time >= s.respawnAt) {
          this.respawn(s);
          if (s.client) s.client.queue.length = 0;
        }
        continue;
      }
      if (s.hp < C.MAX_HP && this.time - s.lastDamageAt > C.REGEN_DELAY_MS) {
        s.hp = Math.min(C.MAX_HP, s.hp + C.REGEN_PER_SEC * C.TICK_DT);
      }
    }
  }

  fireBullet(ship, seq, origin, rewind) {
    const src = origin ? { x: origin[0], y: origin[1], a: ship.a, vx: ship.vx, vy: ship.vy } : ship;
    const b = bulletFrom(src);
    b.id = this.nextBulletId++;
    b.ownerId = ship.id;
    b.seq = seq;
    b.life = C.BULLET_LIFE;
    b.born = this.tick;
    b.fromBot = ship.isBot;
    b.rewind = rewind;
    b.style = ship.isBot ? 4 : ship.design;
    this.bullets.push(b);
    this.events.push(new TickEvent(true, 0, b.id, 0, b.x, b.y, 0, b));
  }

  /**
   * Move bullets and run swept hit tests.
   *
   * LAG COMPENSATION: a player's bullet is tested against where targets were
   * `rewind` ms ago - i.e. where that player SAW them on screen (remote ships
   * are drawn ~100ms in the past, plus network latency). Ship positions come
   * from the per-ship history ring buffer. The test is done in the target's
   * moving frame, so a fast target can't slip between two ticks.
   */
  updateBullets() {
    const R = C.SHIP_RADIUS + C.BULLET_RADIUS, dt = C.TICK_DT, W = C.WORLD_SIZE;
    const list = this.bullets;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (b.born === this.tick) continue; // a new bullet sits at its spawn point in this tick's snapshot

      const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
      const tEnd = this.time - b.rewind, tStart = tEnd - C.TICK_MS;

      const pad = R + (b.rewind / 1000) * C.MAX_SPEED + 20;
      scratch.length = 0;
      this.shipGrid.query(Math.min(b.x, nx) - pad, Math.min(b.y, ny) - pad, Math.max(b.x, nx) + pad, Math.max(b.y, ny) + pad, scratch);

      let hit = null, hitT = 2;
      for (let k = 0; k < scratch.length; k++) {
        const s = scratch[k];
        if (s.id === b.ownerId || !s.alive) continue;
        if (!this.posAt(s, tEnd, P1)) continue;
        if (!this.posAt(s, tStart, P0)) { P0.x = P1.x; P0.y = P1.y; }
        const t = segmentCircle(b.x - P0.x, b.y - P0.y, nx - P1.x, ny - P1.y, R);
        if (t >= 0 && t < hitT) { hit = s; hitT = t; }
      }

      const mt = segmentHitsMeteor(b.x, b.y, nx, ny, C.BULLET_RADIUS);
      if (mt >= 0 && mt < hitT) { hit = null; hitT = mt; }

      if (hitT <= 1) {
        const hx = b.x + (nx - b.x) * hitT, hy = b.y + (ny - b.y) * hitT;
        list[i] = list[list.length - 1];
        list.pop();
        const shielded = hit && this.time < hit.invulnUntil;
        // Bots hit humans softly (easier game) but fight each other at full strength (lively world).
        const dmg = hit && !shielded ? (b.fromBot && !hit.isBot ? C.BOT_BULLET_DAMAGE : C.BULLET_DAMAGE) : 0;
        this.events.push(new TickEvent(false, EV.HIT, b.id, hit ? hit.id : 0, hx, hy, dmg, null));
        if (dmg) this.damage(hit, dmg, b.ownerId);
        continue;
      }

      b.x = nx; b.y = ny;
      b.life -= dt;
      if (b.life <= 0 || nx < 0 || ny < 0 || nx > W || ny > W) {
        list[i] = list[list.length - 1];
        list.pop();
      }
    }
  }

  damage(target, amount, attackerId) {
    target.hp -= amount;
    target.lastDamageAt = this.time;
    if (target.isBot) bots.onDamaged(target, attackerId, this.time);
    if (target.hp > 0) return;

    target.hp = 0;
    target.alive = false;
    target.thrust = false;
    target.deaths++;
    target.respawnAt = this.time + C.RESPAWN_MS;

    const killer = this.ships.get(attackerId);
    if (killer && killer !== target) killer.kills++;

    this.events.push(new TickEvent(false, EV.DEATH, target.id, attackerId, target.x, target.y, 0, null));
    const flags = (s) => (s.isBot ? 1 : 0) | (s.design << 1);
    this.kills.push({
      killerId: killer ? killer.id : 0, killerName: killer ? killer.name : '???', killerFlags: killer ? flags(killer) : 1,
      victimId: target.id, victimName: target.name, victimFlags: flags(target),
    });
    if (Math.random() < 0.35) this.pickups.push(this.newPickup(true, target.x, target.y)); // wreck drops a repair kit
    if (target.client) {
      this.sendText(target.client, JSON.stringify([6, killer ? killer.name : 'unknown', C.RESPAWN_MS]));
    }
  }

  /** Encode every ship / bullet / event / pickup ONCE; snapshots copy these bytes. */
  encodeTick() {
    // Ships, in grid-index order: record i lives at byte i*12. Ships that died after the
    // grid was built this tick are flagged so snapshots skip them.
    const grid = this.shipGrid, n = grid.count;
    this.shipRec = ensureCapacity(this.shipRec, n * 12);
    if (this.shipAlive.length < n) { this.shipAlive = new Uint8Array(n * 2); this.shipIds = new Uint32Array(n * 2); }
    for (let i = 0; i < n; i++) {
      const s = grid.items[i];
      this.shipIds[i] = s.id;
      this.shipAlive[i] = s.alive ? 1 : 0;
      if (s.alive) proto.writeShip(this.shipRec, i * 12, s, this.time);
    }

    // Bullet spawns (19 bytes) and hit/death/pickup events (14 bytes).
    const ev = this.events, ne = ev.length;
    let size = 0;
    for (let i = 0; i < ne; i++) size += ev[i].bullet ? 19 : 14;
    this.eventRec = ensureCapacity(this.eventRec, size);
    if (this.evOff.length < ne) { this.evOff = new Int32Array(ne * 2); this.evBullet = new Uint8Array(ne * 2); }
    let off = 0;
    for (let i = 0; i < ne; i++) {
      const e = ev[i];
      this.evOff[i] = off;
      this.evBullet[i] = e.bullet ? 1 : 0;
      if (e.bullet) { proto.writeBullet(this.eventRec, off, e.bulletObj); off += 19; }
      else { proto.writeEvent(this.eventRec, off, e); off += 14; }
    }
    this.eventGrid.build(ev);

    // Active repair pickups: record i at byte i*8.
    const active = this.activePickups;
    active.length = 0;
    for (const p of this.pickups) if (p.active) active.push(p);
    this.pickupRec = ensureCapacity(this.pickupRec, active.length * 8);
    for (let i = 0; i < active.length; i++) proto.writePickup(this.pickupRec, i * 8, active[i]);
    this.pickupGrid.build(active);
  }

  /** Visitors on the start screen watch the live battle through a bot's camera. */
  updateSpectators() {
    let candidates = null;
    for (const client of this.clients) {
      if (client.ship) continue;
      const cur = this.ships.get(client.spectateId);
      if (cur && cur.alive && this.time < client.spectateUntil) continue;
      if (!candidates) {
        const fighting = this.bots.filter((b) => b.alive && b.brain.targetId);
        candidates = fighting.length ? fighting : [...this.ships.values()].filter((s) => s.alive);
      }
      if (!candidates.length) continue;
      client.spectateId = candidates[(Math.random() * candidates.length) | 0].id;
      client.spectateUntil = this.time + 12000;
    }
  }

  sendSnapshots() {
    const limit = this.config.SEND_BACKPRESSURE_BYTES;
    let aoi = 0, net = 0;
    for (const client of this.clients) {
      const ws = client.ws;
      if (ws.readyState !== 1) continue;
      // Slow connection? Skip this snapshot rather than queue up stale data.
      if (ws.bufferedAmount > limit) { this.win.skippedSnaps++; continue; }
      const t0 = performance.now();
      const snap = buildSnapshot(this, client);
      const t1 = performance.now();
      ws.send(snap, SEND_OPTS);
      aoi += t1 - t0;
      net += performance.now() - t1;
      this.win.totalBytes += snap.length;
      if (client.ship) this.win.playerBytes += snap.length;
    }
    this.win.aoiSum += aoi;
    this.win.netSum += net;
  }

  // ---------------------------------------------------------------- stats

  publishStats() {
    const w = this.win;
    const players = this.playerCount;
    const spectators = this.clients.size - players;
    const per = (v) => (w.tickN ? v / w.tickN : 0);
    const s = {
      players, bots: this.bots.length, spectators,
      tickAvg: per(w.tickSum), tickMax: w.tickMax,
      sim: per(w.simSum), aoi: per(w.aoiSum), send: per(w.netSum),
      bytesPerPlayer: players ? w.playerBytes / players : 0,
    };

    const ranked = [...this.ships.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
    for (let i = 0; i < ranked.length; i++) ranked[i].rank = i + 1;
    this.statsBuf = proto.encodeStats(s, ranked.slice(0, 10), ranked.length);

    const r = (v) => Math.round(v * 1000) / 1000;
    this.lastStats = {
      players, bots: s.bots, spectators,
      tickMsAvg: r(s.tickAvg), tickMsMax: r(s.tickMax),
      tickBreakdownMs: { simulation: r(s.sim), interestAndEncode: r(s.aoi), socketSend: r(s.send) },
      bytesPerPlayerPerSec: Math.round(s.bytesPerPlayer),
      totalBytesPerSec: w.totalBytes,
      bullets: this.bullets.length,
      droppedInputs: w.droppedInputs, skippedSnapshots: w.skippedSnaps, rejectedMuzzleOrigins: w.rejectedOrigins,
      tick: this.tick,
    };
    if (this.tick % (C.TICK_RATE * 10) === 0) {
      console.log(
        `[stats] players=${players} bots=${s.bots} spectators=${spectators} ` +
        `tick=${s.tickAvg.toFixed(2)}ms (max ${s.tickMax.toFixed(2)}; sim ${s.sim.toFixed(2)} aoi ${s.aoi.toFixed(2)} send ${s.send.toFixed(2)}) ` +
        `out=${(s.bytesPerPlayer / 1024).toFixed(1)}KB/s/player bullets=${this.bullets.length}`
      );
    }
    this.win = this.newWindow();
  }
}

module.exports = { Game };
