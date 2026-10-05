// Procedural space backdrop: a value-noise nebula baked once at startup,
// two parallax star layers and three distant SVG planets.

const { C } = window.Shared;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise: a random lattice that wraps every `period` cells. */
function makeValueNoise(period, seed) {
  const rnd = mulberry32(seed);
  const lattice = new Float32Array(period * period);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = lattice[y0 * period + x0], b = lattice[y0 * period + x1];
    const c = lattice[y1 * period + x0], d = lattice[y1 * period + x1];
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
  };
}

function fbm(noises, x, y) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (const n of noises) {
    sum += n(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function bakeNebula(size) {
  const base = 4; // lattice cells across the tile at the lowest octave
  const octaves = 5;
  const density = [], tint = [], dust = [];
  for (let o = 0; o < octaves; o++) {
    density.push(makeValueNoise(base << o, 101 + o));
    tint.push(makeValueNoise(base << o, 211 + o));
    dust.push(makeValueNoise(base << o, 307 + o));
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const px = img.data;
  const k = base / size;
  // palette: near-black navy base, deep blue and muted purple clouds
  const BASE = [6, 9, 22], BLUE = [28, 48, 104], PURPLE = [70, 36, 104];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = fbm(density, x * k, y * k);
      let cloud = Math.min(1, Math.max(0, (d - 0.42) / 0.4));
      cloud = cloud * cloud * (3 - 2 * cloud) * 0.55; // smoothstep, kept dim
      const t = fbm(tint, x * k, y * k);
      const lane = 0.65 + 0.35 * fbm(dust, x * k * 2, y * k * 2);
      const mix = Math.min(1, Math.max(0, (t - 0.35) / 0.3));
      const i = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const col = BLUE[ch] + (PURPLE[ch] - BLUE[ch]) * mix;
        px[i + ch] = BASE[ch] + col * cloud * lane;
      }
      px[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function bakeStars(size, count, rMin, rMax, seed) {
  const rnd = mulberry32(seed);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  for (let i = 0; i < count; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = rMin + rnd() * (rMax - rMin);
    const t = rnd();
    g.fillStyle = t < 0.12 ? '#ffe2c4' : t < 0.35 ? '#c8dcff' : '#f2f5ff';
    g.globalAlpha = 0.35 + rnd() * 0.65;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

const texFromCanvas = (canvas) => new PIXI.Texture({ source: new PIXI.ImageSource({ resource: canvas }) });

export class Background {
  constructor(tex) {
    this.root = new PIXI.Container();
    this.nebula = new PIXI.TilingSprite({ texture: texFromCanvas(bakeNebula(512)), width: 16, height: 16 });
    this.nebula.tileScale.set(3);
    this.far = new PIXI.TilingSprite({ texture: texFromCanvas(bakeStars(1024, 380, 0.5, 1.1, 7)), width: 16, height: 16 });
    this.near = new PIXI.TilingSprite({ texture: texFromCanvas(bakeStars(1024, 90, 1.0, 1.9, 13)), width: 16, height: 16 });
    this.root.addChild(this.nebula, this.far);

    // Planets sit between the star layers; slight dimming pushes them into the distance.
    this.planets = [
      { s: new PIXI.Sprite(tex.planet_1), fx: 0.78, fy: 0.26, p: 0.03, scale: 1.25 },
      { s: new PIXI.Sprite(tex.planet_2), fx: 0.14, fy: 0.78, p: 0.045, scale: 0.9 },
      { s: new PIXI.Sprite(tex.planet_3), fx: 0.42, fy: 0.12, p: 0.02, scale: 0.6 },
    ];
    for (const p of this.planets) {
      p.s.anchor.set(0.5);
      p.s.scale.set(p.scale);
      p.s.tint = 0xb8bfd6;
      this.root.addChild(p.s);
    }
    this.root.addChild(this.near);
  }

  resize(w, h) {
    for (const t of [this.nebula, this.far, this.near]) { t.width = w; t.height = h; }
  }

  update(camX, camY, zoom, w, h) {
    this.nebula.tilePosition.set(-camX * 0.03 * zoom, -camY * 0.03 * zoom);
    this.far.tilePosition.set(-camX * 0.08 * zoom, -camY * 0.08 * zoom);
    this.near.tilePosition.set(-camX * 0.22 * zoom, -camY * 0.22 * zoom);
    const mid = C.WORLD_SIZE / 2;
    for (const p of this.planets) {
      p.s.position.set(p.fx * w - (camX - mid) * p.p * zoom, p.fy * h - (camY - mid) * p.p * zoom);
    }
  }
}
