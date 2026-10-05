// PixiJS (WebGL) scene. Everything visible in the world is an SVG-based sprite.

import { shipInfo, BULLET_STYLES } from './assets.js';
import { Background } from './background.js';

const { C, FLAG, BTN, METEORS } = window.Shared;
const SHIP_SCALE = C.SHIP_DRAW_SIZE / 128;
const METEOR_ART_R = 54;     // rock radius inside the 128px meteor art
const HALF_PI = Math.PI / 2;

const NAME_STYLE = {
  fontFamily: '"Exo 2", "Segoe UI", sans-serif', fontSize: 13, fontWeight: '600',
  fill: 0xffffff, stroke: { color: 0x0a0e18, width: 3, join: 'round' },
};
const NUMBER_STYLE = {
  fontFamily: '"Russo One", "Exo 2", sans-serif', fontSize: 20,
  fill: 0xffe066, stroke: { color: 0x0a0e18, width: 4, join: 'round' },
};
const NUMBER_COLORS = { dealt: 0xffe066, taken: 0xff5a4f, heal: 0x7ee07a };

function hexToNum(hex) { return parseInt(hex.slice(1), 16); }
function lighten(hex, k) {
  const n = hexToNum(hex);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return ((r + (255 - r) * k) << 16) | ((g + (255 - g) * k) << 8) | (b + (255 - b) * k);
}

/** One ship on screen: rotated body (flames + hull + flash) plus an unrotated shield and a screen-space label. */
class ShipView {
  constructor(scene, design, isBot, isMe) {
    const tex = scene.tex;
    const info = shipInfo(design, isBot);
    this.root = new PIXI.Container();
    this.body = new PIXI.Container();
    this.flames = info.nozzles.map(([nx, ny]) => {
      const f = new PIXI.Sprite(tex.flames[0]);
      f.anchor.set(0.5, 0.04);
      f.position.set((nx - 64) * SHIP_SCALE, (ny - 64) * SHIP_SCALE);
      f.sx = SHIP_SCALE * 1.15 * info.flameW;
      f.sy = SHIP_SCALE * 1.15;
      this.body.addChild(f);
      return f;
    });
    this.hull = new PIXI.Sprite(tex[info.tex]);
    this.hull.anchor.set(0.5);
    this.hull.scale.set(SHIP_SCALE);
    this.flash = new PIXI.Sprite(tex.flash[info.tex]);
    this.flash.anchor.set(0.5);
    this.flash.scale.set(SHIP_SCALE);
    this.flash.alpha = 0;
    this.body.addChild(this.hull, this.flash);

    this.shield = new PIXI.Sprite(tex.shield);
    this.shield.anchor.set(0.5);
    this.shield.scale.set((C.SHIP_DRAW_SIZE * 1.3) / 128);
    this.shield.visible = false;
    this.root.addChild(this.body, this.shield);

    this.label = new PIXI.Container();
    this.barBg = new PIXI.Sprite(PIXI.Texture.WHITE);
    this.barBg.anchor.set(0.5);
    this.barBg.width = 48; this.barBg.height = 7;
    this.barBg.tint = 0x0a0e18;
    this.barBg.alpha = 0.85;
    this.barFill = new PIXI.Sprite(PIXI.Texture.WHITE);
    this.barFill.anchor.set(0, 0.5);
    this.barFill.height = 4;
    this.barFill.x = -22.5;
    this.name = new PIXI.Text({ text: '', style: NAME_STYLE });
    this.name.anchor.set(0.5, 0);
    this.name.style.fill = isMe ? 0xffffff : isBot ? 0xff9b90 : lighten(info.color, 0.45);
    this.label.addChild(this.barBg, this.barFill, this.name);

    this.lastHp = -1;
    this.flameT = Math.random() * 10;
    this.smokeAcc = 0;
    this.seen = 0;
    scene.shipLayer.addChild(this.root);
    scene.labelLayer.addChild(this.label);
  }

  update(scene, dt, x, y, a, thrust, hp, flash, shield, name) {
    this.root.position.set(x, y);
    this.body.rotation = a + HALF_PI;
    this.flash.alpha = flash;

    // engine flame: 3-frame animation, long when thrusting, small idle flicker otherwise
    this.flameT += dt;
    const frame = scene.tex.flames[Math.floor(this.flameT * 18) % 3];
    const flick = 0.9 + Math.sin(this.flameT * 41) * 0.08;
    for (const f of this.flames) {
      f.texture = frame;
      f.scale.set(f.sx * (thrust ? 1 : 0.8), f.sy * (thrust ? flick : 0.35));
    }

    this.shield.visible = shield;
    if (shield) {
      this.shield.alpha = 0.75 + Math.sin(scene.time * 7) * 0.2;
      this.shield.rotation = 0;
    }

    if (hp !== this.lastHp) {
      this.lastHp = hp;
      const r = Math.max(0, Math.min(1, hp / C.MAX_HP));
      this.barFill.width = 45 * r;
      this.barFill.tint = r > 0.6 ? 0x4fd66b : r > 0.3 ? 0xffb02e : 0xff4d4d;
    }
    if (this.name.text !== name) this.name.text = name;

    // damaged ships trail smoke
    if (hp < 35) {
      this.smokeAcc += dt;
      if (this.smokeAcc > 0.11) {
        this.smokeAcc = 0;
        scene.spawnSmoke(x + (Math.random() - 0.5) * 16, y + (Math.random() - 0.5) * 16, 0.28 + Math.random() * 0.12, 0.8);
      }
    }

    // screen-space label
    const z = scene.zoom;
    const sx = (x - scene.camX) * z + scene.w / 2 + scene.shakeX;
    const sy = (y - scene.camY) * z + scene.h / 2 + scene.shakeY;
    const off = (C.SHIP_DRAW_SIZE / 2) * z;
    this.label.position.set(Math.round(sx), Math.round(sy));
    this.barBg.y = this.barFill.y = -off - 8;
    this.name.y = off + 2;
  }

  destroy() {
    this.root.destroy({ children: true });
    this.label.destroy({ children: true });
  }
}

export class Scene {
  constructor(app, tex, world) {
    this.app = app;
    this.tex = tex;
    this.world = world;
    this.time = 0;
    this.camX = C.WORLD_SIZE / 2;
    this.camY = C.WORLD_SIZE / 2;
    this.lookX = 0; this.lookY = 0;
    this.zoom = 1;
    this.w = app.screen.width;
    this.h = app.screen.height;
    this.shakeX = 0; this.shakeY = 0;

    this.bg = new Background(tex);
    this.worldLayer = new PIXI.Container();
    this.meteorLayer = new PIXI.Container();
    this.pickupLayer = new PIXI.Container();
    this.lowFxLayer = new PIXI.Container();   // smoke, debris
    this.bulletLayer = new PIXI.Container();
    this.shipLayer = new PIXI.Container();
    this.fxLayer = new PIXI.Container();      // explosions, impacts, muzzle flashes
    this.labelLayer = new PIXI.Container();   // screen space
    this.numberLayer = new PIXI.Container();  // screen space
    this.worldLayer.addChild(this.buildBorder(), this.meteorLayer, this.pickupLayer, this.lowFxLayer,
      this.bulletLayer, this.shipLayer, this.fxLayer);
    app.stage.addChild(this.bg.root, this.worldLayer, this.labelLayer, this.numberLayer);

    this.meteors = METEORS.map((m) => {
      const s = new PIXI.Sprite(tex.meteors[m.variant]);
      s.anchor.set(0.5);
      s.position.set(m.x, m.y);
      s.scale.set(m.r / METEOR_ART_R);
      s.rotation = m.rot;
      this.meteorLayer.addChild(s);
      return { s, m };
    });

    this.shipViews = new Map();
    this.bulletSprites = [];
    this.pickupViews = new Map();
    this.effects = [];
    this.spritePool = [];
    this.numbers = [];
    this.numberPool = [];
    this.meLastHp = -1;
    this.meFlash = 0;
    this.frame = 0;
    this.resize();
  }

  buildBorder() {
    const S = C.WORLD_SIZE, big = 6000;
    const g = new PIXI.Graphics();
    g.rect(-big, -big, S + big * 2, big).fill({ color: 0x000000, alpha: 0.45 });
    g.rect(-big, S, S + big * 2, big).fill({ color: 0x000000, alpha: 0.45 });
    g.rect(-big, 0, big, S).fill({ color: 0x000000, alpha: 0.45 });
    g.rect(S, 0, big, S).fill({ color: 0x000000, alpha: 0.45 });
    g.rect(0, 0, S, S).stroke({ width: 10, color: 0x0a0e18, alpha: 0.9 });
    g.rect(0, 0, S, S).stroke({ width: 4, color: 0xe0443c, alpha: 0.85 });
    return g;
  }

  resize() {
    this.w = this.app.screen.width;
    this.h = this.app.screen.height;
    // Zoom so the visible area always fits inside the server's interest area.
    this.zoom = Math.max(0.72, this.w / (2 * (C.AOI_HALF_W - 100)), this.h / (2 * (C.AOI_HALF_H - 100)));
    this.bg.resize(this.w, this.h);
  }

  // ---------------------------------------------------------------- effects API (called by World)

  acquire(texture, layer) {
    const s = this.spritePool.pop() || new PIXI.Sprite();
    s.texture = texture;
    s.anchor.set(0.5);
    s.alpha = 1;
    s.rotation = 0;
    s.scale.set(1);
    s.tint = 0xffffff;
    s.visible = true;
    layer.addChild(s);
    return s;
  }

  addEffect(e) {
    e.age = 0;
    e.vx = e.vx || 0; e.vy = e.vy || 0; e.spin = e.spin || 0; e.drag = e.drag || 0;
    this.effects.push(e);
  }

  muzzle(x, y, a, design, isBot) {
    const s = this.acquire(this.tex.muzzle, this.fxLayer);
    s.anchor.set(0.08, 0.5);
    s.position.set(x, y);
    s.rotation = a;
    s.scale.set(0.6);
    if (isBot) s.tint = 0xffc8b8;
    this.addEffect({ s, life: 0.07, scale0: 0.6, scale1: 0.75, fade: true });
  }

  impact(x, y, meteor) {
    const s = this.acquire(this.tex.impact, this.fxLayer);
    s.position.set(x, y);
    s.rotation = Math.random() * Math.PI;
    this.addEffect({ s, life: 0.13, scale0: 0.45, scale1: 0.75, fade: true });
    if (meteor) this.spawnSmoke(x, y, 0.32, 0.6, 0xd8c3a8);
  }

  spawnSmoke(x, y, scale, life, tint = 0xffffff) {
    const s = this.acquire(this.tex.smoke, this.lowFxLayer);
    s.position.set(x, y);
    s.tint = tint;
    this.addEffect({ s, life, scale0: scale * 0.7, scale1: scale * 1.4, fade: true, alpha0: 0.85,
      vx: (Math.random() - 0.5) * 20, vy: (Math.random() - 0.5) * 20 });
  }

  explosion(x, y, design, isBot) {
    const s = this.acquire(this.tex.explosion[0], this.fxLayer);
    s.position.set(x, y);
    const sc = 1.15 + Math.random() * 0.2;
    this.addEffect({ s, life: 0.5, frames: this.tex.explosion, scale0: sc, scale1: sc * 1.08, fadeFrom: 0.7 });
    for (let i = 0; i < 7; i++) {
      const d = this.acquire(this.tex.debris[i % 3], this.lowFxLayer);
      const ang = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 220;
      d.position.set(x, y);
      d.rotation = Math.random() * Math.PI * 2;
      const ds = 0.8 + Math.random() * 0.6;
      if (isBot && i % 3 === 2) d.tint = 0xffb3aa;
      this.addEffect({ s: d, life: 0.9 + Math.random() * 0.5, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
        spin: (Math.random() - 0.5) * 10, drag: 1.6, scale0: ds, scale1: ds, fadeFrom: 0.55 });
    }
    for (let i = 0; i < 3; i++) {
      this.spawnSmoke(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.5) * 40, 0.55 + Math.random() * 0.25, 1.2 + Math.random() * 0.4);
    }
  }

  pickupTaken(x, y) {
    const s = this.acquire(this.tex.impact, this.fxLayer);
    s.position.set(x, y);
    s.tint = 0x9be58a;
    this.addEffect({ s, life: 0.25, scale0: 0.5, scale1: 1.1, fade: true });
  }

  damageNumber(x, y, text, kind) {
    const t = this.numberPool.pop() || new PIXI.Text({ text: '', style: { ...NUMBER_STYLE } });
    t.text = text;
    t.style.fill = NUMBER_COLORS[kind] || 0xffffff;
    t.style.fontSize = kind === 'dealt' ? 20 : 18;
    t.anchor.set(0.5);
    t.alpha = 1;
    this.numberLayer.addChild(t);
    this.numbers.push({ t, x: x + (Math.random() - 0.5) * 14, y, age: 0, life: 0.85 });
  }

  // ---------------------------------------------------------------- per frame

  updateCamera(dt) {
    const w = this.world, M = w.me;
    let tx = this.camX, ty = this.camY, smooth = 4;
    if (w.joined && M && M.cur) {
      if (M.alive) {
        // Locked to our ship, plus a gentle look-ahead toward the mouse.
        const inp = w.input;
        const lx = inp.mouseMoved ? ((inp.mouseX - this.w / 2) / this.zoom) * 0.15 : 0;
        const ly = inp.mouseMoved ? ((inp.mouseY - this.h / 2) / this.zoom) * 0.15 : 0;
        const k = 1 - Math.exp(-dt * 5);
        this.lookX += (lx - this.lookX) * k;
        this.lookY += (ly - this.lookY) * k;
        this.camX = M.rx + this.lookX;
        this.camY = M.ry + this.lookY;
        return;
      }
      tx = M.deadX; ty = M.deadY; smooth = 2;
    } else {
      const f = w.ships.get(w.focusId);
      if (f && f.visible) { tx = f.x; ty = f.y; }
    }
    if (Math.hypot(tx - this.camX, ty - this.camY) > 1500) { this.camX = tx; this.camY = ty; return; }
    const k = 1 - Math.exp(-dt * smooth);
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;
  }

  onScreen(x, y, margin) {
    return Math.abs(x - this.camX) * this.zoom < this.w / 2 + margin && Math.abs(y - this.camY) * this.zoom < this.h / 2 + margin;
  }

  update(dt) {
    this.time += dt;
    this.frame++;
    if (this.w !== this.app.screen.width || this.h !== this.app.screen.height) this.resize();
    const w = this.world;

    this.updateCamera(dt);
    const v = w.view;
    v.camX = this.camX; v.camY = this.camY; v.scale = this.zoom; v.w = this.w; v.h = this.h;

    const sh = w.shake;
    this.shakeX = sh ? (Math.random() - 0.5) * 2 * sh : 0;
    this.shakeY = sh ? (Math.random() - 0.5) * 2 * sh : 0;

    this.bg.update(this.camX, this.camY, this.zoom, this.w, this.h);
    this.worldLayer.scale.set(this.zoom);
    this.worldLayer.position.set(this.w / 2 - this.camX * this.zoom + this.shakeX, this.h / 2 - this.camY * this.zoom + this.shakeY);

    for (const { s, m } of this.meteors) {
      s.visible = this.onScreen(m.x, m.y, m.r * 2 * this.zoom);
      if (s.visible) s.rotation = m.rot + m.spin * this.time;
    }

    this.syncShips(dt);
    this.syncBullets();
    this.syncPickups();
    this.updateEffects(dt);
    this.updateNumbers(dt);
  }

  syncShips(dt) {
    const w = this.world, frame = this.frame, now = performance.now();
    const view = (key, design, isBot, isMe) => {
      let sv = this.shipViews.get(key);
      if (!sv) { sv = new ShipView(this, design, isBot, isMe); this.shipViews.set(key, sv); }
      sv.seen = frame;
      return sv;
    };

    for (const s of w.ships.values()) {
      if (!s.visible || !this.onScreen(s.x, s.y, 150)) continue;
      const sv = view(s.id, s.design, s.isBot, false);
      sv.update(this, dt, s.x, s.y, s.a, (s.f & FLAG.THRUST) !== 0, s.hp, s.flash, (s.f & FLAG.SHIELD) !== 0, w.names.get(s.id) || '');
    }

    const M = w.me;
    if (w.joined && M && M.alive) {
      if (this.meLastHp >= 0 && M.hp < this.meLastHp) this.meFlash = 1;
      this.meLastHp = M.hp;
      this.meFlash = Math.max(0, this.meFlash - dt * 7);
      const shield = M.shieldMs > 0 && now - M.recvAt < M.shieldMs;
      const sv = view('me' + M.design, M.design, false, true);
      sv.update(this, dt, M.rx, M.ry, M.ra, (M.buttons & BTN.MOVE_MASK) !== 0, M.hp, this.meFlash, shield, w.myName);
    } else {
      this.meLastHp = -1;
    }

    for (const [key, sv] of this.shipViews) {
      if (sv.seen !== frame) { sv.destroy(); this.shipViews.delete(key); }
    }
  }

  syncBullets() {
    const w = this.world;
    let i = 0;
    const place = (x, y, vx, vy, style) => {
      let s = this.bulletSprites[i];
      if (!s) {
        s = new PIXI.Sprite();
        s.anchor.set(0.75, 0.5);
        s.scale.set(0.72);
        this.bulletLayer.addChild(s);
        this.bulletSprites.push(s);
      }
      s.texture = this.tex[BULLET_STYLES[style]];
      s.position.set(x, y);
      s.rotation = Math.atan2(vy, vx);
      s.visible = true;
      i++;
    };
    for (const b of w.bullets) if (b.visible && this.onScreen(b.x, b.y, 60)) place(b.x, b.y, b.vx, b.vy, b.style);
    const myStyle = w.me ? w.me.design : 0;
    for (const b of w.localBullets) if (!b.dead && this.onScreen(b.x, b.y, 60)) place(b.x, b.y, b.vx, b.vy, myStyle);
    for (let k = i; k < this.bulletSprites.length; k++) this.bulletSprites[k].visible = false;
  }

  syncPickups() {
    const seen = new Set();
    for (const p of this.world.pickups) {
      seen.add(p.id);
      let s = this.pickupViews.get(p.id);
      if (!s) {
        s = new PIXI.Sprite(this.tex.pickup);
        s.anchor.set(0.5);
        s.phase = Math.random() * 6;
        this.pickupLayer.addChild(s);
        this.pickupViews.set(p.id, s);
      }
      s.position.set(p.x, p.y + Math.sin(this.time * 2.4 + s.phase) * 4);
      s.scale.set(0.66 * (1 + Math.sin(this.time * 3.1 + s.phase) * 0.04));
      s.rotation = Math.sin(this.time * 1.7 + s.phase) * 0.12;
    }
    for (const [id, s] of this.pickupViews) {
      if (!seen.has(id)) { s.destroy(); this.pickupViews.delete(id); }
    }
  }

  updateEffects(dt) {
    const E = this.effects;
    for (let i = E.length - 1; i >= 0; i--) {
      const e = E[i];
      e.age += dt;
      const p = e.age / e.life;
      if (p >= 1) {
        e.s.parent && e.s.parent.removeChild(e.s);
        this.spritePool.push(e.s);
        E[i] = E[E.length - 1];
        E.pop();
        continue;
      }
      const s = e.s;
      if (e.vx || e.vy) {
        s.x += e.vx * dt; s.y += e.vy * dt;
        if (e.drag) { const d = 1 - e.drag * dt; e.vx *= d; e.vy *= d; }
      }
      if (e.spin) s.rotation += e.spin * dt;
      if (e.frames) s.texture = e.frames[Math.min(e.frames.length - 1, Math.floor(p * e.frames.length))];
      if (e.scale0 !== undefined) s.scale.set(e.scale0 + (e.scale1 - e.scale0) * p);
      const a0 = e.alpha0 === undefined ? 1 : e.alpha0;
      if (e.fade) s.alpha = a0 * (1 - p);
      else if (e.fadeFrom !== undefined) s.alpha = p < e.fadeFrom ? a0 : a0 * (1 - (p - e.fadeFrom) / (1 - e.fadeFrom));
    }
  }

  updateNumbers(dt) {
    const N = this.numbers;
    for (let i = N.length - 1; i >= 0; i--) {
      const n = N[i];
      n.age += dt;
      const p = n.age / n.life;
      if (p >= 1) {
        this.numberLayer.removeChild(n.t);
        this.numberPool.push(n.t);
        N[i] = N[N.length - 1];
        N.pop();
        continue;
      }
      n.y -= 55 * dt;
      const sx = (n.x - this.camX) * this.zoom + this.w / 2;
      const sy = (n.y - this.camY) * this.zoom + this.h / 2;
      n.t.position.set(Math.round(sx), Math.round(sy));
      n.t.scale.set(p < 0.15 ? 0.7 + (p / 0.15) * 0.5 : 1.2 - Math.min(0.2, (p - 0.15) * 0.5));
      n.t.alpha = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
    }
  }
}
