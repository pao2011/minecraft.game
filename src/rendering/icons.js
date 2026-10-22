// Item icons: isometric cubes for block items (drawn from atlas tiles) and original pixel-art
// sprites for everything else. Icons are cached canvases (32x32) usable by the DOM and WebGL.
import { ITEMS, TIERS, ARMOR_SETS } from '../items/items.js';
import { BLOCKS, B } from '../world/blocks.js';
import { TILE } from '../world/tiles.js';
import { paintTile } from './textures.js';

const SIZE = 32;
const cache = new Map();
const tileCanvases = new Map();
const DEFAULT_TINT = { grass: [0.52, 0.74, 0.36], foliage: [0.42, 0.66, 0.3], water: [0.25, 0.45, 0.85] };

function tileCanvas(tile, tintKind) {
  const key = `${tile}:${tintKind || ''}`;
  if (tileCanvases.has(key)) return tileCanvases.get(key);
  const name = Object.keys(TILE).find((k) => TILE[k] === tile);
  const px = paintTile(name);
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  const img = g.createImageData(16, 16);
  const tint = DEFAULT_TINT[tintKind] || [1, 1, 1];
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    const tinted = a > 150 && a < 230 && tintKind;
    img.data[i] = px[i] * (tinted ? tint[0] : 1);
    img.data[i + 1] = px[i + 1] * (tinted ? tint[1] : 1);
    img.data[i + 2] = px[i + 2] * (tinted ? tint[2] : 1);
    img.data[i + 3] = a >= 128 ? 255 : a > 20 && tintKind === 'water' ? 230 : a >= 100 ? 255 : 0;
  }
  g.putImageData(img, 0, 0);
  tileCanvases.set(key, c);
  return c;
}

function isoCube(g, d, height = 16) {
  const faceTile = (f) => (d.frontTile !== undefined && f === 4 ? d.frontTile : d.faces[f]);
  const top = tileCanvas(d.faces[2], d.tint);
  const left = tileCanvas(faceTile(4), d.tint === 'grass' ? 'grass' : d.tint);
  const right = tileCanvas(faceTile(0), d.tint === 'grass' ? 'grass' : d.tint);
  const drop = 16 - height; // slabs sit lower
  g.imageSmoothingEnabled = false;
  const face = (img, a, b, c, dd, e, f, shade, srcH = 16) => {
    g.save();
    g.setTransform(a, b, c, dd, e, f);
    g.drawImage(img, 0, 16 - srcH, 16, srcH, 0, 0, 16, srcH);
    if (shade < 1) {
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = `rgba(0,0,0,${1 - shade})`;
      g.fillRect(0, 0, 16, srcH);
    }
    g.restore();
  };
  face(left, 14 / 16, 7 / 16, 0, 1, 2, 8 + drop, 0.82, height);
  face(right, 14 / 16, -7 / 16, 0, 1, 16, 15 + drop, 0.64, height);
  face(top, 14 / 16, -7 / 16, 14 / 16, 7 / 16, 2, 8 + drop, 1);
}

function flatTile(g, tile, tint) {
  g.imageSmoothingEnabled = false;
  g.drawImage(tileCanvas(tile, tint), 0, 0, 32, 32);
}

// ---- Sprite templates (16x16, '.' transparent). Letters map to palette entries. ----------
const T = {
  pickaxe: ['................', '...HHHHHHHH.....', '..HhhhhhhhhH....', '..H.....SS.hH...', '........SS..H...', '.......SS...H...', '......SS........', '.....SS.........', '....SS..........', '...SS...........', '..SS............', '.SS.............', 'SS..............', '................', '................', '................'],
  axe: ['................', '.......HHH......', '......HhhhH.....', '.....HhhhhH.....', '.....HhhSSH.....', '......HSSH......', '......SS........', '.....SS.........', '....SS..........', '...SS...........', '..SS............', '.SS.............', 'SS..............', '................', '................', '................'],
  shovel: ['................', '..........HHH...', '.........HhhhH..', '.........HhhhH..', '..........HhH...', '.........SS.....', '........SS......', '.......SS.......', '......SS........', '.....SS.........', '....SS..........', '...SS...........', '..SS............', '.SS.............', '................', '................'],
  sword: ['..............HH', '.............HhH', '............HhH.', '...........HhH..', '..........HhH...', '.........HhH....', '........HhH.....', '..G....HhH......', '...G..HhH.......', '....GHhH........', '.....GH.........', '....SSG.........', '...SS..G........', '..SS............', '.SS.............', '................'],
  hoe: ['................', '....HHHHHH......', '...HhhhhhSS.....', '........SS......', '.......SS.......', '......SS........', '.....SS.........', '....SS..........', '...SS...........', '..SS............', '.SS.............', 'SS..............', '................', '................', '................', '................'],
  helmet: ['................', '................', '....HHHHHHHH....', '...HhhhhhhhhH...', '..HhhhhhhhhhhH..', '..HhhhhhhhhhhH..', '..HhH......HhH..', '..HhH......HhH..', '..HH........HH..', '................'],
  chestplate: ['..HHH....HHH....', '.HhhhH..HhhhH...', '.HhhhhHHhhhhH...', '..HhhhhhhhhH....', '...HhhhhhhhH....', '...HhhhhhhhH....', '...HhhhhhhhH....', '...HhhhhhhhH....', '...HHHHHHHHH....'],
  leggings: ['...HHHHHHHH.....', '...HhhhhhhhH....', '...HhhhhhhhH....', '...HhhH.HhhH....', '...HhhH.HhhH....', '...HhhH.HhhH....', '...HhhH.HhhH....', '...HHHH.HHHH....'],
  boots: ['................', '................', '..HHH.....HHH...', '..HhH.....HhH...', '..HhH.....HhH...', '.HhhH....HhhH...', 'HhhhH...HhhhH...', 'HHHHH...HHHHH...'],
  stick: ['..............SW', '.............SS.', '............SS..', '...........SS...', '..........SS....', '.........SS.....', '........SS......', '.......SS.......', '......SS........', '.....SS.........', '....SS..........', '...SS...........', '..SS............', '.SS.............', 'SS..............', '................'],
  lump: ['................', '................', '................', '.....HHHH.......', '....HhhhhHH.....', '...HhhwhhhhH....', '...HhhhhhhhhH...', '..HhhhhhhhhhH...', '..HhhhhhhdhhH...', '..HhhhhhddhH....', '...HhhhhhhH.....', '....HHHHHH......'],
  ingot: ['................', '................', '................', '................', '.....HHHHHHHH...', '....HwwwwwwhH...', '...HhhhhhhhhH...', '..HhhhhhhhhH....', '..HdddddddH.....', '..HHHHHHHH......'],
  dust: ['................', '................', '................', '................', '................', '.......w........', '......hhw.......', '.....hhhhh..h...', '..h.hhhwhhh.....', '...hhhhhhhhh....', '..hhhhhhhhhhh...', '.HHHHHHHHHHHHH..'],
  crystal: ['................', '........w.......', '.......HwH......', '......HhwhH.....', '......HhhhH.....', '.....HhhhhdH....', '.....HhhhhdH....', '....HhhhhhddH...', '....HhhhhhddH...', '.....HhhhhdH....', '......HhhdH.....', '.......HHH......'],
  gem: ['................', '................', '.....HHHHHH.....', '....HwwhhhhH....', '...HwhhhhhhhH...', '..HHHHHHHHHHHH..', '...HhhhhhhhdH...', '....HhhhhhdH....', '.....HhhhdH.....', '......HhdH......', '.......HH.......'],
  ball: ['................', '................', '................', '.....HHHHH......', '....HwwhhhH.....', '...HwhhhhhhH....', '...HhhhhhhhH....', '...HhhhhhhdH....', '...HhhhhhddH....', '....HhhhddH.....', '.....HHHHH......'],
  sheet: ['................', '................', '...HHHHHHHHH....', '..HhhhhhhhhhH...', '..HhhhhhhhhhhH..', '...HhhhhhhhhH...', '..HhhhhhhhhhH...', '..HhhhhhhhhhhH..', '...HhhhhhhhhH...', '....HHHHHHHH....'],
  feather: ['............wH..', '...........whH..', '..........whhH..', '.........whhH...', '........whhH....', '.......whhH.....', '......whhH......', '.....whhH.......', '....whhH........', '...whH..........', '..SH............', '.S..............', 'S...............'],
  string: ['................', '....HHHH........', '...H....H.......', '..H..HH..H......', '..H.H..H.H......', '..H.H..H.H......', '..H..HH..H......', '...H....H.......', '....HHHH.H......', '..........H.....', '...........H....', '............HH..'],
  bone: ['................', '..HH............', '.HwhH...........', '.HhhhH..........', '..HhhhH.........', '...HhhhH........', '....HhhhH.......', '.....HhhhH......', '......HhhhH.....', '.......HhhhH....', '........HhhhHH..', '.........HhhhwH.', '..........HHhhH.', '............HH..'],
  wheat: ['..........H.H...', '.........HhHhH..', '........HhHhH...', '.......HhHhH....', '......HhHhS.....', '.....H.HSS......', '.......SS.......', '......SS........', '.....SS.........', '....SS..........', '...SS...........', '..SS............'],
  seeds: ['................', '................', '................', '.....H....H.....', '....HhH..HhH....', '.....H....H.....', '..H.....H.......', '.HhH...HhH...H..', '..H.....H...HhH.', '.....H.......H..', '....HhH.........', '.....H..........'],
  bucket: ['................', '................', '...HHHHHHHHHH...', '..HwwwwwwwwwwH..', '..HdddddddddhH..', '...HhhhhhhhhH...', '...HhhhhhhhhH...', '....HhhhhhhH....', '....HhhhhhhH....', '.....HHHHHH.....'],
  apple: ['.......S........', '.......SL.......', '....HHHSHH......', '...HwwhhhhH.....', '..HwhhhhhhhH....', '..HhhhhhhhhH....', '..HhhhhhhhhH....', '..HhhhhhhhdH....', '...HhhhhhddH....', '....HhhhddH.....', '.....HH.HH......'],
  bread: ['................', '................', '................', '....HHHHHHH.....', '...HwwhwwhwH....', '..HhhhhhhhhhH...', '..HhhhhhhhhhhH..', '..HddddddddddH..', '...HHHHHHHHHH...'],
  carrot: ['...........LL...', '..........LLL...', '.........HHL....', '........HhH.....', '.......HhhH.....', '......HhhH......', '.....HhhH.......', '....HhhH........', '...HhhH.........', '...HhH..........', '...HH...........'],
  meat: ['................', '................', '.....HHHHH......', '...HHhhhhhHH....', '..HhhwwhhhhhH...', '..HhwhhhhhhhH...', '.HhhhhhhhhhhH...', '.HhhhhhhhhhH....', '.HhhhhhhhhH.....', '..HhhhhhHHwww...', '...HHHHH..www...'],
};

function spriteOf(g, rows, pal) {
  g.imageSmoothingEnabled = false;
  const oy = Math.floor((16 - rows.length) / 2);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = pal[row[x]];
      if (!c) continue;
      g.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
      g.fillRect(x * 2, (y + oy) * 2, 2, 2);
    }
  });
}

const shade = (c, f) => c.map((v) => Math.min(255, v * f));
const pal = (base, extra = {}) => ({ H: shade(base, 0.55), h: base, w: shade(base, 1.35), d: shade(base, 0.78), ...extra });
const STICK = [112, 82, 48];

const ITEM_SPRITES = {
  stick: () => [T.stick, { S: STICK, W: [150, 112, 66] }],
  coal: () => [T.lump, pal([52, 52, 56])],
  charcoal: () => [T.lump, pal([70, 56, 44])],
  raw_copper: () => [T.lump, pal([200, 110, 70], { d: [96, 170, 140] })],
  raw_iron: () => [T.lump, pal([206, 170, 144])],
  raw_gold: () => [T.lump, pal([240, 200, 60])],
  copper_ingot: () => [T.ingot, pal([214, 124, 74])],
  iron_ingot: () => [T.ingot, pal([214, 214, 220])],
  gold_ingot: () => [T.ingot, pal([248, 210, 60])],
  brick: () => [T.ingot, pal([170, 80, 60])],
  ember_dust: () => [T.dust, pal([236, 70, 44])],
  bone_meal: () => [T.dust, pal([236, 232, 220])],
  azure_crystal: () => [T.crystal, pal([90, 190, 245])],
  starstone: () => [T.gem, pal([200, 176, 255])],
  flint: () => [T.lump, pal([70, 70, 76])],
  clay_ball: () => [T.ball, pal([160, 166, 184])],
  hide: () => [T.sheet, pal([150, 98, 60])],
  feather: () => [T.feather, { H: [170, 170, 176], h: [236, 236, 240], w: [255, 255, 255], S: [120, 120, 126] }],
  string: () => [T.string, { H: [232, 232, 236] }],
  bone: () => [T.bone, pal([226, 222, 206])],
  wheat: () => [T.wheat, { H: [170, 130, 40], h: [222, 190, 90], S: [150, 160, 60] }],
  wheat_seeds: () => [T.seeds, { H: [70, 110, 40], h: [120, 170, 70] }],
  bucket: () => [T.bucket, pal([200, 200, 208])],
  water_bucket: () => [T.bucket, pal([200, 200, 208], { d: [60, 110, 230] })],
  apple: () => [T.apple, pal([210, 40, 44], { S: [96, 70, 40], L: [80, 150, 50] })],
  bread: () => [T.bread, pal([200, 150, 80])],
  carrot: () => [T.carrot, pal([240, 130, 40], { L: [70, 150, 50] })],
  raw_steak: () => [T.meat, pal([200, 70, 70], { w: [240, 220, 220] })],
  cooked_steak: () => [T.meat, pal([140, 80, 46], { w: [230, 210, 190] })],
  raw_ham: () => [T.meat, pal([236, 130, 130], { w: [250, 236, 230] })],
  cooked_ham: () => [T.meat, pal([186, 110, 70], { w: [240, 220, 200] })],
  raw_fowl: () => [T.meat, pal([236, 190, 170], { w: [250, 240, 230] })],
  roast_fowl: () => [T.meat, pal([200, 140, 70], { w: [240, 220, 190] })],
  raw_mutton: () => [T.meat, pal([210, 90, 90], { w: [240, 230, 220] })],
  cooked_mutton: () => [T.meat, pal([150, 90, 60], { w: [230, 210, 190] })],
  spoiled_meat: () => [T.meat, pal([140, 130, 70], { w: [170, 160, 110] })],
};

// Blocks whose items read better as flat pictures than as cubes.
const FLAT_BLOCKS = new Set(['torch', 'ladder', 'glass_pane', 'lantern', 'glowcap', 'dead_bush', 'tall_grass', 'flower_red', 'flower_yellow', 'flower_blue', 'oak_sapling', 'pine_sapling', 'birch_sapling', 'dark_sapling', 'trapdoor']);

function drawIcon(key) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  const it = ITEMS[key];
  if (!it) return c;
  if (it.kind === 'block') {
    const d = BLOCKS[it.block];
    if (key === 'door') {
      g.imageSmoothingEnabled = false;
      g.drawImage(tileCanvas(TILE.door_top), 0, 0, 16, 16, 8, 0, 16, 16);
      g.drawImage(tileCanvas(TILE.door_bottom), 0, 0, 16, 16, 8, 16, 16, 16);
    } else if (key === 'fence') {
      spriteOf(g, ['................', '..HH......HH....', '..Hh......Hh....', '..HhHHHHHHHhHH..', '..HhhhhhhhhhhH..', '..Hh......Hh....', '..HhHHHHHHHhHH..', '..HhhhhhhhhhhH..', '..Hh......Hh....', '..Hh......Hh....', '..HH......HH....'], pal([172, 136, 86]));
    } else if (key === 'bed') {
      spriteOf(g, ['................', '................', '................', '..WWWRRRRRRRRR..', '.WWWWRRRRRRRRRR.', '.RRRRRRRRRRRRRR.', '.PPPPPPPPPPPPPP.', '.P............P.'], { W: [236, 236, 230], R: [176, 40, 48], P: [130, 96, 58] });
    } else if (FLAT_BLOCKS.has(key)) flatTile(g, d.faces[0], d.tint);
    else if (d.shape === 'cross') flatTile(g, d.faces[0], d.tint);
    else isoCube(g, d, d.shape === 'slab' ? 8 : 16);
    return c;
  }
  if (it.tool && ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'].includes(it.tool.type)) {
    const col = TIERS[it.tool.tier].color;
    spriteOf(g, T[it.tool.type], pal(col, { S: STICK, G: shade(col, 0.7) }));
    return c;
  }
  if (it.armor) {
    spriteOf(g, T[it.armor.slot], pal(ARMOR_SETS[it.armor.set].color));
    return c;
  }
  const sp = ITEM_SPRITES[key];
  if (sp) {
    const [rows, p] = sp();
    spriteOf(g, rows, p);
  } else {
    g.fillStyle = '#c0c';
    g.fillRect(8, 8, 16, 16);
  }
  return c;
}

/** Cached 32x32 icon canvas for an item key. */
export function iconCanvas(key) {
  if (!cache.has(key)) cache.set(key, drawIcon(key));
  return cache.get(key);
}

const urls = new Map();
/** Data URL for DOM use (cached). */
export function iconURL(key) {
  if (!urls.has(key)) urls.set(key, iconCanvas(key).toDataURL());
  return urls.get(key);
}

/** Every item must have an icon; returns keys that fell back to the placeholder. */
export function missingIcons() {
  return Object.keys(ITEMS).filter((k) => ITEMS[k].kind !== 'block' && !ITEMS[k].tool?.tier && !ITEMS[k].armor && !ITEM_SPRITES[k]);
}

export { B };
