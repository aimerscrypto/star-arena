#!/usr/bin/env node
'use strict';

/**
 * Load test: spawns N headless WebSocket clients that join the game and send
 * random inputs at the same rate as a real browser (20 msgs/s, 40 input steps/s).
 *
 *   node loadtest.js                 # 200 clients against ws://localhost:3000/ws
 *   node loadtest.js 500             # 500 clients
 *   node loadtest.js 300 wss://your-app.onrender.com/ws
 *
 * Prints once per second: connected clients, average messages and KB received
 * per client, and the server's own reported tick time (with breakdown).
 */

const WebSocket = require('ws');
const { BIN } = require('./shared/shared');

const N = Math.max(1, parseInt(process.argv[2], 10) || 200);
const URL = process.argv[3] || process.env.URL || 'ws://localhost:3000/ws';
const CONNECTS_PER_SEC = 100;   // ramp up instead of opening everything at once

const clients = [];
let connected = 0, failed = 0, closed = 0;
let msgsThisSec = 0, bytesThisSec = 0;
let lastServer = null;
let lastTick = 0;
const tickSamples = [];
const startedAt = Date.now();

/** Read just the header + stats section of a binary snapshot (stats come first). */
function readStats(buf) {
  if (buf.length < BIN.HEADER || buf[0] !== 1) return;
  lastTick = buf.readUInt32LE(2);
  if (!(buf[1] & BIN.F_STATS)) return;
  const o = BIN.HEADER;
  lastServer = {
    players: buf.readUInt16LE(o), bots: buf.readUInt16LE(o + 2),
    tickAvg: buf.readFloatLE(o + 6), tickMax: buf.readFloatLE(o + 10),
    sim: buf.readFloatLE(o + 14), aoi: buf.readFloatLE(o + 18), send: buf.readFloatLE(o + 22),
    bytesPerPlayer: buf.readUInt32LE(o + 26),
  };
}

function makeClient(i) {
  const c = { ws: new WebSocket(URL), open: false, seq: 1, buttons: 0, aim: Math.random() * 6.28 - 3.14, nextChange: 0 };
  c.ws.on('open', () => {
    c.open = true;
    connected++;
    c.ws.send(JSON.stringify([0, 'load-' + i, i % 4]));
  });
  c.ws.on('message', (data, isBinary) => {
    msgsThisSec++;
    bytesThisSec += data.length;
    if (isBinary && i === 0) readStats(data); // one client is enough to read the server's stats
    else if (isBinary && !lastTick) lastTick = data.readUInt32LE(2);
  });
  c.ws.on('error', () => { if (!c.open) failed++; });
  c.ws.on('close', () => { if (c.open) { connected--; closed++; } c.open = false; });
  clients.push(c);
}

// Ramp up connections.
let spawned = 0;
const ramp = setInterval(() => {
  const batch = Math.ceil(CONNECTS_PER_SEC / 10);
  for (let k = 0; k < batch && spawned < N; k++) makeClient(spawned++);
  if (spawned >= N) clearInterval(ramp);
}, 100);

// Every 50ms each client sends one message with 2 input steps, like the real client.
setInterval(() => {
  const now = Date.now();
  const viewTime = lastTick * 50 - 100; // what a browser would be rendering
  for (const c of clients) {
    if (!c.open) continue;
    if (now > c.nextChange) {
      c.buttons = (Math.random() * 16) | 0;                  // random WASD combination
      if (Math.random() < 0.35) c.buttons |= 16;             // fire some of the time
      c.nextChange = now + 400 + Math.random() * 1600;
    }
    c.aim += (Math.random() - 0.5) * 0.3;
    if (c.aim > Math.PI) c.aim -= Math.PI * 2;
    if (c.aim < -Math.PI) c.aim += Math.PI * 2;
    const a = Math.round(c.aim * 1000) / 1000;
    c.ws.send(JSON.stringify([1, c.seq, viewTime, c.buttons, a, c.buttons, a]));
    c.seq += 2;
  }
}, 50);

// Report once per second.
setInterval(() => {
  const t = Math.round((Date.now() - startedAt) / 1000);
  const per = connected || 1;
  let line = `[${String(t).padStart(3)}s] clients ${connected}/${N}` +
    (failed ? ` (failed ${failed})` : '') + (closed ? ` (closed ${closed})` : '') +
    ` | msgs/client/s ${(msgsThisSec / per).toFixed(1)}` +
    ` | down ${(bytesThisSec / per / 1024).toFixed(1)} KB/s/client`;
  if (lastServer) {
    const s = lastServer;
    tickSamples.push(s.tickAvg);
    line += ` | server: players ${s.players}, bots ${s.bots}, tick ${s.tickAvg.toFixed(2)} ms avg (${s.tickMax.toFixed(2)} max;` +
      ` sim ${s.sim.toFixed(2)} / interest ${s.aoi.toFixed(2)} / send ${s.send.toFixed(2)}), ${(s.bytesPerPlayer / 1024).toFixed(1)} KB/s/player`;
  }
  console.log(line);
  msgsThisSec = 0;
  bytesThisSec = 0;
}, 1000);

process.on('SIGINT', () => {
  if (tickSamples.length) {
    const avg = tickSamples.reduce((a, b) => a + b, 0) / tickSamples.length;
    const max = Math.max(...tickSamples);
    console.log(`\nSummary: ${N} clients, server tick avg ${avg.toFixed(2)} ms, worst 1s average ${max.toFixed(2)} ms (budget 50 ms at 20 Hz)`);
  }
  for (const c of clients) try { c.ws.terminate(); } catch (_) { /* ignore */ }
  process.exit(0);
});

console.log(`Load test: ${N} clients -> ${URL}  (Ctrl+C to stop)`);
