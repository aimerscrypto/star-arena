// Bootstrap: Pixi app, assets, network, world state, scene, HUD, frame loop.

import { Net } from './net.js';
import { Input } from './input.js';
import { World } from './world.js';
import { Scene } from './scene.js';
import { Hud } from './hud.js';
import { Sfx } from './audio.js';
import { loadAssets, PLAYER_SHIPS } from './assets.js';

const { C2S } = window.Shared;
const $ = (id) => document.getElementById(id);

async function main() {
  const playBtn = $('playBtn');

  // ---------------- ship picker (works before anything else is loaded)
  let design = 0;
  try { design = Math.min(3, Math.max(0, parseInt(localStorage.getItem('sa_ship'), 10) || 0)); } catch (_) { /* ignore */ }
  const picker = $('shipPicker');
  PLAYER_SHIPS.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'shipCard';
    card.innerHTML = `<img src="assets/${s.tex}.svg" alt=""><div class="sn"></div><div class="st"></div><div class="bar"></div>`;
    card.querySelector('.sn').textContent = s.name;
    card.querySelector('.st').textContent = s.tagline;
    card.querySelector('.bar').style.background = s.color;
    card.addEventListener('click', () => {
      design = i;
      try { localStorage.setItem('sa_ship', String(i)); } catch (_) { /* ignore */ }
      for (const c of picker.children) { c.classList.remove('sel'); c.style.borderColor = ''; }
      card.classList.add('sel');
      card.style.borderColor = s.color;
    });
    picker.append(card);
  });
  picker.children[design].click();

  const nameInput = $('nameInput');
  try { nameInput.value = localStorage.getItem('sa_name') || ''; } catch (_) { /* ignore */ }

  // ---------------- renderer + assets
  const app = new PIXI.Application();
  await app.init({
    resizeTo: window,
    background: '#05070f',
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  $('stage').appendChild(app.canvas);

  // Make sure the UI fonts are ready before Pixi renders any text with them.
  await Promise.race([
    Promise.all([document.fonts.load('600 13px "Exo 2"'), document.fonts.load('20px "Russo One"')]),
    new Promise((r) => setTimeout(r, 2500)),
  ]).catch(() => {});

  const tex = await loadAssets((p) => { playBtn.textContent = `Loading ${Math.round(p * 100)}%`; });

  // ---------------- game objects
  const input = new Input(app.canvas);
  const sfx = new Sfx();
  let wantJoin = null; // {name, design} once the player pressed Play (used to rejoin after a reconnect)
  let hud = null, scene = null;

  const net = new Net(
    (type, msg) => world.onMessage(type, msg),
    (connected) => {
      $('conn').classList.toggle('hidden', connected || wantJoin === null);
      if (!connected) {
        world.reset();
        input.enabled = false;
        return;
      }
      if (wantJoin) net.send([C2S.JOIN, wantJoin.name, wantJoin.design]); // transparent rejoin
    }
  );

  const fx = {
    muzzle: (...a) => scene.muzzle(...a),
    impact: (...a) => scene.impact(...a),
    explosion: (...a) => scene.explosion(...a),
    pickupTaken: (...a) => scene.pickupTaken(...a),
    damageNumber: (...a) => scene.damageNumber(...a),
  };

  const world = new World(net, input, fx, sfx, {
    joined() {
      $('menu').classList.add('hidden');
      document.body.classList.add('playing');
      input.enabled = true;
      nameInput.blur();
      hud.onJoined();
    },
    died(killer, ms) { hud.onDied(killer, ms); },
    killfeed(kills) { hud.onKillfeed(kills); },
    stats() { hud.onStats(); },
  });

  scene = new Scene(app, tex, world);
  hud = new Hud(world, net, sfx);
  input.onToggleStats = () => hud.toggleStats();
  input.onToggleMute = () => { sfx.toggleMute(); hud.showMute(); };

  // ---------------- start screen
  playBtn.disabled = false;
  playBtn.textContent = 'Play';
  nameInput.focus();

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    sfx.unlock(); // audio may only start from a user gesture
    const name = nameInput.value.trim().slice(0, 16);
    try { localStorage.setItem('sa_name', name); } catch (_) { /* ignore */ }
    wantJoin = { name, design };
    net.send([C2S.JOIN, name, design]);
  });

  net.connect();

  // ---------------- frame loop
  app.ticker.add((ticker) => {
    const dt = Math.min(0.1, ticker.deltaMS / 1000);
    world.update(dt);
    scene.update(dt);
    hud.update(performance.now());
  });
}

main().catch((err) => {
  console.error(err);
  const btn = $('playBtn');
  btn.textContent = 'Failed to load';
  btn.disabled = true;
});

