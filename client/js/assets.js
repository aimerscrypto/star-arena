// Loads the hand-drawn SVG sprites (client/assets/*.svg) as Pixi textures.

const RES = 2; // rasterise SVGs at 2x for crisp sprites on high-DPI screens

// Ship designs. Nozzle positions are in the 128x128 art coordinates (ship points up).
export const PLAYER_SHIPS = [
  { name: 'Falcon', tagline: 'Balanced fighter', color: '#3d8ef0', tex: 'ship_1', laser: 'laser_blue', nozzles: [[57, 112], [71, 112]], flameW: 1 },
  { name: 'Hornet', tagline: 'Twin-pod heavy', color: '#f58a1f', tex: 'ship_2', laser: 'laser_orange', nozzles: [[35, 112], [93, 112]], flameW: 1.15 },
  { name: 'Viper', tagline: 'Sleek interceptor', color: '#45b84f', tex: 'ship_3', laser: 'laser_green', nozzles: [[64, 112]], flameW: 1.55 },
  { name: 'Specter', tagline: 'Stealth wing', color: '#8d5ae8', tex: 'ship_4', laser: 'laser_purple', nozzles: [[51, 100], [77, 100]], flameW: 1.1 },
];
export const BOT_SHIPS = [
  { name: 'Raider', color: '#e0392f', tex: 'enemy_1', laser: 'laser_red', nozzles: [[57.5, 106], [70.5, 106]], flameW: 0.9 },
  { name: 'Brute', color: '#e0392f', tex: 'enemy_2', laser: 'laser_red', nozzles: [[47, 103], [64, 106], [81, 103]], flameW: 0.9 },
];
export const BULLET_STYLES = ['laser_blue', 'laser_orange', 'laser_green', 'laser_purple', 'laser_red'];

export function shipInfo(design, isBot) {
  return isBot ? BOT_SHIPS[design % BOT_SHIPS.length] : PLAYER_SHIPS[design % PLAYER_SHIPS.length];
}

const FILES = [
  'ship_1', 'ship_2', 'ship_3', 'ship_4', 'enemy_1', 'enemy_2',
  'laser_blue', 'laser_orange', 'laser_green', 'laser_purple', 'laser_red',
  'flame_1', 'flame_2', 'flame_3',
  'explosion_1', 'explosion_2', 'explosion_3', 'explosion_4', 'explosion_5', 'explosion_6',
  'meteor_1', 'meteor_2', 'meteor_3',
  'shield', 'pickup', 'muzzle', 'impact', 'smoke',
  'debris_1', 'debris_2', 'debris_3',
  'planet_1', 'planet_2', 'planet_3',
];

/** White silhouette of a texture, used for the hit flash on damaged ships. */
function silhouette(tex) {
  const src = tex.source.resource;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  return new PIXI.Texture({ source: new PIXI.ImageSource({ resource: c, resolution: RES, autoGenerateMipmaps: true }) });
}

export async function loadAssets(onProgress) {
  const tex = {};
  let done = 0;
  await Promise.all(FILES.map(async (name) => {
    // Mipmaps (smooth downscaling) only for the 128px art, which rasterises to a power-of-two 256px
    // texture; WebGL1 can't mipmap non-power-of-two sizes.
    const mip = /^(ship|enemy|meteor|explosion)_/.test(name);
    tex[name] = await PIXI.Assets.load({ src: `assets/${name}.svg`, data: { resolution: RES, autoGenerateMipmaps: mip } });
    done++;
    if (onProgress) onProgress(done / FILES.length);
  }));
  tex.flash = {};
  for (const s of [...PLAYER_SHIPS, ...BOT_SHIPS]) tex.flash[s.tex] = silhouette(tex[s.tex]);
  tex.flames = [tex.flame_1, tex.flame_2, tex.flame_3];
  tex.explosion = [1, 2, 3, 4, 5, 6].map((i) => tex['explosion_' + i]);
  tex.meteors = [tex.meteor_1, tex.meteor_2, tex.meteor_3];
  tex.debris = [tex.debris_1, tex.debris_2, tex.debris_3];
  return tex;
}
