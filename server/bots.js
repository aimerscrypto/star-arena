'use strict';

/**
 * Server-side AI pilots.
 *
 * Bots produce the same {buttons, aim} input a human client sends and go
 * through the same stepShip() physics, weapon cooldown and damage code.
 *
 * They are deliberately beatable:
 *  - REACTION DELAY: a bot aims at where its target was 300-500 ms ago (read
 *    from the server's position history), so dodging works.
 *  - AIM SPREAD + slower fire rate + lower damage than players.
 *  - PERSONALITIES: only "hunters" go after human players (max 2 per human).
 *    "Brawlers" fight other bots, "wanderers" cruise around and only fight back.
 */

const { C, BTN, wrapAngle, meteorsAt } = require('../shared/shared');

const BOT_NAMES = [
  'Vega', 'Orion', 'Nyx', 'Kestrel', 'Raptor', 'Halcyon', 'Vortex', 'Specter', 'Talon', 'Nova',
  'Corsair', 'Wraith', 'Cinder', 'Rook', 'Jackal', 'Mako', 'Zenith', 'Quasar', 'Banshee', 'Viper',
  'Havoc', 'Eclipse', 'Ronin', 'Phantom', 'Striker', 'Sable', 'Comet', 'Drifter', 'Lancer', 'Onyx',
];

const AGGRO_RANGE = 850;
const MAX_HUNTERS_PER_PLAYER = 2;
const FIRE_RANGE = 700;
const scratch = [];
const tmp = { x: 0, y: 0 };
const tmp2 = { x: 0, y: 0 };

function botName(i) {
  return BOT_NAMES[i % BOT_NAMES.length] + '-' + (10 + ((i * 37) % 90));
}

function createBrain() {
  const r = Math.random();
  return {
    personality: r < 0.35 ? 'hunter' : r < 0.75 ? 'brawler' : 'wanderer',
    reactionMs: 300 + Math.random() * 200,
    targetId: 0,
    acquiredAt: 0,
    nextThink: 0,
    nextShotAt: 0,
    wx: Math.random() * C.WORLD_SIZE,
    wy: Math.random() * C.WORLD_SIZE,
    waypointUntil: 0,
    strafe: Math.random() < 0.5 ? 1 : -1,
    strafeUntil: 0,
    aimNoise: 0,
    lastAttackerId: 0,
    lastAttackedAt: -1e9,
  };
}

/** Send a bot toward a point. */
function setWaypoint(bot, x, y, now) {
  const br = bot.brain;
  br.wx = Math.max(300, Math.min(C.WORLD_SIZE - 300, x));
  br.wy = Math.max(300, Math.min(C.WORLD_SIZE - 300, y));
  br.waypointUntil = now + 12000;
}

/** Called by the game when a bot takes damage: it may turn on its attacker. */
function onDamaged(bot, attackerId, now) {
  bot.brain.lastAttackerId = attackerId;
  bot.brain.lastAttackedAt = now;
}

function canTarget(bot, s, now) {
  const br = bot.brain;
  if (s === bot || !s.alive || now < s.invulnUntil) return false;
  const retaliating = s.id === br.lastAttackerId && now - br.lastAttackedAt < 6000;
  if (retaliating) return true;
  if (!s.isBot) {
    if (br.personality !== 'hunter') return false;
    return s.attackers < MAX_HUNTERS_PER_PLAYER || br.targetId === s.id;
  }
  return br.personality !== 'wanderer';
}

function pickTarget(game, bot, now) {
  scratch.length = 0;
  game.shipGrid.query(bot.x - AGGRO_RANGE, bot.y - AGGRO_RANGE, bot.x + AGGRO_RANGE, bot.y + AGGRO_RANGE, scratch);
  let best = null, bestScore = Infinity;
  for (let i = 0; i < scratch.length; i++) {
    const s = scratch[i];
    if (!canTarget(bot, s, now)) continue;
    const dx = s.x - bot.x, dy = s.y - bot.y;
    let score = Math.sqrt(dx * dx + dy * dy);
    if (s.id === bot.brain.lastAttackerId) score *= 0.5;
    if (s.id === bot.brain.targetId) score *= 0.8; // stickiness
    if (score < bestScore) { bestScore = score; best = s; }
  }
  return best;
}

function newWaypoint(game, bot, now) {
  const players = game.alivePlayers;
  const ang = Math.random() * Math.PI * 2, d = 300 + Math.random() * 600;
  if (bot.brain.personality === 'hunter' && players.length > 0 && Math.random() < 0.6) {
    // Hunters drift toward humans.
    const p = players[(Math.random() * players.length) | 0];
    setWaypoint(bot, p.x + Math.cos(ang) * d, p.y + Math.sin(ang) * d, now);
  } else if (Math.random() < 0.55) {
    // Others drift toward other bots, so dogfights break out around the map.
    const other = game.bots[(Math.random() * game.bots.length) | 0];
    if (other !== bot && other.alive) setWaypoint(bot, other.x + Math.cos(ang) * d, other.y + Math.sin(ang) * d, now);
    else setWaypoint(bot, 400 + Math.random() * (C.WORLD_SIZE - 800), 400 + Math.random() * (C.WORLD_SIZE - 800), now);
  } else {
    setWaypoint(bot, 400 + Math.random() * (C.WORLD_SIZE - 800), 400 + Math.random() * (C.WORLD_SIZE - 800), now);
  }
}

function toButtons(mx, my) {
  const len = Math.sqrt(mx * mx + my * my);
  if (len < 1e-3) return 0;
  const t = 0.38 * len;
  let b = 0;
  if (mx > t) b |= BTN.RIGHT; else if (mx < -t) b |= BTN.LEFT;
  if (my > t) b |= BTN.DOWN; else if (my < -t) b |= BTN.UP;
  return b;
}

/** Decide this tick's input for a bot. Returns {buttons, aim}. */
function think(game, bot, now) {
  const br = bot.brain;

  if (now >= br.nextThink) {
    br.nextThink = now + 400 + Math.random() * 400;
    const t = pickTarget(game, bot, now);
    const id = t ? t.id : 0;
    if (id !== br.targetId) br.acquiredAt = now; // new target: wait a reaction time before shooting
    br.targetId = id;
    br.aimNoise = (Math.random() - 0.5) * 0.3;
  }

  let target = br.targetId ? game.ships.get(br.targetId) : null;
  if (target && (!target.alive || now < target.invulnUntil)) { target = null; br.targetId = 0; }

  let mx = 0, my = 0, aim = bot.a, fire = false;

  if (target) {
    // Perceive the target with a reaction delay.
    const seen = game.posAt(target, now - br.reactionMs, tmp) ? tmp : target;
    const before = game.posAt(target, now - br.reactionMs - C.TICK_MS, tmp2) ? tmp2 : seen;
    const svx = (seen.x - before.x) / C.TICK_DT, svy = (seen.y - before.y) / C.TICK_DT;

    const dx = seen.x - bot.x, dy = seen.y - bot.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / dist, ny = dy / dist;

    const tt = (dist / C.BULLET_SPEED) * 0.7; // imperfect lead
    aim = Math.atan2(seen.y + svy * tt - bot.y, seen.x + svx * tt - bot.x) + br.aimNoise;

    if (now > br.strafeUntil) {
      br.strafe = -br.strafe;
      br.strafeUntil = now + 1200 + Math.random() * 1800;
    }

    if (bot.hp < 35) {                                // retreat when hurt
      mx = -nx - ny * br.strafe * 0.6; my = -ny + nx * br.strafe * 0.6;
    } else if (dist > 520) {                          // close in
      mx = nx; my = ny;
    } else if (dist < 280) {                          // back off while circling
      mx = -nx - ny * br.strafe; my = -ny + nx * br.strafe;
    } else {                                          // orbit / strafe
      mx = -ny * br.strafe + nx * 0.15; my = nx * br.strafe + ny * 0.15;
    }

    fire = dist < FIRE_RANGE &&
      now >= br.acquiredAt + br.reactionMs &&
      now >= br.nextShotAt &&
      Math.abs(wrapAngle(aim - bot.a)) < 0.3;
  } else {
    const dx = br.wx - bot.x, dy = br.wy - bot.y;
    if (dx * dx + dy * dy < 250 * 250 || now > br.waypointUntil) newWaypoint(game, bot, now);
    mx = dx; my = dy;
    aim = Math.atan2(dy, dx);
  }

  const mlen = Math.sqrt(mx * mx + my * my) || 1;
  mx /= mlen; my /= mlen;

  // Steer around meteors.
  const near = meteorsAt(bot.x, bot.y);
  for (let i = 0; i < near.length; i++) {
    const m = near[i];
    const ox = bot.x - m.x, oy = bot.y - m.y;
    const d = Math.sqrt(ox * ox + oy * oy) || 1;
    const clear = d - m.r - C.SHIP_RADIUS;
    if (clear < 140) {
      const push = (140 - clear) / 140 * 1.6;
      mx += (ox / d) * push; my += (oy / d) * push;
    }
  }

  // Keep away from the world edge.
  const edge = 350, W = C.WORLD_SIZE;
  if (bot.x < edge) mx += 1.5; else if (bot.x > W - edge) mx -= 1.5;
  if (bot.y < edge) my += 1.5; else if (bot.y > W - edge) my -= 1.5;

  return { buttons: toButtons(mx, my) | (fire ? BTN.FIRE : 0), aim: wrapAngle(aim) };
}

/** Called after a bot actually fired: slower fire rate than players (much slower vs humans), plus fresh aim spread. */
function onFired(bot, now, targetIsHuman) {
  bot.brain.nextShotAt = now + (targetIsHuman ? 600 + Math.random() * 450 : 300 + Math.random() * 300);
  bot.brain.aimNoise = (Math.random() - 0.5) * 0.3;
}

module.exports = { botName, createBrain, think, setWaypoint, onDamaged, onFired };
