'use strict';

/**
 * INTEREST MANAGEMENT
 * ===================
 * The single most important function for scaling an MMO.
 *
 * A naive server sends every entity to every player: N players -> N^2 updates
 * per tick (1000 players = 1,000,000 ship updates, 20 times a second).
 *
 * Instead, each player gets a snapshot containing ONLY what is inside their
 * "area of interest" (AOI): a box around their ship slightly larger than their
 * screen. The spatial grid answers "who is in this box?" by touching only a few
 * cells, so per-player cost depends on how crowded their neighbourhood is, not
 * on how many players are online.
 *
 *      +-----------------------------------------------------------+
 *      |  world 8000 x 8000, grid of 500px cells                   |
 *      |              +-------------------+                        |
 *      |              |  AOI 2400 x 1600  |  <- only this is sent  |
 *      |              |       [you]       |                        |
 *      |              +-------------------+                        |
 *      +-----------------------------------------------------------+
 *
 * The snapshot itself is binary. Every record was already encoded once this
 * tick (see protocol.js / Game.encodeTick), so here we only select grid
 * indices and copy bytes; ship objects are never touched in the hot loop.
 */

const { C, BIN, S2C } = require('../shared/shared');
const { writeSelf, copyBytes } = require('./protocol');

let idxShips = new Int32Array(1024);
let idxEvents = new Int32Array(1024);
let idxPickups = new Int32Array(256);
const newNames = [];

function buildSnapshot(game, client) {
  const self = client.ship;
  const focus = self || game.ships.get(client.spectateId);
  const cx = focus ? focus.x : C.WORLD_SIZE / 2;
  const cy = focus ? focus.y : C.WORLD_SIZE / 2;

  // 1) Ships inside the AOI box: one grid query.
  const sg = game.shipGrid;
  if (idxShips.length < sg.count) idxShips = new Int32Array(sg.count * 2);
  const nFound = sg.queryIdx(cx - C.AOI_HALF_W, cy - C.AOI_HALF_H, cx + C.AOI_HALF_W, cy + C.AOI_HALF_H, idxShips);
  const alive = game.shipAlive, ids = game.shipIds, known = client.known;
  const selfGi = self ? self.gi : -1;
  let nShips = 0, namesBytes = 0;
  newNames.length = 0;
  for (let k = 0; k < nFound; k++) {
    const gi = idxShips[k];
    if (gi === selfGi || !alive[gi]) { idxShips[k] = -1; continue; } // (a ship can die after the grid was built)
    nShips++;
    const id = ids[gi];
    if (!known.has(id)) {
      // Names are sent once, the first time a ship enters this client's view.
      known.add(id);
      const s = sg.items[gi];
      newNames.push(s);
      namesBytes += 5 + s.nameBytes.length;
    }
  }

  // 2) This tick's bullet spawns + hits/deaths/pickups near the AOI: a second grid query.
  const eg = game.eventGrid;
  if (idxEvents.length < eg.count) idxEvents = new Int32Array(eg.count * 2);
  const mx = C.AOI_HALF_W + C.AOI_EVENT_MARGIN, my = C.AOI_HALF_H + C.AOI_EVENT_MARGIN;
  const nEv = eg.queryIdx(cx - mx, cy - my, cx + mx, cy + my, idxEvents);
  const evBullet = game.evBullet, evOff = game.evOff;
  let nBullets = 0;
  for (let k = 0; k < nEv; k++) nBullets += evBullet[idxEvents[k]];
  const nEvents = nEv - nBullets;

  // 3) Repair pickups in view.
  const pg = game.pickupGrid;
  if (idxPickups.length < pg.count) idxPickups = new Int32Array(pg.count * 2);
  const nPickups = pg.queryIdx(cx - C.AOI_HALF_W, cy - C.AOI_HALF_H, cx + C.AOI_HALF_W, cy + C.AOI_HALF_H, idxPickups);

  const stats = game.statsBuf;       // once per second, shared by everyone
  const killfeed = game.killfeedBuf; // only on ticks with kills, shared by everyone

  const size = BIN.HEADER +
    (stats ? stats.length : 0) +
    (self ? BIN.SELF_REC : 0) +
    2 + nShips * BIN.SHIP_REC +
    2 + namesBytes +
    2 + nBullets * BIN.BULLET_REC +
    2 + nEvents * BIN.EVENT_REC +
    2 + nPickups * BIN.PICKUP_REC +
    (killfeed ? killfeed.length : 0);

  const out = Buffer.allocUnsafe(size);
  let o = 0;
  out[o++] = S2C.SNAP;
  out[o++] = (self ? BIN.F_SELF : 0) | (stats ? BIN.F_STATS : 0) | (killfeed ? BIN.F_KILLFEED : 0);
  out.writeUInt32LE(game.tick, o); o += 4;
  out.writeUInt32LE(client.ackSeq >>> 0, o); o += 4;
  out.writeUInt32LE(focus ? focus.id : 0, o); o += 4;

  if (stats) {
    stats.copy(out, o);
    out.writeUInt16LE(self ? Math.min(65535, self.rank) : 0, o + BIN.STATS_RANK_OFFSET);
    o += stats.length;
  }
  if (self) { writeSelf(out, o, self, game.time); o += BIN.SELF_REC; }

  const shipRec = game.shipRec;
  out.writeUInt16LE(nShips, o); o += 2;
  for (let k = 0; k < nFound; k++) {
    const gi = idxShips[k];
    if (gi < 0) continue;
    copyBytes(shipRec, gi * BIN.SHIP_REC, out, o, BIN.SHIP_REC);
    o += BIN.SHIP_REC;
  }

  out.writeUInt16LE(newNames.length, o); o += 2;
  for (const s of newNames) {
    out.writeUInt32LE(s.id, o); o += 4;
    out[o++] = s.nameBytes.length;
    s.nameBytes.copy(out, o); o += s.nameBytes.length;
  }

  const evRec = game.eventRec;
  out.writeUInt16LE(nBullets, o); o += 2;
  for (let k = 0; k < nEv; k++) {
    const i = idxEvents[k];
    if (evBullet[i]) { copyBytes(evRec, evOff[i], out, o, BIN.BULLET_REC); o += BIN.BULLET_REC; }
  }
  out.writeUInt16LE(nEvents, o); o += 2;
  for (let k = 0; k < nEv; k++) {
    const i = idxEvents[k];
    if (!evBullet[i]) { copyBytes(evRec, evOff[i], out, o, BIN.EVENT_REC); o += BIN.EVENT_REC; }
  }

  const pRec = game.pickupRec;
  out.writeUInt16LE(nPickups, o); o += 2;
  for (let k = 0; k < nPickups; k++) { copyBytes(pRec, idxPickups[k] * BIN.PICKUP_REC, out, o, BIN.PICKUP_REC); o += BIN.PICKUP_REC; }

  if (killfeed) { killfeed.copy(out, o); o += killfeed.length; }
  return out;
}

module.exports = { buildSnapshot };
