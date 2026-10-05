'use strict';

/**
 * Binary wire format (server -> client snapshots).
 *
 * Every snapshot is a single binary WebSocket frame built with fixed-size,
 * little-endian records. A remote ship is 12 bytes:
 *
 *     u32 id | u16 x | u16 y | u16 angle | u8 hp | u8 flags
 *
 * versus ~22 bytes as a JSON number list or ~80 bytes as a JSON object.
 *
 * Each ship / bullet / event / pickup record is encoded ONCE per tick into a
 * shared buffer. Building a player's snapshot is then just copying the records
 * that are inside that player's area of interest, so encoding cost does not
 * grow with the number of viewers.
 */

const { C, BIN, FLAG, wrapAngle } = require('../shared/shared');

const POS = BIN.POS_SCALE;
const ANGLE_K = 65535 / (Math.PI * 2);

function qpos(v) {
  v = Math.round(v * POS);
  return v < 0 ? 0 : v > 65535 ? 65535 : v;
}
function qangle(a) {
  return Math.round((wrapAngle(a) + Math.PI) * ANGLE_K) & 0xffff;
}
function clampU16(v) {
  v = Math.round(v);
  return v < 0 ? 0 : v > 65535 ? 65535 : v;
}

/** Ship flags byte: thrust/shield/bot bits + design index. */
function shipFlags(ship, now) {
  let f = ship.design << FLAG.DESIGN_SHIFT;
  if (ship.thrust) f |= FLAG.THRUST;
  if (now < ship.invulnUntil) f |= FLAG.SHIELD;
  if (ship.isBot) f |= FLAG.BOT;
  return f;
}

function writeShip(buf, o, ship, now) {
  buf.writeUInt32LE(ship.id, o);
  buf.writeUInt16LE(qpos(ship.x), o + 4);
  buf.writeUInt16LE(qpos(ship.y), o + 6);
  buf.writeUInt16LE(qangle(ship.a), o + 8);
  buf[o + 10] = Math.ceil(ship.hp);
  buf[o + 11] = shipFlags(ship, now);
}

/** Full-precision state of a player's own ship (f64 = bit-exact reconciliation). */
function writeSelf(buf, o, ship, now) {
  buf.writeDoubleLE(ship.x, o);
  buf.writeDoubleLE(ship.y, o + 8);
  buf.writeDoubleLE(ship.vx, o + 16);
  buf.writeDoubleLE(ship.vy, o + 24);
  buf.writeDoubleLE(ship.a, o + 32);
  buf.writeDoubleLE(ship.cd, o + 40);
  buf[o + 48] = Math.ceil(ship.hp);
  buf[o + 49] = ship.alive ? 1 : 0;
  buf.writeUInt16LE(clampU16(ship.respawnAt - now), o + 50);
  buf.writeUInt16LE(clampU16(ship.invulnUntil - now), o + 52);
  buf.writeUInt16LE(clampU16(ship.kills), o + 54);
  buf.writeUInt16LE(clampU16(ship.deaths), o + 56);
  buf[o + 58] = ship.design;
}

/** Bullet spawn (sent once; the client simulates the flight). */
function writeBullet(buf, o, b) {
  buf.writeUInt32LE(b.id, o);
  buf.writeUInt16LE(qpos(b.x), o + 4);
  buf.writeUInt16LE(qpos(b.y), o + 6);
  buf.writeInt16LE(Math.round(b.vx), o + 8);
  buf.writeInt16LE(Math.round(b.vy), o + 10);
  buf.writeUInt32LE(b.ownerId, o + 12);
  buf.writeUInt16LE(b.seq & 0xffff, o + 16);
  buf[o + 18] = b.style;
}

function writeEvent(buf, o, e) {
  buf[o] = e.type;
  buf.writeUInt32LE(e.a >>> 0, o + 1);
  buf.writeUInt32LE(e.b >>> 0, o + 5);
  buf.writeUInt16LE(qpos(e.x), o + 9);
  buf.writeUInt16LE(qpos(e.y), o + 11);
  buf[o + 13] = Math.min(255, Math.max(0, Math.round(e.value || 0)));
}

function writePickup(buf, o, p) {
  buf.writeUInt32LE(p.id, o);
  buf.writeUInt16LE(qpos(p.x), o + 4);
  buf.writeUInt16LE(qpos(p.y), o + 6);
}

/** Byte-wise copy; for 8-20 byte records this beats Buffer#copy's call overhead. */
function copyBytes(src, srcOff, dst, dstOff, n) {
  for (let i = 0; i < n; i++) dst[dstOff + i] = src[srcOff + i];
}

/**
 * Stats section (built once per second, copied into every snapshot that tick):
 * u16 players, u16 bots, u16 spectators, f32 tickAvg, f32 tickMax, f32 sim,
 * f32 interest, f32 send, u32 bytesPerPlayer, u16 rank*, u16 rankTotal,
 * u8 count, then per entry: u32 id, u16 kills, u16 deaths, u8 flags, u8 len, name.
 * (*rank is patched per viewer at BIN.STATS_RANK_OFFSET)
 */
function encodeStats(s, top, rankTotal) {
  const names = top.map((t) => Buffer.from(t.name, 'latin1'));
  let size = 35;
  for (const n of names) size += 10 + n.length;
  const buf = Buffer.alloc(size);
  let o = 0;
  o = buf.writeUInt16LE(Math.min(65535, s.players), o);
  o = buf.writeUInt16LE(Math.min(65535, s.bots), o);
  o = buf.writeUInt16LE(Math.min(65535, s.spectators), o);
  o = buf.writeFloatLE(s.tickAvg, o);
  o = buf.writeFloatLE(s.tickMax, o);
  o = buf.writeFloatLE(s.sim, o);
  o = buf.writeFloatLE(s.aoi, o);
  o = buf.writeFloatLE(s.send, o);
  o = buf.writeUInt32LE(Math.round(s.bytesPerPlayer), o);
  o = buf.writeUInt16LE(0, o); // rank placeholder (offset 30)
  o = buf.writeUInt16LE(Math.min(65535, rankTotal), o);
  buf[o++] = top.length;
  top.forEach((t, i) => {
    o = buf.writeUInt32LE(t.id, o);
    o = buf.writeUInt16LE(clampU16(t.kills), o);
    o = buf.writeUInt16LE(clampU16(t.deaths), o);
    buf[o++] = (t.isBot ? 1 : 0) | (t.design << 1);
    buf[o++] = names[i].length;
    names[i].copy(buf, o);
    o += names[i].length;
  });
  return buf;
}

/** Kill feed section: u8 count, then per kill: killer (u32 id, u8 flags, name), victim (same). */
function encodeKillfeed(entries) {
  const parts = [];
  let size = 1;
  for (const k of entries) {
    const kn = Buffer.from(k.killerName, 'latin1'), vn = Buffer.from(k.victimName, 'latin1');
    parts.push([k, kn, vn]);
    size += 12 + kn.length + vn.length;
  }
  const buf = Buffer.alloc(size);
  let o = 0;
  buf[o++] = Math.min(255, entries.length);
  for (const [k, kn, vn] of parts.slice(0, 255)) {
    o = buf.writeUInt32LE(k.killerId, o);
    buf[o++] = k.killerFlags;
    buf[o++] = kn.length;
    kn.copy(buf, o); o += kn.length;
    o = buf.writeUInt32LE(k.victimId, o);
    buf[o++] = k.victimFlags;
    buf[o++] = vn.length;
    vn.copy(buf, o); o += vn.length;
  }
  return buf;
}

/** Only letters, digits, space and a few symbols; max 16 chars. */
function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^A-Za-z0-9 _\-.]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}

/**
 * Validate an input message:
 *   [1, firstSeq, viewTimeMs, buttons0, aim0, buttons1, aim1, ..., ([muzzleX, muzzleY])]
 * Returns [{seq, b, aim, view, origin}] (one per input step) or null if malformed.
 */
function parseInputs(msg) {
  let len = msg.length;
  let origin = null;
  const last = msg[len - 1];
  if (Array.isArray(last)) {
    if (last.length === 2 && Number.isFinite(last[0]) && Number.isFinite(last[1])) origin = last;
    len--;
  }
  const n = (len - 3) / 2;
  if (!Number.isInteger(n) || n < 1 || n > 4) return null;
  const seq = msg[1];
  const view = msg[2];
  if (!Number.isInteger(seq) || seq < 1 || typeof view !== 'number' || !Number.isFinite(view)) return null;
  const inputs = [];
  for (let i = 0; i < n; i++) {
    const b = msg[3 + i * 2];
    let aim = msg[4 + i * 2];
    if (!Number.isInteger(b)) return null;
    if (typeof aim !== 'number' || !Number.isFinite(aim)) aim = 0;
    if (aim > Math.PI) aim = Math.PI; else if (aim < -Math.PI) aim = -Math.PI;
    inputs.push({ seq: seq + i, b: b & 31, aim, view, origin });
  }
  return inputs;
}

module.exports = {
  C, writeShip, writeSelf, writeBullet, writeEvent, writePickup, copyBytes,
  encodeStats, encodeKillfeed, sanitizeName, parseInputs,
};
