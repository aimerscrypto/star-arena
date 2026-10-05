// WebSocket connection: binary snapshots in, small JSON messages both ways.
import { decodeSnapshot } from './protocol.js';

const { C2S, S2C } = window.Shared;

export class Net {
  constructor(onMessage, onStatus) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.ws = null;
    this.open = false;
    this.ping = 0;
    this.bytesIn = 0;          // bytes received in the current 1s window
    this.downRate = 0;         // bytes/s, updated every second
    this.snapCount = 0;
    this.snapRate = 0;
    setInterval(() => {
      this.downRate = this.bytesIn; this.bytesIn = 0;
      this.snapRate = this.snapCount; this.snapCount = 0;
    }, 1000);
    setInterval(() => this.send([C2S.PING, Math.round(performance.now())]), 2000);
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.onStatus(true);
      this.send([C2S.PING, Math.round(performance.now())]);
    };
    ws.onclose = () => {
      this.open = false;
      this.onStatus(false);
      setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        this.bytesIn += e.data.length;
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        if (msg[0] === S2C.PONG) {
          const rtt = performance.now() - msg[1];
          this.ping = this.ping ? this.ping * 0.6 + rtt * 0.4 : rtt;
          return;
        }
        this.onMessage(msg[0], msg);
        return;
      }
      this.bytesIn += e.data.byteLength;
      this.snapCount++;
      this.onMessage(S2C.SNAP, decodeSnapshot(e.data));
    };
  }

  send(arr) {
    if (this.open && this.ws.readyState === 1) this.ws.send(JSON.stringify(arr));
  }
}
