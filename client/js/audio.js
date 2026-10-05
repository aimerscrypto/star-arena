// Sound effects synthesised with the Web Audio API (no audio files).

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noise = null;
    this.last = {};
    this.muted = false;
    try { this.muted = localStorage.getItem('sa_muted') === '1'; } catch (_) { /* storage unavailable */ }
  }

  /** Must be called from a user gesture (the Play click) before sounds can play. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.32;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp);
      comp.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem('sa_muted', this.muted ? '1' : '0'); } catch (_) { /* ignore */ }
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.32, this.ctx.currentTime, 0.02);
    return this.muted;
  }

  /** Rate-limit each sound type so a big fight doesn't turn into noise. */
  ok(kind, minGapMs) {
    if (!this.ctx || this.muted) return false;
    const now = performance.now();
    if (now - (this.last[kind] || 0) < minGapMs) return false;
    this.last[kind] = now;
    return true;
  }

  env(gain, t, peak, attack, decay) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random() * 0.5;
    return src;
  }

  laser(vol = 1, pitch = 1) {
    if (vol < 0.03 || !this.ok('laser' + (vol >= 0.9 ? 'me' : ''), vol >= 0.9 ? 30 : 45)) return;
    const c = this.ctx, t = c.currentTime;
    const g = c.createGain();
    this.env(g, t, 0.16 * vol, 0.004, 0.13);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 3200;
    for (const [type, mul] of [['square', 1], ['sawtooth', 1.012]]) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(1250 * pitch * mul, t);
      o.frequency.exponentialRampToValueAtTime(260 * pitch, t + 0.13);
      o.connect(f);
      o.start(t);
      o.stop(t + 0.16);
    }
    f.connect(g);
    g.connect(this.master);
  }

  hit(vol = 1) {
    if (!this.ok('hit', 40)) return;
    const c = this.ctx, t = c.currentTime;
    const n = this.noiseSource();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 1.2;
    const g = c.createGain();
    this.env(g, t, 0.35 * vol, 0.002, 0.07);
    n.connect(bp); bp.connect(g); g.connect(this.master);
    n.start(t); n.stop(t + 0.1);

    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.1);
    const og = c.createGain();
    this.env(og, t, 0.25 * vol, 0.002, 0.1);
    o.connect(og); og.connect(this.master);
    o.start(t); o.stop(t + 0.13);
  }

  explosion(vol = 1) {
    if (vol < 0.04 || !this.ok('boom', 70)) return;
    const c = this.ctx, t = c.currentTime;
    const n = this.noiseSource();
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.9);
    const g = c.createGain();
    this.env(g, t, 0.55 * vol, 0.005, 0.95);
    n.connect(lp); lp.connect(g); g.connect(this.master);
    n.start(t); n.stop(t + 1.05);

    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.6);
    const og = c.createGain();
    this.env(og, t, 0.5 * vol, 0.005, 0.6);
    o.connect(og); og.connect(this.master);
    o.start(t); o.stop(t + 0.7);
  }

  respawn() {
    if (!this.ok('respawn', 300)) return;
    const c = this.ctx, t = c.currentTime;
    [392, 523.25, 659.25, 783.99].forEach((freq, i) => {
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      const g = c.createGain();
      this.env(g, t + i * 0.07, 0.14, 0.01, 0.22);
      o.connect(g); g.connect(this.master);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.3);
    });
  }

  pickup() {
    if (!this.ok('pickup', 150)) return;
    const c = this.ctx, t = c.currentTime;
    [[880, 0], [1318.5, 0.08]].forEach(([freq, dt]) => {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      const g = c.createGain();
      this.env(g, t + dt, 0.18, 0.005, 0.28);
      o.connect(g); g.connect(this.master);
      o.start(t + dt); o.stop(t + dt + 0.35);
    });
  }
}
