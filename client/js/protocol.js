// Binary snapshot decoder. Mirrors server/protocol.js + server/interest.js.
const { BIN } = window.Shared;

const POS = 1 / BIN.POS_SCALE;
const ANG = (Math.PI * 2) / 65535;
const latin1 = new TextDecoder('latin1');

export function decodeSnapshot(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let o = 1; // byte 0 = message type
  const flags = u8[o++];
  const snap = {
    tick: dv.getUint32(o, true),
    ack: dv.getUint32(o + 4, true),
    focusId: dv.getUint32(o + 8, true),
    stats: null, self: null, ships: [], names: [], bullets: [], events: [], pickups: [], kills: null,
  };
  o += 12;
  const str = (len) => { const s = latin1.decode(u8.subarray(o, o + len)); o += len; return s; };

  if (flags & BIN.F_STATS) {
    const s = {
      players: dv.getUint16(o, true), bots: dv.getUint16(o + 2, true), spectators: dv.getUint16(o + 4, true),
      tickAvg: dv.getFloat32(o + 6, true), tickMax: dv.getFloat32(o + 10, true),
      sim: dv.getFloat32(o + 14, true), aoi: dv.getFloat32(o + 18, true), send: dv.getFloat32(o + 22, true),
      bytesPerPlayer: dv.getUint32(o + 26, true),
      rank: dv.getUint16(o + 30, true), rankTotal: dv.getUint16(o + 32, true),
      top: [],
    };
    const n = u8[o + 34];
    o += 35;
    for (let i = 0; i < n; i++) {
      const id = dv.getUint32(o, true), kills = dv.getUint16(o + 4, true), deaths = dv.getUint16(o + 6, true), f = u8[o + 8];
      const len = u8[o + 9];
      o += 10;
      s.top.push({ id, kills, deaths, isBot: (f & 1) === 1, design: f >> 1, name: str(len) });
    }
    snap.stats = s;
  }

  if (flags & BIN.F_SELF) {
    snap.self = {
      x: dv.getFloat64(o, true), y: dv.getFloat64(o + 8, true),
      vx: dv.getFloat64(o + 16, true), vy: dv.getFloat64(o + 24, true),
      a: dv.getFloat64(o + 32, true), cd: dv.getFloat64(o + 40, true),
      hp: u8[o + 48], alive: u8[o + 49] === 1,
      respawnMs: dv.getUint16(o + 50, true), shieldMs: dv.getUint16(o + 52, true),
      kills: dv.getUint16(o + 54, true), deaths: dv.getUint16(o + 56, true), design: u8[o + 58],
    };
    o += BIN.SELF_REC;
  }

  let n = dv.getUint16(o, true); o += 2;
  for (let i = 0; i < n; i++, o += BIN.SHIP_REC) {
    snap.ships.push({
      id: dv.getUint32(o, true),
      x: dv.getUint16(o + 4, true) * POS, y: dv.getUint16(o + 6, true) * POS,
      a: dv.getUint16(o + 8, true) * ANG - Math.PI,
      hp: u8[o + 10], flags: u8[o + 11],
    });
  }

  n = dv.getUint16(o, true); o += 2;
  for (let i = 0; i < n; i++) {
    const id = dv.getUint32(o, true), len = u8[o + 4];
    o += 5;
    snap.names.push({ id, name: str(len) });
  }

  n = dv.getUint16(o, true); o += 2;
  for (let i = 0; i < n; i++, o += BIN.BULLET_REC) {
    snap.bullets.push({
      id: dv.getUint32(o, true),
      x: dv.getUint16(o + 4, true) * POS, y: dv.getUint16(o + 6, true) * POS,
      vx: dv.getInt16(o + 8, true), vy: dv.getInt16(o + 10, true),
      owner: dv.getUint32(o + 12, true), seq: dv.getUint16(o + 16, true), style: u8[o + 18],
    });
  }

  n = dv.getUint16(o, true); o += 2;
  for (let i = 0; i < n; i++, o += BIN.EVENT_REC) {
    snap.events.push({
      type: u8[o], a: dv.getUint32(o + 1, true), b: dv.getUint32(o + 5, true),
      x: dv.getUint16(o + 9, true) * POS, y: dv.getUint16(o + 11, true) * POS, value: u8[o + 13],
    });
  }

  n = dv.getUint16(o, true); o += 2;
  for (let i = 0; i < n; i++, o += BIN.PICKUP_REC) {
    snap.pickups.push({ id: dv.getUint32(o, true), x: dv.getUint16(o + 4, true) * POS, y: dv.getUint16(o + 6, true) * POS });
  }

  if (flags & BIN.F_KILLFEED) {
    const k = u8[o++];
    snap.kills = [];
    for (let i = 0; i < k; i++) {
      const killerId = dv.getUint32(o, true), kf = u8[o + 4], kl = u8[o + 5];
      o += 6;
      const killerName = str(kl);
      const victimId = dv.getUint32(o, true), vf = u8[o + 4], vl = u8[o + 5];
      o += 6;
      const victimName = str(vl);
      snap.kills.push({
        killerId, killerName, killerBot: (kf & 1) === 1, killerDesign: kf >> 1,
        victimId, victimName, victimBot: (vf & 1) === 1, victimDesign: vf >> 1,
      });
    }
  }
  return snap;
}
