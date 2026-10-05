// Client-side world state.
//
//  * OWN SHIP    -> client-side prediction: inputs are applied locally right away
//                   with the same stepShip() the server runs, then reconciled
//                   against each authoritative snapshot (replaying unacked inputs).
//  * OTHER SHIPS -> entity interpolation: rendered ~100ms in the past, smoothly
//                   between two received snapshots.
//  * BULLETS     -> sent once at spawn; the client simulates their flight on the
//                   same delayed timeline as the ship that fired them. Our own
//                   bullets appear instantly (predicted) and are linked to the
//                   server's copy by input sequence number, so they never double up.
//  * LAG COMP    -> every input carries the time of the world we were looking at,
//                   so the server can rewind targets when checking our hits.

const { C, C2S, S2C, EV, FLAG, BTN, stepShip, bulletFrom, wrapAngle, segmentHitsMeteor } = window.Shared;

const round3 = (v) => Math.round(v * 1000) / 1000;
const round1 = (v) => Math.round(v * 10) / 10;
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
const copyState = (s) => ({ x: s.x, y: s.y, vx: s.vx, vy: s.vy, a: s.a, cd: s.cd });

export class World {
  /**
   * fx:    visual effect callbacks (implemented by the Pixi scene)
   * sfx:   sound effects
   * hooks: UI callbacks (joined, died, killfeed, stats)
   */
  constructor(net, input, fx, sfx, hooks) {
    this.net = net;
    this.input = input;
    this.fx = fx;
    this.sfx = sfx;
    this.hooks = hooks;
    this.view = { camX: C.WORLD_SIZE / 2, camY: C.WORLD_SIZE / 2, scale: 1, w: innerWidth, h: innerHeight };
    this.stats = null;
    this.statsHistory = [];
    this.reset();
  }

  reset() {
    this.myId = 0;
    this.myName = '';
    this.myDesign = 0;
    this.joined = false;
    this.focusId = 0;
    this.offset = null;           // serverTime - performance.now()
    this.ships = new Map();       // remote ships (interpolated)
    this.names = new Map();       // id -> name
    this.bullets = [];            // remote bullets
    this.events = [];             // events waiting for render time to reach them
    this.pickups = [];
    this.me = null;               // own ship (predicted)
    this.pending = [];            // inputs sent but not yet acknowledged
    this.batch = [];
    this.batchSeq = 0;
    this.batchOrigin = null;
    this.nextSeq = 1;
    this.acc = 0;
    this.errX = 0; this.errY = 0; // visual smoothing of reconciliation corrections
    this.lastCorrection = 0;
    this.localBullets = [];       // own bullets, predicted
    this.shake = 0;
    this.hurt = 0;
    this.leaderboard = [];
    this.rank = 0;
    this.rankTotal = 0;
    this.aoiShips = 0;
  }

  // ------------------------------------------------------------------ network

  onMessage(type, m) {
    switch (type) {
      case S2C.SNAP: this.onSnapshot(m); break;
      case S2C.JOINED:
        this.myId = m[1];
        this.myName = m[2];
        this.myDesign = m[3];
        this.joined = true;
        this.names.set(this.myId, m[2]);
        this.me = { alive: false, cur: null, prev: null, hp: C.MAX_HP, kills: 0, deaths: 0, design: m[3],
          respawnMs: 0, shieldMs: 0, recvAt: 0, rx: 0, ry: 0, ra: 0, buttons: 0, deadX: 0, deadY: 0 };
        this.hooks.joined();
        break;
      case S2C.DIED: this.hooks.died(m[1], m[2]); break;
    }
  }

  serverNow() { return performance.now() + (this.offset || 0); }
  renderTime() { return this.serverNow() - C.INTERP_DELAY_MS; }

  distVol(x, y, scale = 1) {
    const d = Math.hypot(x - this.view.camX, y - this.view.camY);
    return Math.max(0, 1 - d / 1400) * scale;
  }

  onSnapshot(snap) {
    const now = performance.now();
    const t = snap.tick * C.TICK_MS;

    // Clock sync: smoothed estimate of server time, robust to network jitter.
    const sample = t - now;
    if (this.offset === null || Math.abs(sample - this.offset) > 400) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.06;

    this.focusId = snap.focusId;
    for (const n of snap.names) this.names.set(n.id, n.name);

    // Remote ships: append to each ship's interpolation buffer.
    for (const r of snap.ships) {
      let s = this.ships.get(r.id);
      if (!s) {
        s = { id: r.id, isBot: (r.flags & FLAG.BOT) !== 0, design: (r.flags >> FLAG.DESIGN_SHIFT) & 7,
          buf: [], seen: 0, goneAt: Infinity, x: r.x, y: r.y, a: r.a, vx: 0, vy: 0, hp: r.hp, f: r.flags,
          lastHp: r.hp, flash: 0, visible: false };
        this.ships.set(r.id, s);
      }
      const buf = s.buf;
      if (buf.length && t - buf[buf.length - 1].t > 200) buf.length = 0; // re-entered view: don't interpolate across the gap
      buf.push({ t, x: r.x, y: r.y, a: r.a, hp: r.hp, f: r.flags });
      if (buf.length > 30) buf.splice(0, buf.length - 30);
      s.seen = snap.tick;
      s.goneAt = Infinity;
    }
    // Ships missing from this snapshot left our interest area (or died).
    for (const s of this.ships.values()) {
      if (s.seen !== snap.tick && s.goneAt === Infinity) s.goneAt = s.buf.length ? s.buf[s.buf.length - 1].t : t;
    }
    this.aoiShips = snap.ships.length;

    // Bullet spawns.
    for (const b of snap.bullets) {
      if (this.myId && b.owner === this.myId) {
        // Our own bullet: we already show a predicted copy. Link it so a server hit can remove it.
        for (const lb of this.localBullets) if ((lb.seq & 0xffff) === b.seq && !lb.serverId) { lb.serverId = b.id; break; }
        continue;
      }
      this.bullets.push({ id: b.id, x0: b.x, y0: b.y, vx: b.vx, vy: b.vy, x: b.x, y: b.y, t0: t,
        style: b.style, owner: b.owner, visible: false, muzzled: false, dead: false });
    }

    // Hits, deaths, pickups.
    const M = this.me;
    for (const e of snap.events) {
      if (e.type === EV.HIT) {
        let mine = false;
        for (const lb of this.localBullets) {
          if (lb.serverId === e.a) {
            if (!lb.dead) this.fx.impact(lb.x, lb.y, e.b === 0);
            lb.dead = true; mine = true; break;
          }
        }
        if (mine && e.b && e.value) {
          // Server-confirmed hit by us: show it right away where we see the target.
          const target = this.ships.get(e.b);
          const x = target && target.visible ? target.x : e.x, y = target && target.visible ? target.y : e.y;
          if (target) target.flash = 1;
          this.fx.damageNumber(x, y - 34, String(e.value), 'dealt');
          this.sfx.hit(0.55);
        }
        if (M && e.b === this.myId) { // we are drawn in the present, so react immediately
          this.fx.impact(M.rx, M.ry, false);
          if (e.value) {
            this.fx.damageNumber(M.rx, M.ry - 34, String(e.value), 'taken');
            this.sfx.hit(0.9);
          }
          continue;
        }
        if (!mine) this.events.push({ t, type: EV.HIT, bulletId: e.a, targetId: e.b, x: e.x, y: e.y, value: e.value });
      } else if (e.type === EV.DEATH) {
        if (M && e.a === this.myId) {
          this.fx.explosion(M.rx, M.ry, M.design, false);
          this.sfx.explosion(1);
          this.shake = Math.max(this.shake, 16);
          continue;
        }
        this.events.push({ t, type: EV.DEATH, victimId: e.a, killerId: e.b, x: e.x, y: e.y });
      } else if (e.type === EV.PICKUP) {
        if (M && e.b === this.myId) {
          this.fx.pickupTaken(e.x, e.y);
          this.fx.damageNumber(M.rx, M.ry - 34, '+' + e.value, 'heal');
          this.sfx.pickup();
        } else {
          this.events.push({ t, type: EV.PICKUP, x: e.x, y: e.y });
        }
      }
    }
    if (this.events.length > 600) this.events.splice(0, this.events.length - 600);

    this.pickups = snap.pickups;
    if (snap.self && M) this.reconcile(snap.self, snap.ack);
    if (snap.stats) this.onStats(snap.stats);
    if (snap.kills) this.hooks.killfeed(snap.kills);
  }

  /** Server reconciliation for our own ship. */
  reconcile(self, ack) {
    const M = this.me;
    if (self.alive && M.alive && self.hp < M.hp) {
      this.shake = Math.min(14, this.shake + (M.hp - self.hp) * 0.7); // screen shake only when WE get hit
      this.hurt = 1;
    }
    M.hp = self.hp; M.kills = self.kills; M.deaths = self.deaths; M.design = self.design;
    M.respawnMs = self.respawnMs; M.shieldMs = self.shieldMs; M.recvAt = performance.now();

    if (!self.alive) {
      if (M.alive) { M.alive = false; this.pending.length = 0; this.batch.length = 0; this.batchOrigin = null; }
      M.deadX = self.x; M.deadY = self.y;
      return;
    }

    const server = { x: self.x, y: self.y, vx: self.vx, vy: self.vy, a: self.a, cd: self.cd };
    if (!M.alive) { // spawned / respawned: snap to the server state
      M.alive = true;
      M.cur = server;
      M.prev = copyState(server);
      M.rx = server.x; M.ry = server.y; M.ra = server.a;
      this.pending.length = 0;
      this.batch.length = 0;
      this.batchOrigin = null;
      this.errX = this.errY = 0;
      this.acc = 0;
      this.sfx.respawn();
      return;
    }

    // 1) forget inputs the server has already applied
    let k = 0;
    while (k < this.pending.length && this.pending[k].seq <= ack) k++;
    if (k) this.pending.splice(0, k);
    // 2) re-apply the inputs still in flight on top of the authoritative state
    for (const p of this.pending) stepShip(server, p.b, p.aim, C.INPUT_DT);
    // 3) any difference to what we predicted is blended out visually instead of snapping
    const dx = M.cur.x - server.x, dy = M.cur.y - server.y;
    this.lastCorrection = Math.sqrt(dx * dx + dy * dy);
    if (dx * dx + dy * dy > 250 * 250) {
      this.errX = this.errY = 0;
      M.prev = copyState(server);
    } else {
      this.errX += dx; this.errY += dy;
      M.prev.x -= dx; M.prev.y -= dy;
    }
    M.cur = server;
  }

  onStats(s) {
    this.stats = s;
    this.statsHistory.push(s.tickAvg);
    if (this.statsHistory.length > 60) this.statsHistory.shift();
    this.leaderboard = s.top;
    this.rank = s.rank;
    this.rankTotal = s.rankTotal;
    this.hooks.stats();
  }

  // ------------------------------------------------------------------ prediction

  aimAngle() {
    const M = this.me;
    if (!this.input.mouseMoved) return M.cur.a;
    const v = this.view;
    const wx = v.camX + (this.input.mouseX - v.w / 2) / v.scale;
    const wy = v.camY + (this.input.mouseY - v.h / 2) / v.scale;
    return Math.atan2(wy - M.ry, wx - M.rx);
  }

  /** One fixed 25ms input step: predict locally, remember it, send it. */
  predictStep() {
    const M = this.me;
    const b = this.input.buttons();
    const aim = round3(this.aimAngle()); // round BEFORE using it so client and server use the same value
    const seq = this.nextSeq++;

    M.prev = copyState(M.cur);
    const fired = stepShip(M.cur, b, aim, C.INPUT_DT);
    M.buttons = b;
    if (fired) {
      const bl = bulletFrom(M.cur);
      this.localBullets.push({ x: bl.x, y: bl.y, vx: bl.vx, vy: bl.vy, life: C.BULLET_LIFE, seq, serverId: 0, dead: false });
      this.fx.muzzle(bl.x, bl.y, M.cur.a, M.design, false);
      this.sfx.laser(1, 1 + M.design * 0.06);
      // Tell the server exactly where we fired from (it validates the distance).
      this.batchOrigin = [round1(M.cur.x), round1(M.cur.y)];
    }

    this.pending.push({ seq, b, aim });
    if (this.pending.length > 240) this.pending.shift();

    if (this.batch.length === 0) this.batchSeq = seq;
    this.batch.push(b, aim);
    if (this.batch.length >= C.INPUTS_PER_MSG * 2) {
      // [INPUT, firstSeq, viewTime, b0, a0, b1, a1, (muzzle)] - viewTime drives server-side lag compensation
      const msg = [C2S.INPUT, this.batchSeq, Math.round(this.renderTime()), ...this.batch];
      if (this.batchOrigin) msg.push(this.batchOrigin);
      this.net.send(msg);
      this.batch.length = 0;
      this.batchOrigin = null;
    }
  }

  // ------------------------------------------------------------------ per frame

  update(dt) {
    const M = this.me;

    // Own ship: fixed-step prediction, rendered interpolated between the last two steps.
    if (this.joined && M && M.alive) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= C.INPUT_DT) {
        this.acc -= C.INPUT_DT;
        if (++steps > 8) { this.acc = 0; break; }
        this.predictStep();
      }
      const decay = Math.exp(-dt * 10);
      this.errX *= decay; this.errY *= decay;
      const alpha = this.acc / C.INPUT_DT;
      M.rx = lerp(M.prev.x, M.cur.x, alpha) + this.errX;
      M.ry = lerp(M.prev.y, M.cur.y, alpha) + this.errY;
      M.ra = lerpAngle(M.prev.a, M.cur.a, alpha);
    }

    const rt = this.renderTime();
    this.rt = rt;

    // Timed events (hits / deaths) fire when the delayed render clock reaches them.
    while (this.events.length && this.events[0].t <= rt) this.applyEvent(this.events.shift());

    // Remote ships: interpolate.
    for (const s of this.ships.values()) {
      if (rt > s.goneAt) { this.ships.delete(s.id); continue; }
      this.interpolate(s, rt);
      if (!s.visible) continue;
      if (s.hp < s.lastHp) s.flash = 1;
      s.lastHp = s.hp;
      if (s.flash > 0) s.flash = Math.max(0, s.flash - dt * 7);
    }

    // Remote bullets: closed-form flight on the delayed timeline.
    const B = this.bullets;
    for (let i = B.length - 1; i >= 0; i--) {
      const b = B[i];
      const age = (rt - b.t0) / 1000;
      if (b.dead || age > C.BULLET_LIFE) { B[i] = B[B.length - 1]; B.pop(); continue; }
      if (age < 0) { b.visible = false; continue; }
      b.visible = true;
      b.x = b.x0 + b.vx * age;
      b.y = b.y0 + b.vy * age;
      if (!b.muzzled) {
        b.muzzled = true;
        const owner = this.ships.get(b.owner);
        this.fx.muzzle(b.x0, b.y0, Math.atan2(b.vy, b.vx), owner ? owner.design : 0, b.style === 4);
        this.sfx.laser(this.distVol(b.x0, b.y0, 0.35), b.style === 4 ? 0.8 : 1);
      }
    }

    // Own predicted bullets: simulated in the present. They vanish on visual contact
    // (the server decides the damage and confirms it a moment later).
    const L = this.localBullets;
    const hitR2 = (C.SHIP_RADIUS + C.BULLET_RADIUS) ** 2;
    for (let i = L.length - 1; i >= 0; i--) {
      const b = L[i];
      const ox = b.x, oy = b.y;
      b.life -= dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (!b.dead) {
        const mt = segmentHitsMeteor(ox, oy, b.x, b.y, C.BULLET_RADIUS);
        if (mt >= 0) {
          b.dead = true;
          this.fx.impact(ox + (b.x - ox) * mt, oy + (b.y - oy) * mt, true);
        } else {
          for (const s of this.ships.values()) {
            if (!s.visible) continue;
            const dx = s.x - b.x, dy = s.y - b.y;
            if (dx * dx + dy * dy < hitR2) { b.dead = true; this.fx.impact(b.x, b.y, false); break; }
          }
        }
      }
      if (b.dead || b.life <= 0) { L[i] = L[L.length - 1]; L.pop(); }
    }

    this.shake *= Math.exp(-dt * 9);
    if (this.shake < 0.15) this.shake = 0;
    this.hurt = Math.max(0, this.hurt - dt * 2.5);
  }

  interpolate(s, rt) {
    const buf = s.buf, n = buf.length;
    if (n === 0 || rt < buf[0].t) { s.visible = false; return; }
    let j = n - 1;
    while (j > 0 && buf[j].t > rt) j--;
    const A = buf[j];
    if (j === n - 1) {
      // Newest sample is older than render time (late packet): extrapolate briefly.
      let vx = 0, vy = 0;
      if (n >= 2) {
        const P = buf[n - 2], d = (A.t - P.t) / 1000 || C.TICK_DT;
        vx = (A.x - P.x) / d; vy = (A.y - P.y) / d;
      }
      const ex = Math.min(rt - A.t, 100) / 1000;
      s.x = A.x + vx * ex; s.y = A.y + vy * ex; s.a = A.a;
      s.vx = vx; s.vy = vy;
    } else {
      const B = buf[j + 1];
      const k = (rt - A.t) / (B.t - A.t);
      s.x = lerp(A.x, B.x, k);
      s.y = lerp(A.y, B.y, k);
      s.a = lerpAngle(A.a, B.a, k);
      const d = (B.t - A.t) / 1000;
      s.vx = (B.x - A.x) / d; s.vy = (B.y - A.y) / d;
    }
    s.hp = A.hp;
    s.f = A.f;
    s.visible = true;
    if (j > 2) buf.splice(0, j - 2);
  }

  applyEvent(e) {
    if (e.type === EV.HIT) {
      for (const b of this.bullets) if (b.id === e.bulletId) { b.dead = true; break; }
      const target = this.ships.get(e.targetId);
      if (target && e.value) target.flash = 1;
      this.fx.impact(e.x, e.y, e.targetId === 0);
    } else if (e.type === EV.DEATH) {
      const victim = this.ships.get(e.victimId);
      this.fx.explosion(e.x, e.y, victim ? victim.design : 0, victim ? victim.isBot : true);
      this.sfx.explosion(this.distVol(e.x, e.y, 0.7));
    } else if (e.type === EV.PICKUP) {
      this.fx.pickupTaken(e.x, e.y);
    }
  }
}
