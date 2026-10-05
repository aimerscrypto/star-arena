/*
 * Code shared by the server (Node `require`) and the browser (<script> tag).
 *
 * - Ship physics live here so the client can run the *exact same* simulation the
 *   server runs. That is what makes client-side prediction + reconciliation work.
 * - The meteor field is generated from a fixed seed, so server and client build
 *   the identical map locally: static world data never goes over the network.
 *
 * Determinism note: stepShip() only uses +, -, *, / and Math.sqrt (all exactly
 * specified by IEEE-754), so the browser and Node produce bit-identical results.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Shared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const C = {
    WORLD_SIZE: 8000,

    TICK_RATE: 20,              // server simulation + snapshot rate (Hz)
    TICK_MS: 50,
    TICK_DT: 0.05,

    INPUT_RATE: 40,             // client input sampling rate (Hz)
    INPUT_DT: 1 / 40,
    INPUTS_PER_MSG: 2,          // inputs are batched -> 20 messages/s upstream

    INTERP_DELAY_MS: 100,       // remote entities are rendered this far in the past
    MAX_REWIND_MS: 200,         // lag compensation cap
    HISTORY_TICKS: 32,          // per-ship position history (1.6 s)
    MAX_FIRE_ORIGIN_ERROR: 40,  // how far a client-reported muzzle position may be from the server's

    SHIP_DRAW_SIZE: 72,         // ship sprites (128px art) are drawn this many world units wide
    SHIP_RADIUS: 26,            // hit + collision radius, matched to the sprite hull
    SHIP_NOSE: 30,              // bullet spawn distance in front of the ship centre
    ACCEL: 1500,
    MAX_SPEED: 480,
    DRAG: 1.8,                  // linear damping per second
    TURN_RATE: 16,              // rad/s
    METEOR_BOUNCE: 0.55,
    MAX_HP: 100,
    REGEN_DELAY_MS: 5000,
    REGEN_PER_SEC: 6,

    BULLET_SPEED: 1150,
    BULLET_RADIUS: 4,
    BULLET_INHERIT: 0.3,        // fraction of ship velocity added to bullets
    BULLET_LIFE: 0.85,          // seconds
    FIRE_COOLDOWN: 0.22,        // seconds, enforced by the server
    BULLET_DAMAGE: 12,
    BOT_BULLET_DAMAGE: 6,

    RESPAWN_MS: 3000,
    SPAWN_INVULN_MS: 3000,

    PICKUP_COUNT: 55,
    PICKUP_RADIUS: 30,
    PICKUP_HEAL: 40,
    PICKUP_RESPAWN_MS: 15000,

    // Interest management: each client only receives what is inside this box
    // around its ship (half extents). The client zooms so its viewport always
    // fits inside it.
    AOI_HALF_W: 1200,
    AOI_HALF_H: 800,
    AOI_EVENT_MARGIN: 500,      // extra margin for bullet spawns / explosions
    GRID_CELL: 500,

    PLAYER_DESIGNS: 4,
    BOT_DESIGNS: 2,

    METEOR_SEED: 1337,
    METEOR_COUNT: 110,
    METEOR_CELL: 400,
  };

  const BTN = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, FIRE: 16, MOVE_MASK: 15, ALL: 31 };

  // Client -> server (JSON arrays, small and infrequent apart from INPUT)
  //   JOIN:  [0, name, design]
  //   INPUT: [1, firstSeq, viewTimeMs, buttons0, aim0, buttons1, aim1, ([muzzleX, muzzleY])]
  //   PING:  [2, clientTime]
  const C2S = { JOIN: 0, INPUT: 1, PING: 2 };

  // Server -> client. SNAP is binary; the others are rare JSON text messages.
  const S2C = { HELLO: 0, SNAP: 1, PONG: 4, JOINED: 5, DIED: 6 };

  // Binary snapshot layout (little-endian). See server/protocol.js for the writer
  // and client/js/protocol.js for the reader.
  const BIN = {
    POS_SCALE: 8,               // positions as uint16 in 1/8 world units (8000 * 8 < 65536)
    HEADER: 14,                 // u8 type, u8 flags, u32 tick, u32 ack, u32 focusId
    F_SELF: 1, F_STATS: 2, F_KILLFEED: 4,
    SELF_REC: 59,               // 6 x f64 (x,y,vx,vy,a,cd), u8 hp, u8 alive, u16 respawnMs, u16 shieldMs, u16 kills, u16 deaths, u8 design
    SHIP_REC: 12,               // u32 id, u16 x, u16 y, u16 angle, u8 hp, u8 flags
    BULLET_REC: 19,             // u32 id, u16 x, u16 y, i16 vx, i16 vy, u32 owner, u16 seq, u8 style
    EVENT_REC: 14,              // u8 type, u32 a, u32 b, u16 x, u16 y, u8 value
    PICKUP_REC: 8,              // u32 id, u16 x, u16 y
    STATS_RANK_OFFSET: 30,      // where the per-viewer rank sits inside the stats section
  };

  // Snapshot events
  const EV = { HIT: 1, DEATH: 2, PICKUP: 3 };

  // Remote ship flags (low 3 bits) + design index in bits 3..5
  const FLAG = { THRUST: 1, SHIELD: 2, BOT: 4, DESIGN_SHIFT: 3 };

  const TWO_PI = Math.PI * 2;

  function wrapAngle(a) {
    while (a > Math.PI) a -= TWO_PI;
    while (a < -Math.PI) a += TWO_PI;
    return a;
  }

  // ------------------------------------------------------------------ meteors

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Deterministic meteor field: identical on server and every client. */
  const METEORS = (function generate() {
    const rnd = mulberry32(C.METEOR_SEED);
    const out = [];
    const W = C.WORLD_SIZE;
    for (let tries = 0; tries < 5000 && out.length < C.METEOR_COUNT; tries++) {
      const r = 38 + Math.pow(rnd(), 1.7) * 85;
      const x = 300 + rnd() * (W - 600);
      const y = 300 + rnd() * (W - 600);
      let ok = true;
      for (const m of out) {
        const dx = m.x - x, dy = m.y - y, min = m.r + r + 140;
        if (dx * dx + dy * dy < min * min) { ok = false; break; }
      }
      if (!ok) continue;
      out.push({
        id: out.length, x: Math.round(x), y: Math.round(y), r: Math.round(r),
        variant: (rnd() * 3) | 0, rot: rnd() * TWO_PI, spin: (rnd() - 0.5) * 0.25,
      });
    }
    return out;
  })();

  // Static lookup grid: each cell lists every meteor whose (inflated) circle touches it,
  // so a point query is a single array lookup.
  const MCOLS = Math.ceil(C.WORLD_SIZE / C.METEOR_CELL);
  const METEOR_GRID = (function build() {
    const cells = [];
    for (let i = 0; i < MCOLS * MCOLS; i++) cells.push([]);
    // Pad covers a ship radius, or a full bullet step (~58 units) for segment tests.
    const pad = 70;
    for (const m of METEORS) {
      const rr = m.r + pad;
      const c0 = Math.max(0, Math.floor((m.x - rr) / C.METEOR_CELL)), c1 = Math.min(MCOLS - 1, Math.floor((m.x + rr) / C.METEOR_CELL));
      const r0 = Math.max(0, Math.floor((m.y - rr) / C.METEOR_CELL)), r1 = Math.min(MCOLS - 1, Math.floor((m.y + rr) / C.METEOR_CELL));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * MCOLS + c].push(m);
    }
    return cells;
  })();

  function meteorsAt(x, y) {
    let c = Math.floor(x / C.METEOR_CELL), r = Math.floor(y / C.METEOR_CELL);
    if (c < 0) c = 0; else if (c >= MCOLS) c = MCOLS - 1;
    if (r < 0) r = 0; else if (r >= MCOLS) r = MCOLS - 1;
    return METEOR_GRID[r * MCOLS + c];
  }

  /** Push a ship out of any meteor it overlaps and bounce its velocity. */
  function collideMeteors(s) {
    const list = meteorsAt(s.x, s.y);
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const dx = s.x - m.x, dy = s.y - m.y;
      const min = m.r + C.SHIP_RADIUS * 0.85;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dy / d;
      s.x = m.x + nx * min;
      s.y = m.y + ny * min;
      const vn = s.vx * nx + s.vy * ny;
      if (vn < 0) {
        const k = (1 + C.METEOR_BOUNCE) * vn;
        s.vx -= k * nx;
        s.vy -= k * ny;
      }
    }
  }

  /** Earliest t in [0,1] where segment (x0,y0)->(x1,y1) touches a meteor, or -1. */
  function segmentHitsMeteor(x0, y0, x1, y1, radius) {
    let best = -1;
    const test = (list) => {
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        const t = segmentCircle(x0 - m.x, y0 - m.y, x1 - m.x, y1 - m.y, m.r + radius);
        if (t >= 0 && (best < 0 || t < best)) best = t;
      }
    };
    const a = meteorsAt(x0, y0), b = meteorsAt(x1, y1);
    test(a);
    if (b !== a) test(b);
    return best;
  }

  /**
   * Segment (ax,ay)->(bx,by) vs circle of radius r at the origin.
   * Returns the parameter t of the closest approach if it is inside the circle, else -1.
   */
  function segmentCircle(ax, ay, bx, by, r) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const px = ax + dx * t, py = ay + dy * t;
    return px * px + py * py <= r * r ? t : -1;
  }

  // ------------------------------------------------------------------ ship physics

  /**
   * Advance one ship by one input step. Mutates `s` ({x,y,vx,vy,a,cd}).
   * Returns true if the ship fired a bullet during this step.
   */
  function stepShip(s, buttons, aim, dt) {
    // Rotate toward the aim angle with a capped turn rate.
    let d = wrapAngle(aim - s.a);
    const maxTurn = C.TURN_RATE * dt;
    if (d > maxTurn) d = maxTurn;
    else if (d < -maxTurn) d = -maxTurn;
    s.a = wrapAngle(s.a + d);

    // Directional thrust (WASD / arrows).
    let ix = 0, iy = 0;
    if (buttons & BTN.LEFT) ix -= 1;
    if (buttons & BTN.RIGHT) ix += 1;
    if (buttons & BTN.UP) iy -= 1;
    if (buttons & BTN.DOWN) iy += 1;
    if (ix !== 0 || iy !== 0) {
      const k = (ix !== 0 && iy !== 0 ? Math.SQRT1_2 : 1) * C.ACCEL * dt;
      s.vx += ix * k;
      s.vy += iy * k;
    }

    // Drag + speed clamp (server-side speed clamp is also the anti-speedhack guard).
    const damp = 1 - C.DRAG * dt;
    s.vx *= damp;
    s.vy *= damp;
    const sp2 = s.vx * s.vx + s.vy * s.vy;
    if (sp2 > C.MAX_SPEED * C.MAX_SPEED) {
      const k = C.MAX_SPEED / Math.sqrt(sp2);
      s.vx *= k;
      s.vy *= k;
    }

    s.x += s.vx * dt;
    s.y += s.vy * dt;

    // World bounds.
    const r = C.SHIP_RADIUS, max = C.WORLD_SIZE - r;
    if (s.x < r) { s.x = r; if (s.vx < 0) s.vx = 0; }
    else if (s.x > max) { s.x = max; if (s.vx > 0) s.vx = 0; }
    if (s.y < r) { s.y = r; if (s.vy < 0) s.vy = 0; }
    else if (s.y > max) { s.y = max; if (s.vy > 0) s.vy = 0; }

    collideMeteors(s);

    // Weapon cooldown.
    s.cd -= dt;
    if (s.cd < 0) s.cd = 0;
    if ((buttons & BTN.FIRE) && s.cd <= 0) {
      s.cd = C.FIRE_COOLDOWN;
      return true;
    }
    return false;
  }

  /** Initial bullet state for a ship that just fired. */
  function bulletFrom(s) {
    const cos = Math.cos(s.a), sin = Math.sin(s.a);
    return {
      x: s.x + cos * C.SHIP_NOSE,
      y: s.y + sin * C.SHIP_NOSE,
      vx: cos * C.BULLET_SPEED + s.vx * C.BULLET_INHERIT,
      vy: sin * C.BULLET_SPEED + s.vy * C.BULLET_INHERIT,
    };
  }

  /** Is a point clear of meteors (with margin)? */
  function isClearOfMeteors(x, y, margin) {
    for (const m of METEORS) {
      const dx = m.x - x, dy = m.y - y, min = m.r + margin;
      if (dx * dx + dy * dy < min * min) return false;
    }
    return true;
  }

  return {
    C, BTN, C2S, S2C, BIN, EV, FLAG,
    METEORS, meteorsAt, segmentHitsMeteor, segmentCircle, isClearOfMeteors,
    wrapAngle, stepShip, bulletFrom,
  };
});
