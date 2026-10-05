// DOM HUD: server stats, leaderboard, kill feed, health panel, minimap, death overlay.

import { shipInfo, PLAYER_SHIPS, BULLET_STYLES } from './assets.js';

const { C, METEORS } = window.Shared;
const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function icon(src, cls) {
  const i = el('img', cls);
  i.src = src;
  i.alt = '';
  return i;
}
const shipIcon = (design, isBot) => `assets/${shipInfo(design, isBot).tex}.svg`;

export class Hud {
  constructor(world, net, sfx) {
    this.world = world;
    this.net = net;
    this.sfx = sfx;
    this.lastText = 0;
    this.fps = 0;
    this.frames = 0;
    this.fpsAt = performance.now();

    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.mm = $('minimap');
    this.mmCtx = this.mm.getContext('2d');
    this.mm.width = this.mm.height = 180 * dpr;
    this.mmCtx.scale(dpr, dpr);
    this.mmBase = this.buildMinimapBase(dpr);

    this.spark = $('sSpark');
    this.sparkCtx = this.spark.getContext('2d');
    this.spark.width = 228 * dpr;
    this.spark.height = 34 * dpr;
    this.sparkCtx.scale(dpr, dpr);

    let off = false;
    try { off = localStorage.getItem('sa_stats_off') === '1'; } catch (_) { /* storage unavailable */ }
    document.body.classList.toggle('stats-off', off);
    this.showMute();
  }

  toggleStats() {
    const off = document.body.classList.toggle('stats-off');
    try { localStorage.setItem('sa_stats_off', off ? '1' : '0'); } catch (_) { /* ignore */ }
  }

  showMute() {
    $('muteState').textContent = this.sfx.muted ? 'sound off' : 'sound on';
  }

  onJoined() {
    const w = this.world;
    $('pShip').src = shipIcon(w.myDesign, false);
    $('pName').textContent = w.myName;
    $('pName').style.color = PLAYER_SHIPS[w.myDesign].color;
  }

  // ---------------------------------------------------------------- events

  onStats() {
    const w = this.world, s = w.stats;
    $('liveCount').textContent = `${s.players} pilot${s.players === 1 ? '' : 's'} online · ${s.bots} bots in the arena`;

    const list = $('lbList');
    list.textContent = '';
    w.leaderboard.forEach((e, i) => {
      const li = el('li', (e.id === w.myId ? 'me ' : '') + (e.isBot ? 'bot' : ''));
      li.append(el('span', 'n', i + 1), icon(shipIcon(e.design, e.isBot)), el('span', 'name', e.name), el('span', 'k', e.kills));
      list.append(li);
    });
    const inTop = w.leaderboard.some((e) => e.id === w.myId);
    $('myRank').textContent = w.joined && w.rank && !inTop ? `You: #${w.rank} of ${w.rankTotal}` : '';
    $('kRank').textContent = w.joined && w.rank ? `#${w.rank}` : '-';

    const lb = $('leaderboard');
    $('killfeed').style.top = (lb.offsetTop + lb.offsetHeight + 12) + 'px';
    this.drawSparkline();
  }

  onKillfeed(kills) {
    const feed = $('killfeed'), myId = this.world.myId;
    for (const k of kills) {
      const row = el('div', 'kf' + (myId && (k.killerId === myId || k.victimId === myId) ? ' me' : ''));
      const nameEl = (id, name, isBot, design) => {
        const b = el('span', '', id === myId && myId ? 'You' : name);
        b.style.color = id === myId && myId ? '#ffb02e' : isBot ? '#ff9b90' : PLAYER_SHIPS[design % 4].color;
        return b;
      };
      const laser = `assets/${BULLET_STYLES[k.killerBot ? 4 : k.killerDesign % 4]}.svg`;
      row.append(nameEl(k.killerId, k.killerName, k.killerBot, k.killerDesign), icon(laser),
        nameEl(k.victimId, k.victimName, k.victimBot, k.victimDesign));
      feed.append(row);
      setTimeout(() => { row.style.opacity = '0'; }, 5500);
      setTimeout(() => row.remove(), 6200);
    }
    while (feed.children.length > 6) feed.firstChild.remove();
  }

  onDied(killerName, respawnMs) {
    $('killerName').textContent = killerName;
    $('respawnIn').textContent = Math.ceil(respawnMs / 1000);
    $('death').classList.remove('hidden');
  }

  // ---------------------------------------------------------------- per frame

  update(now) {
    this.frames++;
    if (now - this.fpsAt >= 1000) {
      this.fps = Math.round(this.frames * 1000 / (now - this.fpsAt));
      this.frames = 0;
      this.fpsAt = now;
    }
    const w = this.world, M = w.me;

    let vig = w.hurt * 0.8;
    if (w.joined && M && M.alive && M.hp < 30) vig = Math.max(vig, 0.3 + 0.2 * Math.sin(now / 170));
    $('vignette').style.opacity = vig.toFixed(2);

    const death = $('death');
    if (w.joined && M && !M.alive && M.recvAt) {
      const left = Math.max(0, M.respawnMs - (now - M.recvAt));
      $('respawnIn').textContent = Math.ceil(left / 1000);
      death.classList.remove('hidden');
    } else {
      death.classList.add('hidden');
    }

    this.drawMinimap();

    if (now - this.lastText < 100) return; // text at 10 Hz is plenty
    this.lastText = now;

    if (w.joined && M) {
      const r = Math.max(0, Math.min(1, M.hp / C.MAX_HP));
      const fill = $('hpFill');
      fill.style.width = (r * 100).toFixed(1) + '%';
      fill.style.backgroundColor = r > 0.6 ? '#4fd66b' : r > 0.3 ? '#ffb02e' : '#ff4d4d';
      $('hpText').textContent = Math.ceil(M.hp) + ' / ' + C.MAX_HP;
      $('kKills').textContent = M.kills;
      $('kDeaths').textContent = M.deaths;
      const shieldLeft = M.alive ? M.shieldMs - (now - M.recvAt) : 0;
      const chip = $('pShield');
      chip.classList.toggle('hidden', !(shieldLeft > 0));
      if (shieldLeft > 0) chip.textContent = `Shield ${(shieldLeft / 1000).toFixed(1)}s`;
    }

    const s = w.stats;
    $('sPing').textContent = this.net.open ? Math.round(this.net.ping) + ' ms' : 'offline';
    if (s) {
      $('sPlayers').textContent = s.players + (s.spectators ? ` (+${s.spectators} watching)` : '');
      $('sBots').textContent = s.bots;
      $('sTick').textContent = `${s.tickAvg.toFixed(2)} ms / 50 ms`;
      const pct = Math.min(100, (s.tickAvg / 50) * 100);
      const bar = $('sTickBar');
      bar.style.width = pct.toFixed(1) + '%';
      bar.style.background = pct < 50 ? '#4fd66b' : pct < 80 ? '#ffb02e' : '#ff4d4d';
      $('sBreak').textContent = `${s.sim.toFixed(2)} / ${s.aoi.toFixed(2)} / ${s.send.toFixed(2)} ms`;
      $('sBw').textContent = (s.bytesPerPlayer / 1024).toFixed(1) + ' KB/s';
    }
    $('sDown').textContent = (this.net.downRate / 1024).toFixed(1) + ' KB/s';
    $('sAoi').textContent = `${w.aoiShips} ships · ${w.bullets.length} bullets`;
    $('sSnap').textContent = this.net.snapRate + ' / s';
    $('sFps').textContent = this.fps;
  }

  drawSparkline() {
    const g = this.sparkCtx, hist = this.world.statsHistory, W = 228, H = 34;
    g.clearRect(0, 0, W, H);
    if (hist.length < 2) return;
    const max = Math.max(2, ...hist) * 1.2;
    g.fillStyle = 'rgba(79, 214, 107, 0.15)';
    g.strokeStyle = '#4fd66b';
    g.lineWidth = 1.5;
    g.beginPath();
    hist.forEach((v, i) => {
      const x = (i / 59) * W, y = H - 2 - (v / max) * (H - 4);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.stroke();
    g.lineTo(((hist.length - 1) / 59) * W, H);
    g.lineTo(0, H);
    g.fill();
    g.fillStyle = '#8a95aa';
    g.font = '600 10px "Exo 2", sans-serif';
    g.fillText('tick ms · last 60 s', 4, 11);
  }

  /** Static part of the minimap: background, spatial grid, meteors. Drawn once. */
  buildMinimapBase(dpr) {
    const S = 180, k = S / C.WORLD_SIZE;
    const c = document.createElement('canvas');
    c.width = c.height = S * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = 'rgba(6, 9, 18, 0.85)';
    g.fillRect(0, 0, S, S);
    const cells = C.WORLD_SIZE / C.GRID_CELL;
    g.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < cells; i++) {
      const p = Math.round(i * C.GRID_CELL * k) + 0.5;
      g.moveTo(p, 0); g.lineTo(p, S);
      g.moveTo(0, p); g.lineTo(S, p);
    }
    g.stroke();
    g.fillStyle = 'rgba(150, 128, 108, 0.55)';
    for (const m of METEORS) {
      g.beginPath();
      g.arc(m.x * k, m.y * k, Math.max(1, m.r * k), 0, Math.PI * 2);
      g.fill();
    }
    return c;
  }

  /**
   * Minimap: the whole world, the spatial grid and the server-side interest
   * area. Only ships the server actually sent us can appear on it.
   */
  drawMinimap() {
    const g = this.mmCtx, w = this.world, S = 180, k = S / C.WORLD_SIZE;
    g.clearRect(0, 0, S, S);
    g.drawImage(this.mmBase, 0, 0, S, S);

    const M = w.me;
    let cx, cy;
    if (w.joined && M && M.cur) { cx = M.alive ? M.rx : M.deadX; cy = M.alive ? M.ry : M.deadY; }
    else { const f = w.ships.get(w.focusId); if (f) { cx = f.x; cy = f.y; } }

    if (cx !== undefined) {
      const cells = C.WORLD_SIZE / C.GRID_CELL;
      const c0 = Math.max(0, Math.floor((cx - C.AOI_HALF_W) / C.GRID_CELL)), c1 = Math.min(cells - 1, Math.floor((cx + C.AOI_HALF_W) / C.GRID_CELL));
      const r0 = Math.max(0, Math.floor((cy - C.AOI_HALF_H) / C.GRID_CELL)), r1 = Math.min(cells - 1, Math.floor((cy + C.AOI_HALF_H) / C.GRID_CELL));
      g.fillStyle = 'rgba(255, 255, 255, 0.05)';
      g.fillRect(c0 * C.GRID_CELL * k, r0 * C.GRID_CELL * k, (c1 - c0 + 1) * C.GRID_CELL * k, (r1 - r0 + 1) * C.GRID_CELL * k);
      g.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      g.lineWidth = 1;
      g.strokeRect((cx - C.AOI_HALF_W) * k, (cy - C.AOI_HALF_H) * k, C.AOI_HALF_W * 2 * k, C.AOI_HALF_H * 2 * k);
    }

    g.fillStyle = '#7ee07a';
    for (const p of w.pickups) g.fillRect(p.x * k - 1, p.y * k - 1, 2, 2);
    for (const s of w.ships.values()) {
      if (!s.visible) continue;
      g.fillStyle = s.isBot ? '#ff5a4f' : PLAYER_SHIPS[s.design % 4].color;
      g.fillRect(s.x * k - 1.5, s.y * k - 1.5, 3, 3);
    }
    if (w.joined && M && M.alive) {
      g.save();
      g.translate(M.rx * k, M.ry * k);
      g.rotate(M.ra);
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#0a0e18';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(5, 0); g.lineTo(-3.5, -3.5); g.lineTo(-1.5, 0); g.lineTo(-3.5, 3.5); g.closePath();
      g.fill(); g.stroke();
      g.restore();
    }
    g.strokeStyle = 'rgba(224, 68, 60, 0.7)';
    g.strokeRect(0.5, 0.5, S - 1, S - 1);
  }
}
