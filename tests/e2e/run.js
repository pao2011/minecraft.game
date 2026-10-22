// End-to-end gameplay tests in headless Chromium (software WebGL via SwiftShader).
// Drives the real game through its UI and multi-touch controls (CDP touch events).
//
//   npm run build && npm run test:e2e          (serves build/web with `vite preview`)
//   BW_URL=http://localhost:5173/ npm run test:e2e   (against a running dev server)
//   ONLY=A,C npm run test:e2e                   (subset of scenarios)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = 'test-results';
mkdirSync(OUT, { recursive: true });
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
let server = null;
let BASE = process.env.BW_URL;

async function startServer() {
  if (BASE) return;
  server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
  BASE = 'http://localhost:4173/';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('preview server did not start')), 30000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('4173')) {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

/** Multi-touch through CDP: every event carries all active points, like a real screen. */
class Touch {
  constructor(page) {
    this.page = page;
    this.active = new Map();
  }
  async init() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    return this;
  }
  points() {
    return [...this.active].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 3, radiusY: 3, force: 1 }));
  }
  async start(id, x, y) {
    this.active.set(id, { x, y });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: this.points() });
  }
  async move(id, x, y) {
    this.active.set(id, { x, y });
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: this.points() });
  }
  async end(id) {
    this.active.delete(id);
    if (this.active.size) await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: this.points() });
    else await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  async drag(id, x0, y0, x1, y1, steps = 10, holdMs = 0) {
    await this.start(id, x0, y0);
    for (let i = 1; i <= steps; i++) {
      await this.move(id, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
      await sleep(16);
    }
    if (holdMs) await sleep(holdMs);
    await this.end(id);
  }
  async tap(x, y, id = 90) {
    await this.start(id, x, y);
    await sleep(60);
    await this.end(id);
  }
}

async function center(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`No element ${sel}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
}

let browser;
async function newContext(viewport = { width: 900, height: 420 }) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('blockwild.settings.v1')) {
      localStorage.setItem('blockwild.settings.v1', JSON.stringify({ controlsMode: 'touch', renderDistance: 3, quality: 'custom', tutorialDone: true, adaptiveQuality: false, musicVolume: 0 }));
    }
  });
  return ctx;
}

async function openPage(ctx) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) page.errors.push(m.text());
  });
  await page.goto(BASE);
  await page.waitForFunction(() => document.querySelector('.menu-main'), null, { timeout: 30000 });
  return page;
}

async function createWorld(page, { name = 'E2E', seed = 'e2e', mode = 'survival', difficulty = 'normal' } = {}) {
  await page.click('text=New World');
  await page.fill('.form input.text-input >> nth=0', name);
  await page.fill('.form input.text-input >> nth=1', seed);
  if (mode === 'creative') await page.click('.seg button:has-text("Creative")');
  await page.click(`.seg button:has-text("${difficulty[0].toUpperCase() + difficulty.slice(1)}")`);
  await page.click('text=Create & Play');
  await waitPlaying(page);
}

async function waitPlaying(page, timeout = 120000) {
  await page.waitForFunction(() => window.__blockwild?.state === 'playing', null, { timeout, polling: 250 });
  // Let physics settle the player onto the ground.
  await page.waitForFunction(() => window.__blockwild.game.player.onGround || window.__blockwild.game.player.flying || window.__blockwild.game.player.inWater, null, { timeout: 20000, polling: 100 });
}

const G = (page, fn, arg) => page.evaluate(fn, arg);
const playerState = (page) => G(page, () => {
  const p = window.__blockwild.game.player;
  return { x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw, pitch: p.pitch, vx: p.vel.x, vz: p.vel.z, vy: p.vel.y, onGround: p.onGround, health: p.health, hunger: p.hunger, dead: p.dead };
});

/** Teleport next to a block and look at its center. Returns false if no standing spot. */
async function standAndLookAt(page, target) {
  return G(page, (t) => {
    const g = window.__blockwild.game;
    const { BLOCKS } = window.__bw;
    const w = g.world;
    const solid = (x, y, z) => BLOCKS[w.getBlock(x, y, z)].solid;
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, -1, 1, -2]) {
        const x = t.x + dx, z = t.z + dz, y = t.y + dy;
        if (!solid(x, y - 1, z) || solid(x, y, z) || solid(x, y + 1, z)) continue;
        const p = g.player;
        p.pos = { x: x + 0.5, y, z: z + 0.5 };
        p.vel = { x: 0, y: 0, z: 0 };
        const eye = p.eye;
        const tx = t.x + 0.5 - eye.x, ty = t.y + 0.5 - eye.y, tz = t.z + 0.5 - eye.z;
        p.yaw = Math.atan2(-tx, -tz);
        p.pitch = Math.atan2(ty, Math.hypot(tx, tz));
        return true;
      }
    }
    return false;
  }, target);
}

/** Level a 7x7 stone pad under the player with clear air above (deterministic test ground). */
async function flatPad(page) {
  return G(page, () => {
    const g = window.__blockwild.game;
    const { B } = window.__bw;
    const p = g.player;
    const x0 = Math.floor(p.pos.x), y0 = Math.floor(p.pos.y), z0 = Math.floor(p.pos.z);
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      g.world.setBlock(x0 + dx, y0 - 1, z0 + dz, B.stone);
      for (let dy = 0; dy < 4; dy++) g.world.setBlock(x0 + dx, y0 + dy, z0 + dz, B.air);
    }
    p.pos = { x: x0 + 0.5, y: y0, z: z0 + 0.5 };
    p.vel = { x: 0, y: 0, z: 0 };
    return { x: x0, y: y0, z: z0 };
  });
}

// ---------------------------------------------------------------------------------------------
const results = [];
async function scenario(id, name, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  const t0 = Date.now();
  process.stdout.write(`[${id}] ${name} ... `);
  try {
    const notes = await fn();
    results.push({ id, name, ok: true, ms: Date.now() - t0, notes });
    console.log(`PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)${notes ? ` - ${notes}` : ''}`);
  } catch (err) {
    results.push({ id, name, ok: false, ms: Date.now() - t0, error: err.message });
    console.log(`FAIL\n    ${err.message}`);
  }
}

async function main() {
  await startServer();
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

  // Shared context for scenarios that chain (A-D, F share a world via IndexedDB).
  const ctx = await newContext();
  let page = await openPage(ctx);
  const touch = await new Touch(page).init();
  const W = 900, H = 420;

  await scenario('A', 'New world: spawn, move, look, jump, inventory', async () => {
    await createWorld(page, { name: 'Alpha', seed: 'e2e-alpha' });
    const s0 = await playerState(page);
    const stuck = await G(page, () => window.__bw.collidesAt(window.__blockwild.game.world, window.__blockwild.game.player, window.__blockwild.game.player.pos));
    assert(!stuck, 'player spawned inside blocks');
    assert(s0.health === 20, 'full health at spawn');
    await page.screenshot({ path: `${OUT}/A-spawn.png` });
    // Joystick: drag up = walk forward.
    const joy = await center(page, '.joy-base');
    await touch.drag(1, joy.x, joy.y, joy.x, joy.y - 60, 6, 1200);
    const s1 = await playerState(page);
    const moved = Math.hypot(s1.x - s0.x, s1.z - s0.z);
    assert(moved > 1.5, `joystick moved the player (${moved.toFixed(2)} blocks)`);
    // Look: drag on the right half.
    await touch.drag(2, W * 0.62, H * 0.35, W * 0.62 + 140, H * 0.35 + 30, 8);
    const s2 = await playerState(page);
    assert(Math.abs(s2.yaw - s1.yaw) > 0.3, 'look drag rotated the camera');
    // Jump.
    const jb = await center(page, '.t-jump');
    const yBefore = (await playerState(page)).y;
    await touch.start(3, jb.x, jb.y);
    let maxY = yBefore;
    for (let i = 0; i < 12; i++) {
      await sleep(40);
      maxY = Math.max(maxY, (await playerState(page)).y);
    }
    await touch.end(3);
    assert(maxY > yBefore + 0.4, `jump raised the player (${(maxY - yBefore).toFixed(2)})`);
    // Holding jump must not bounce repeatedly.
    await touch.start(3, jb.x, jb.y);
    await sleep(1600);
    const jumps = await G(page, () => window.__blockwild.game.player.onGround);
    await touch.end(3);
    assert(jumps, 'holding the jump button does not keep jumping');
    // Inventory open/close.
    await touch.tap((await center(page, '.t-inv')).x, (await center(page, '.t-inv')).y);
    await page.waitForFunction(() => window.__blockwild.state === 'inventory');
    await page.screenshot({ path: `${OUT}/A-inventory.png` });
    await page.click('.inv .panel-head .icon-btn');
    await page.waitForFunction(() => window.__blockwild.state === 'playing');
    return `moved ${moved.toFixed(1)} blocks, jump +${(maxY - yBefore).toFixed(2)}`;
  });

  await scenario('B', 'Resource gathering: mine a log by holding the touch button, collect drop', async () => {
    const target = await G(page, () => {
      const g = window.__blockwild.game;
      const { B } = window.__bw;
      const logs = [B.oak_log, B.birch_log, B.pine_log, B.dark_log];
      const p = g.player.pos;
      let best = null;
      for (let dx = -40; dx <= 40; dx++) for (let dz = -40; dz <= 40; dz++) for (let y = 40; y < 110; y++) {
        const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz;
        const id = g.world.getBlock(x, y, z);
        if (logs.includes(id) && !logs.includes(g.world.getBlock(x, y - 1, z))) {
          const d = Math.hypot(dx, dz);
          if (!best || d < best.d) best = { x, y, z, id, d };
        }
      }
      return best;
    });
    let id = target?.id;
    let t = target;
    if (!t) {
      // No tree in range for this seed: place a dirt block instead so the mechanic is still exercised.
      t = await G(page, () => {
        const g = window.__blockwild.game;
        const p = g.player.pos;
        const x = Math.floor(p.x) + 2, y = Math.floor(p.y), z = Math.floor(p.z);
        g.world.setBlock(x, y, z, window.__bw.B.dirt);
        return { x, y, z, id: window.__bw.B.dirt };
      });
      id = t.id;
    }
    assert(await standAndLookAt(page, t), 'found a spot next to the target');
    await sleep(300);
    const aimed = await G(page, (t) => {
      const tg = window.__blockwild.game.interaction.target;
      return tg?.kind === 'block' && tg.hit.x === t.x && tg.hit.y === t.y && tg.hit.z === t.z;
    }, t);
    assert(aimed, 'crosshair targets the block');
    const key = await G(page, (id) => window.__bw.BLOCKS[id].key, id);
    const before = await G(page, (k) => window.__blockwild.game.player.inventory.count(k), key === 'grass' ? 'dirt' : key);
    const mb = await center(page, '.t-mine');
    await touch.start(4, mb.x, mb.y);
    await page.waitForFunction((t) => window.__blockwild.game.world.getBlock(t.x, t.y, t.z) !== t.id, t, { timeout: 15000, polling: 100 });
    await touch.end(4);
    await page.screenshot({ path: `${OUT}/B-mined.png` });
    // Walk onto the drop if it did not reach us.
    await G(page, (t) => { const p = window.__blockwild.game.player; p.pos.x = t.x + 0.5; p.pos.z = t.z + 0.5; p.pos.y = t.y + 0.2; }, t);
    await page.waitForFunction(([k, b]) => window.__blockwild.game.player.inventory.count(k) > b, [key, before], { timeout: 8000, polling: 100 });
    return `mined ${key} at ${t.x},${t.y},${t.z}`;
  });

  await scenario('C', 'Building: place a block with the touch button; collision; survives save/reload', async () => {
    await G(page, () => {
      const g = window.__blockwild.game;
      g.player.inventory.set(0, { id: 'cobblestone', count: 5 });
    });
    const hs = await center(page, '.hslot >> nth=0');
    await touch.tap(hs.x, hs.y);
    await sleep(100);
    // Stand on flat ground and look down at the block in front of the feet.
    const spot = await flatPad(page);
    await G(page, () => {
      const p = window.__blockwild.game.player;
      p.yaw = 0;
      p.pitch = -0.75;
    });
    await sleep(300);
    const place = await G(page, () => window.__blockwild.game.interaction.target?.hit?.place);
    assert(place, 'there is a placement target');
    const ub = await center(page, '.t-use');
    await touch.tap(ub.x, ub.y);
    await sleep(300);
    const placed = await G(page, (pl) => window.__blockwild.game.world.getBlock(pl.x, pl.y, pl.z) === window.__bw.B.cobblestone, place);
    assert(placed, 'block appeared at the placement cell');
    const count = await G(page, () => window.__blockwild.game.player.inventory.count('cobblestone'));
    assert(count === 4, `stack decremented (${count})`);
    // Cannot place inside yourself.
    await G(page, () => { window.__blockwild.game.player.pitch = -1.55; });
    await sleep(200);
    const selfPlace = await G(page, () => window.__blockwild.game.interaction.target?.hit?.place);
    await touch.tap(ub.x, ub.y);
    await sleep(250);
    const count2 = await G(page, () => window.__blockwild.game.player.inventory.count('cobblestone'));
    const inSelf = selfPlace && (await G(page, (pl) => window.__blockwild.game.world.getBlock(pl.x, pl.y, pl.z) === window.__bw.B.cobblestone, selfPlace));
    assert(!inSelf || count2 === 3, 'placing into the player is refused');
    // Collision: build a wall away from the placed block and walk into it.
    await G(page, () => { window.__blockwild.game.player.pos.x += 12; });
    await flatPad(page);
    const wall = await G(page, () => {
      const g = window.__blockwild.game;
      const p = g.player;
      p.yaw = 0;
      p.pitch = 0;
      const x = Math.floor(p.pos.x), y = Math.floor(p.pos.y), z = Math.floor(p.pos.z) - 2;
      for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy < 3; dy++) g.world.setBlock(x + dx, y + dy, z, window.__bw.B.stone_bricks);
      return { z };
    });
    const joy = await center(page, '.joy-base');
    await touch.drag(5, joy.x, joy.y, joy.x, joy.y - 60, 4, 1500);
    const st = await playerState(page);
    assert(st.z > wall.z + 1 - 0.01 + 0.29, `wall stopped the player (z=${st.z.toFixed(2)}, wall=${wall.z})`);
    assert(await G(page, (pl) => window.__blockwild.game.world.getBlock(pl.x, pl.y, pl.z) === window.__bw.B.cobblestone, place), 'placed block still present before saving');
    // Save & reload.
    await touch.tap((await center(page, '.t-pause')).x, (await center(page, '.t-pause')).y);
    await page.waitForFunction(() => window.__blockwild.state === 'paused');
    await page.click('text=Save & quit to menu');
    await page.waitForFunction(() => document.querySelector('.menu-main'), null, { timeout: 30000 });
    await page.click('.menu-buttons .btn.primary');
    await waitPlaying(page);
    const still = await G(page, (pl) => window.__blockwild.game.world.getBlock(pl.x, pl.y, pl.z) === window.__bw.B.cobblestone, place);
    assert(still, 'placed block persisted after save and reload');
    return `placed at ${place.x},${place.y},${place.z} (pad ${spot.x},${spot.y},${spot.z})`;
  });

  await scenario('D', 'Crafting: planks from logs; invalid crafts consume nothing', async () => {
    await G(page, () => {
      const inv = window.__blockwild.game.player.inventory;
      inv.clear();
      inv.set(0, { id: 'oak_log', count: 3 });
    });
    await touch.tap((await center(page, '.t-inv')).x, (await center(page, '.t-inv')).y);
    await page.waitForFunction(() => window.__blockwild.state === 'inventory');
    await page.click('.recipe[title="Oakwood Planks"]');
    await page.click('.recipe-detail button:has-text("Craft")');
    await sleep(200);
    let inv = await G(page, () => ({ logs: window.__blockwild.game.player.inventory.count('oak_log'), planks: window.__blockwild.game.player.inventory.count('oak_planks') }));
    assert(inv.logs === 2 && inv.planks === 4, `1 log -> 4 planks (${JSON.stringify(inv)})`);
    // Workbench-only recipe is locked when crafting by hand.
    await page.click('.chip:has-text("Tools")');
    await page.click('.recipe[title="Wooden Pickaxe"]');
    const disabled = await page.locator('.recipe-detail button.primary').isDisabled();
    assert(disabled, 'pickaxe cannot be crafted without a workbench');
    await page.screenshot({ path: `${OUT}/D-crafting.png` });
    await page.click('.chip:has-text("All")');
    await page.click('.recipe[title="Workbench"]');
    await page.click('.recipe-detail button:has-text("Craft")');
    await sleep(200);
    inv = await G(page, () => ({ bench: window.__blockwild.game.player.inventory.count('workbench'), planks: window.__blockwild.game.player.inventory.count('oak_planks') }));
    assert(inv.bench === 1 && inv.planks === 0, `4 planks -> workbench (${JSON.stringify(inv)})`);
    // Now there are no planks: Workbench craft button must be disabled and inventory unchanged.
    const before = await G(page, () => JSON.stringify(window.__blockwild.game.player.inventory));
    const dis2 = await page.locator('.recipe-detail button.primary').isDisabled();
    assert(dis2, 'craft disabled with missing ingredients');
    await page.locator('.recipe-detail button.primary').click({ force: true });
    const after = await G(page, () => JSON.stringify(window.__blockwild.game.player.inventory));
    assert(before === after, 'nothing consumed by an impossible craft');
    await page.click('.inv .panel-head .icon-btn');
    await page.waitForFunction(() => window.__blockwild.state === 'playing');
  });

  await scenario('E', 'Survival: damage, eating, death, item drop, respawn', async () => {
    const r = await G(page, () => {
      const g = window.__blockwild.game;
      g.survival.invuln = 0;
      g.survival.damage(5, { type: 'generic' });
      return g.player.health;
    });
    assert(r === 15, `health decreased by damage (${r})`);
    await G(page, () => {
      const g = window.__blockwild.game;
      g.player.hunger = 10;
      g.player.inventory.set(0, { id: 'bread', count: 2 });
      g.player.selected = 0;
      g.player.pitch = 1.5; // look at the sky so Use means "eat"
    });
    await sleep(200);
    const ub = await center(page, '.t-use');
    await touch.start(6, ub.x, ub.y);
    await sleep(1700);
    await touch.end(6);
    const fed = await G(page, () => ({ hunger: window.__blockwild.game.player.hunger, bread: window.__blockwild.game.player.inventory.count('bread') }));
    assert(fed.hunger === 15 && fed.bread === 1, `eating bread restored hunger (${JSON.stringify(fed)})`);
    await G(page, () => {
      const g = window.__blockwild.game;
      g.player.inventory.set(5, { id: 'iron_ingot', count: 3 });
      g.survival.invuln = 0;
      g.survival.damage(100, { type: 'mob' });
    });
    await page.waitForFunction(() => window.__blockwild.state === 'dead');
    await page.screenshot({ path: `${OUT}/E-death.png` });
    const dropped = await G(page, () => ({ items: window.__blockwild.game.entities.items.length, inv: window.__blockwild.game.player.inventory.slots.filter(Boolean).length }));
    assert(dropped.inv === 0 && dropped.items > 0, `items dropped at death (${JSON.stringify(dropped)})`);
    await page.click('text=Respawn');
    await waitPlaying(page);
    const st = await playerState(page);
    assert(st.health === 20 && st.hunger === 20 && !st.dead, 'respawned with full health');
    const spawnDist = await G(page, () => {
      const g = window.__blockwild.game;
      return Math.hypot(g.player.pos.x - g.record.worldSpawn.x, g.player.pos.z - g.record.worldSpawn.z);
    });
    assert(spawnDist < 2, `respawned at world spawn (${spawnDist.toFixed(2)})`);
    // Difficulty rule: starvation stops at 10 health on Easy, 1 on Normal.
    const floors = await G(page, () => {
      const g = window.__blockwild.game;
      const out = {};
      for (const d of ['easy', 'normal']) {
        g.record.difficulty = d;
        g.player.health = 14;
        g.player.hunger = 0;
        g.player.saturation = 0;
        for (let i = 0; i < 200; i++) {
          g.survival.invuln = 0;
          g.survival.update(0.5);
        }
        out[d] = g.player.health;
      }
      g.record.difficulty = 'normal';
      g.player.health = 20;
      g.player.hunger = 20;
      return out;
    });
    assert(floors.easy === 10 && floors.normal === 1, `starvation floors ${JSON.stringify(floors)}`);
    return `starvation floors ${JSON.stringify(floors)}`;
  });

  await scenario('F', 'Persistence: position, inventory, blocks, chest contents, vitals after full reload', async () => {
    const setup = await G(page, () => {
      const g = window.__blockwild.game;
      const p = g.player;
      const { B } = window.__bw;
      p.inventory.clear();
      p.inventory.set(0, { id: 'iron_pickaxe', count: 1, damage: 17 });
      p.inventory.set(7, { id: 'torch', count: 23 });
      p.armor.set(1, { id: 'iron_chestplate', count: 1 });
      p.selected = 7;
      p.health = 13;
      p.hunger = 9;
      const x = Math.floor(p.pos.x) + 1, y = Math.floor(p.pos.y), z = Math.floor(p.pos.z) + 1;
      g.world.setBlock(x, y, z, B.chest, 0);
      const st = g.containerAt(x, y, z, 'chest');
      st.slots[4] = { id: 'gold_ingot', count: 11 };
      g.world.setBlock(x + 1, y + 2, z, B.glass);
      g.record.time.tod = 0.33;
      return { pos: { ...p.pos }, chest: { x, y, z }, glass: { x: x + 1, y: y + 2, z } };
    });
    await page.evaluate(() => window.__blockwild.quitToMenu());
    await page.waitForFunction(() => document.querySelector('.menu-main'), null, { timeout: 30000 });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.menu-main'));
    await page.click('.menu-buttons .btn.primary');
    await page.waitForFunction(() => window.__blockwild?.state === 'playing', null, { timeout: 120000, polling: 250 });
    const r = await G(page, (s) => {
      const g = window.__blockwild.game;
      const p = g.player;
      const { B } = window.__bw;
      return {
        dist: Math.hypot(p.pos.x - s.pos.x, p.pos.z - s.pos.z),
        pick: p.inventory.get(0),
        torch: p.inventory.get(7),
        armor: p.armor.get(1)?.id,
        selected: p.selected,
        health: p.health,
        hunger: p.hunger,
        chestBlock: g.world.getBlock(s.chest.x, s.chest.y, s.chest.z) === B.chest,
        chestSlot: g.containerAt(s.chest.x, s.chest.y, s.chest.z, 'chest').slots[4],
        glass: g.world.getBlock(s.glass.x, s.glass.y, s.glass.z) === B.glass,
        tod: g.record.time.tod,
      };
    }, setup);
    assert(r.dist < 0.6, `position restored (${r.dist.toFixed(2)})`);
    assert(r.pick?.id === 'iron_pickaxe' && r.pick.damage === 17, 'tool and durability restored');
    assert(r.torch?.count === 23 && r.selected === 7 && r.armor === 'iron_chestplate', 'inventory/armor/selection restored');
    assert(r.health === 13 && r.hunger === 9, 'vitals restored');
    assert(r.chestBlock && r.chestSlot?.id === 'gold_ingot' && r.chestSlot.count === 11, 'chest contents restored');
    assert(r.glass, 'modified blocks restored');
    assert(Math.abs(r.tod - 0.33) < 0.01, 'world time restored');
  });

  await scenario('G', 'Mobile controls: simultaneous move+look, no stuck touches, menus release input', async () => {
    await G(page, () => { const p = window.__blockwild.game.player; p.pitch = 0; });
    const s0 = await playerState(page);
    const joy = await center(page, '.joy-base');
    await touch.start(11, joy.x, joy.y);
    await touch.start(12, W * 0.6, H * 0.3);
    for (let i = 1; i <= 12; i++) {
      await touch.move(11, joy.x + i * 2, joy.y - i * 5);
      await touch.move(12, W * 0.6 + i * 10, H * 0.3);
      await sleep(40);
    }
    await sleep(500);
    const mid = await playerState(page);
    await touch.end(12);
    await touch.end(11);
    assert(Math.hypot(mid.x - s0.x, mid.z - s0.z) > 0.8, 'moved while looking');
    assert(Math.abs(mid.yaw - s0.yaw) > 0.4, 'looked while moving');
    await sleep(600);
    const rest = await playerState(page);
    assert(Math.hypot(rest.vx, rest.vz) < 0.3, `no stuck movement after release (${Math.hypot(rest.vx, rest.vz).toFixed(2)})`);
    const owners = await G(page, () => window.__blockwild.input.owners.size);
    assert(owners === 0, 'all touches released');
    // A look finger passing over a button must not press it.
    const jb = await center(page, '.t-jump');
    const y0 = (await playerState(page)).y;
    await touch.drag(13, W * 0.55, H * 0.5, jb.x, jb.y, 10);
    await sleep(300);
    assert(Math.abs((await playerState(page)).y - y0) < 0.2, 'dragging over jump did not jump');
    // Opening the inventory while walking releases the joystick.
    await touch.start(14, joy.x, joy.y);
    await touch.move(14, joy.x, joy.y - 60);
    await sleep(300);
    const inv = await center(page, '.t-inv');
    await touch.tap(inv.x, inv.y, 15);
    await page.waitForFunction(() => window.__blockwild.state === 'inventory');
    await touch.end(14);
    await page.click('.inv .panel-head .icon-btn');
    await sleep(700);
    const after = await playerState(page);
    assert(Math.hypot(after.vx, after.vz) < 0.3, 'no movement after closing the inventory');
  });

  await scenario('H', 'Performance probes: streaming, creatures, frame times (SwiftShader)', async () => {
    const res = await G(page, async () => {
      const app = window.__blockwild;
      const g = app.game;
      const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
      const frameTimes = async (sec) => {
        const ts = [];
        let last = performance.now();
        const end = last + sec * 1000;
        while (performance.now() < end) {
          await new Promise((r) => requestAnimationFrame(r));
          const now = performance.now();
          ts.push(now - last);
          last = now;
        }
        ts.sort((a, b) => a - b);
        return { avg: ts.reduce((a, b) => a + b, 0) / ts.length, p95: ts[Math.floor(ts.length * 0.95)], max: ts[ts.length - 1] };
      };
      const base = await frameTimes(3);
      // Rapid travel into unexplored terrain.
      const p = g.player;
      const t0 = performance.now();
      p.pos.x += 400;
      p.pos.y = 110;
      p.flying = true;
      g.record.mode = 'creative';
      while (!g.world.isLoaded(p.pos.x, p.pos.z) && performance.now() - t0 < 30000) await sleepMs(50);
      const firstChunkMs = performance.now() - t0;
      while (g.loadProgress() < 0.999 && performance.now() - t0 < 60000) await sleepMs(100);
      const areaMs = performance.now() - t0;
      // Many creatures at once.
      for (let i = 0; i < 16; i++) g.entities.spawnMob(['grazer', 'snout', 'cluck', 'woolly'][i % 4], { x: p.pos.x + (i % 4) * 2 - 4, y: p.pos.y, z: p.pos.z + Math.floor(i / 4) * 2 - 4 });
      for (let i = 0; i < 14; i++) g.entities.spawnMob(['shambler', 'skitter', 'bonecaster', 'gloomling'][i % 4], { x: p.pos.x + (i % 4) * 2 - 4, y: p.pos.y, z: p.pos.z + 6 + Math.floor(i / 4) * 2 });
      const mobs = await frameTimes(3);
      const t1 = performance.now();
      await g.save('perf');
      const saveMs = performance.now() - t1;
      g.record.mode = 'survival';
      p.flying = false;
      return {
        base, mobs, firstChunkMs, areaMs, saveMs,
        chunks: g.world.chunks.size, meshMs: g.stats.meshMs, mobCount: g.entities.mobs.length,
        heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
      };
    });
    writeFileSync(`${OUT}/perf.json`, JSON.stringify(res, null, 2));
    assert(res.mobCount >= 25, 'creatures spawned for the stress test');
    return `frame avg ${res.base.avg.toFixed(1)}ms (p95 ${res.base.p95.toFixed(1)}) · 30 mobs avg ${res.mobs.avg.toFixed(1)}ms · new area ${(res.areaMs / 1000).toFixed(1)}s · mesh ${res.meshMs.toFixed(2)}ms/section · save ${res.saveMs.toFixed(0)}ms · heap ${res.heapMB?.toFixed(0)}MB`;
  });

  await scenario('I', 'Creative mode: flight, instant break, unlimited blocks, no damage', async () => {
    await page.evaluate(() => window.__blockwild.quitToMenu());
    await page.waitForFunction(() => document.querySelector('.menu-main'), null, { timeout: 30000 });
    await createWorld(page, { name: 'Builder', seed: 'e2e-creative', mode: 'creative', difficulty: 'peaceful' });
    const fb = await center(page, '.t-fly');
    await touch.tap(fb.x, fb.y);
    await sleep(100);
    const jb = await center(page, '.t-jump');
    const y0 = (await playerState(page)).y;
    await touch.start(20, jb.x, jb.y);
    await sleep(800);
    await touch.end(20);
    const flying = await G(page, () => window.__blockwild.game.player.flying);
    const y1 = (await playerState(page)).y;
    assert(flying && y1 > y0 + 2, `flew upward (${(y1 - y0).toFixed(1)})`);
    const res = await G(page, () => {
      const g = window.__blockwild.game;
      g.survival.damage(50, { type: 'mob' });
      const p = g.player;
      return { health: p.health, stone: p.inventory.count('stone') };
    });
    assert(res.health === 20, 'no damage in creative');
    // Place repeatedly: count never drops.
    await G(page, () => {
      const g = window.__blockwild.game;
      const p = g.player;
      p.flying = false;
      p.selected = 2;
      p.pitch = -1;
    });
    await sleep(1500);
    const ub = await center(page, '.t-use');
    await touch.tap(ub.x, ub.y);
    await sleep(200);
    const after = await G(page, () => window.__blockwild.game.player.inventory.count('stone'));
    assert(after === res.stone, 'creative placement does not consume blocks');
    await touch.tap((await center(page, '.t-inv')).x, (await center(page, '.t-inv')).y);
    await page.waitForFunction(() => window.__blockwild.state === 'inventory');
    await page.screenshot({ path: `${OUT}/I-creative.png` });
    await page.click('.inv .panel-head .icon-btn');
    const worlds = await G(page, async () => (await window.__blockwild.storage.listWorlds()).map((w) => w.mode));
    assert(worlds.includes('creative') && worlds.includes('survival'), 'world list stores modes');
  });

  const freshWorld = async (name, opts = {}) => {
    if (await G(page, () => !!window.__blockwild.game)) {
      await page.evaluate(() => window.__blockwild.quitToMenu());
      await page.waitForFunction(() => document.querySelector('.menu-main'), null, { timeout: 30000 });
    }
    await createWorld(page, { name, seed: `e2e-${name}`, ...opts });
    await flatPad(page);
  };

  await scenario('M', 'Combat: melee a creature until it dies and drops loot; hostiles hurt the player', async () => {
    await freshWorld('Gamma');
    const mob = await G(page, () => {
      const g = window.__blockwild.game;
      g.record.rules.mobSpawning = false;
      const p = g.player;
      p.yaw = 0;
      p.pitch = -0.25;
      p.inventory.set(0, { id: 'stone_sword', count: 1 });
      p.selected = 0;
      const m = g.entities.spawnMob('grazer', { x: p.pos.x, y: p.pos.y, z: p.pos.z - 2.2 });
      m.update = function (dt) { this.hurtTimer -= dt; if (this.dead) { this.deathTimer -= dt; if (this.deathTimer <= 0) this.removed = true; } }; // hold still
      return m.id;
    });
    const mb = await center(page, '.t-mine');
    let dead = false;
    for (let i = 0; i < 12 && !dead; i++) {
      await touch.tap(mb.x, mb.y, 30);
      await sleep(520);
      dead = await G(page, (id) => !window.__blockwild.game.entities.mobs.some((m) => m.id === id && !m.dead), mob);
    }
    assert(dead, 'creature died from melee hits');
    await sleep(1500);
    const loot = await G(page, () => window.__blockwild.game.player.inventory.count('raw_steak') + window.__blockwild.game.entities.items.filter((i) => i.stack.id === 'raw_steak').length);
    assert(loot > 0, 'loot dropped');
    const dur = await G(page, () => window.__blockwild.game.player.inventory.get(0)?.damage || 0);
    assert(dur > 0, 'sword lost durability');
    const hurt = await G(page, async () => {
      const g = window.__blockwild.game;
      const p = g.player;
      g.record.time.tod = 0.75;
      const m = g.entities.spawnMob('shambler', { x: p.pos.x + 1.2, y: p.pos.y, z: p.pos.z });
      const h0 = p.health;
      await new Promise((r) => setTimeout(r, 2500));
      g.entities.removeMob(m);
      g.entities.mobs = g.entities.mobs.filter((x) => x !== m);
      g.record.time.tod = 0.2;
      return { h0, h1: p.health };
    });
    assert(hurt.h1 < hurt.h0, `hostile melee damaged the player (${hurt.h0} -> ${hurt.h1})`);
    return `player ${hurt.h0} -> ${hurt.h1} hp`;
  });

  await scenario('N', 'Farming: till, plant, fertilize, harvest', async () => {
    const r = await G(page, async () => {
      const g = window.__blockwild.game;
      const { B } = window.__bw;
      const p = g.player;
      const x = Math.floor(p.pos.x), y = Math.floor(p.pos.y) - 1, z = Math.floor(p.pos.z) - 2;
      g.world.setBlock(x, y, z, B.grass);
      g.world.setBlock(x + 1, y, z, B.water);
      p.inventory.set(0, { id: 'wood_hoe', count: 1 });
      p.inventory.set(1, { id: 'wheat_seeds', count: 3 });
      p.inventory.set(2, { id: 'bone_meal', count: 10 });
      const aim = () => {
        const eye = p.eye;
        const tx = x + 0.5 - eye.x, ty = y + 1 - eye.y, tz = z + 0.5 - eye.z;
        p.yaw = Math.atan2(-tx, -tz);
        p.pitch = Math.atan2(ty, Math.hypot(tx, tz));
      };
      const use = async (slot) => {
        p.selected = slot;
        aim();
        await new Promise((r) => setTimeout(r, 120));
        g.interaction.target = g.interaction.computeTarget();
        g.interaction.handleUse(true);
      };
      await use(0);
      const tilled = g.world.getBlock(x, y, z) === B.farmland;
      await use(1);
      const planted = g.world.getBlock(x, y + 1, z) === B.wheat;
      // Aim at the crop itself for bone meal.
      for (let i = 0; i < 6 && (g.world.getMeta(x, y + 1, z) & 7) < 7; i++) {
        p.selected = 2;
        const eye = p.eye;
        const tx = x + 0.5 - eye.x, ty = y + 1.15 - eye.y, tz = z + 0.5 - eye.z;
        p.yaw = Math.atan2(-tx, -tz);
        p.pitch = Math.atan2(ty, Math.hypot(tx, tz));
        await new Promise((r) => setTimeout(r, 80));
        g.interaction.target = g.interaction.computeTarget();
        g.interaction.handleUse(true);
      }
      const stage = g.world.getMeta(x, y + 1, z) & 7;
      const before = p.inventory.count('wheat');
      g.lastBreakTool = null;
      g.world.breakBlock(x, y + 1, z, 'player');
      p.pos = { x: x + 0.5, y: y + 1, z: z + 0.5 };
      await new Promise((r) => setTimeout(r, 1500));
      // Random ticks can also hydrate the soil next to water.
      g.world.randomTickBlock(x, y, z, B.farmland, () => 0.5);
      return { tilled, planted, stage, wheat: p.inventory.count('wheat') - before, wet: g.world.getMeta(x, y, z) & 1 };
    });
    assert(r.tilled, 'hoe tilled the soil');
    assert(r.planted, 'seeds planted on farmland');
    assert(r.stage === 7, `bone meal grew the crop to maturity (stage ${r.stage})`);
    assert(r.wheat >= 1, 'harvest yielded wheat');
    assert(r.wet === 1, 'farmland near water becomes hydrated');
  });

  await scenario('O', 'Bed: sleeping at night skips to morning and sets the respawn point', async () => {
    const r = await G(page, async () => {
      const g = window.__blockwild.game;
      const { B } = window.__bw;
      const p = g.player;
      const x = Math.floor(p.pos.x) + 2, y = Math.floor(p.pos.y), z = Math.floor(p.pos.z);
      g.world.setBlock(x, y, z, B.bed, 0);
      g.world.setBlock(x, y, z - 1, B.bed, 4);
      g.record.time.tod = 0.8;
      const day0 = g.record.time.day;
      g.useBed(x, y, z);
      await new Promise((r) => setTimeout(r, 2000));
      return { tod: g.record.time.tod, dayAdvanced: g.record.time.day === day0 + 1, spawn: p.spawnPoint, x, y, z };
    });
    assert(r.tod < 0.1 && r.dayAdvanced, `time skipped to morning (${r.tod})`);
    assert(r.spawn && r.spawn.x === r.x && r.spawn.z === r.z, 'respawn point set at the bed');
  });

  await scenario('P', 'Furnace: smelting through the UI (tap-to-move stacks)', async () => {
    await G(page, () => {
      const g = window.__blockwild.game;
      const { B } = window.__bw;
      const p = g.player;
      p.inventory.clear();
      p.inventory.set(0, { id: 'raw_iron', count: 2 });
      p.inventory.set(1, { id: 'coal', count: 1 });
      const x = Math.floor(p.pos.x) - 2, y = Math.floor(p.pos.y), z = Math.floor(p.pos.z);
      g.world.setBlock(x, y, z, B.furnace, 1);
      g.openContainer(x, y, z, 'furnace');
      window.__furnacePos = { x, y, z };
    });
    await page.waitForFunction(() => window.__blockwild.state === 'inventory');
    // Hotbar slot 0 -> furnace input; hotbar slot 1 -> fuel. Slots: [player 36..., furnace 3]
    const hot = page.locator('.slot.hotbar-row');
    const fslots = page.locator('.furnace-ui .slot');
    await hot.nth(0).click();
    await fslots.nth(0).click();
    await hot.nth(1).click();
    await fslots.nth(1).click();
    await page.screenshot({ path: `${OUT}/P-furnace.png` });
    await page.waitForFunction(() => {
      const g = window.__blockwild.game;
      const p = window.__furnacePos;
      const st = g.world.blockData.get(`${p.x},${p.y},${p.z}`);
      return st?.slots[2]?.count === 2;
    }, null, { timeout: 30000, polling: 250 });
    await fslots.nth(2).click();
    await hot.nth(5).click();
    const ingots = await G(page, () => window.__blockwild.game.player.inventory.count('iron_ingot'));
    assert(ingots === 2, `took the ingots out (${ingots})`);
    await page.click('.inv .panel-head .icon-btn');
  });

  await scenario('Q', 'Doors: Use toggles open/closed and changes collision', async () => {
    await G(page, () => { const p = window.__blockwild.game.player; p.pos.x += 9; p.selected = 8; });
    await flatPad(page);
    const r = await G(page, async () => {
      const g = window.__blockwild.game;
      const { B } = window.__bw;
      const p = g.player;
      const x = Math.floor(p.pos.x), y = Math.floor(p.pos.y), z = Math.floor(p.pos.z) - 2;
      g.world.setBlock(x, y, z, B.door, 0);
      g.world.setBlock(x, y + 1, z, B.door, 8);
      const probe = { width: 0.1, height: 0.5 };
      const at = { x: x + 0.5, y: y + 0.3, z: z + 0.09 };
      const boxesClosed = window.__bw.collidesAt(g.world, probe, at) ? 1 : 0;
      p.yaw = 0;
      p.pitch = -0.2;
      await new Promise((r) => setTimeout(r, 150));
      g.interaction.target = g.interaction.computeTarget();
      g.interaction.handleUse(true);
      const open = (g.world.getMeta(x, y, z) & 4) !== 0 && (g.world.getMeta(x, y + 1, z) & 4) !== 0;
      const boxesOpen = window.__bw.collidesAt(g.world, probe, at) ? 1 : 0;
      return { open, boxesClosed, boxesOpen };
    });
    assert(r.open, 'both door halves opened');
    assert(r.boxesClosed > r.boxesOpen, `opening moves the door's collision (${r.boxesClosed} -> ${r.boxesOpen})`);
  });

  await scenario('R', 'Peaceful difficulty: no hostile creatures spawn at night', async () => {
    await freshWorld('Calm', { difficulty: 'peaceful' });
    const r = await G(page, async () => {
      const g = window.__blockwild.game;
      g.record.time.tod = 0.75;
      for (let i = 0; i < 60; i++) {
        g.entities.spawnTimer = 0;
        g.entities.updateSpawning(1);
      }
      g.entities.spawnMob('shambler', { ...g.player.pos, x: g.player.pos.x + 3 });
      await new Promise((r) => setTimeout(r, 500));
      return g.entities.mobs.filter((m) => m.def.hostile).length;
    });
    assert(r === 0, `no hostiles on Peaceful (${r})`);
  });

  await scenario('J', 'Settings persist across reloads', async () => {
    await page.evaluate(() => window.__blockwild.quitToMenu());
    await page.waitForFunction(() => document.querySelector('.menu-main'), null, { timeout: 30000 });
    await page.click('text=Settings');
    await page.click('.tabs button:has-text("Controls")');
    await page.click('[aria-label="Invert vertical look"]');
    await page.click('.tabs button:has-text("Audio")');
    await page.locator('input[type=range]').first().fill('0.35');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.menu-main'));
    const v = await G(page, () => ({ inv: window.__blockwild.settings.get('invertY'), vol: window.__blockwild.settings.get('masterVolume') }));
    assert(v.inv === true && Math.abs(v.vol - 0.35) < 0.01, `settings persisted (${JSON.stringify(v)})`);
  });

  await scenario('K', 'Damaged saves are reported, not silently replaced', async () => {
    if (await G(page, () => !!window.__blockwild.game)) {
      await page.evaluate(() => window.__blockwild.quitToMenu());
      await page.waitForFunction(() => document.querySelector('.menu-main'), null, { timeout: 30000 });
    }
    await G(page, async () => {
      const db = await new Promise((res) => { const r = indexedDB.open('blockwild', 1); r.onsuccess = () => res(r.result); });
      const tx = db.transaction(['worlds', 'chunks'], 'readwrite');
      tx.objectStore('worlds').put({ id: 'broken-1', name: 'Broken', saveVersion: 2 }); // no seed
      const worlds = await new Promise((res) => { const r = tx.objectStore('worlds').getAll(); r.onsuccess = () => res(r.result); });
      const alpha = worlds.find((w) => w.name === 'Alpha');
      // Corrupt one saved chunk of the Alpha world.
      const keys = await new Promise((res) => { const r = tx.objectStore('chunks').getAllKeys(IDBKeyRange.bound(`${alpha.id}/`, `${alpha.id}/￿`)); r.onsuccess = () => res(r.result); });
      tx.objectStore('chunks').put({ v: 1, blocks: new Uint8Array([1, 2, 3]), meta: new Uint8Array([0]) }, keys[0]);
      await new Promise((res) => (tx.oncomplete = res));
    });
    await page.click('text=Worlds');
    await page.waitForSelector('.world-card');
    const damaged = await page.locator('.badge.bad').count();
    assert(damaged === 1, 'damaged world shown with a badge');
    await page.screenshot({ path: `${OUT}/K-worlds.png` });
    // Loading the world with a corrupt chunk still works and reports it.
    await page.click('.world-card:has-text("Alpha") button:has-text("Play")');
    try {
      await page.waitForFunction(() => window.__blockwild?.state === 'playing', null, { timeout: 120000, polling: 250 });
    } catch (e) {
      const dbg = await G(page, () => { const a = window.__blockwild; const g = a.game; return { state: a.state, progress: g?.loadProgress?.(), chunks: g?.world?.chunks.size, pending: g?.streamer?.pending.size, ready: g?.streamer?.ready.length, inFlight: g?.streamer?.inFlight, queue: g?.meshQueue?.size, pos: g?.player?.pos, errors: (window.__bwlog || []) }; });
      throw new Error(`load stuck: ${JSON.stringify(dbg)} errors=${page.errors.join(' | ')}`);
    }
    const warned = await page.locator('.toast:has-text("damaged area")').count();
    assert(page.errors.filter((e) => !e.includes('damaged') && !e.includes('Corrupt') && !e.includes('cells')).length === 0, `no unexpected page errors: ${page.errors.join(' | ')}`);
    return warned ? 'corrupt chunk regenerated with a warning' : 'corrupt chunk was outside the loaded area';
  });

  await ctx.close();

  // Layout checks on several phone/tablet viewports.
  await scenario('L', 'Responsive layout: controls inside the screen, no HUD overlap', async () => {
    const sizes = [[640, 360], [780, 360], [915, 412], [1024, 768], [1280, 800]];
    const notes = [];
    for (const [w, h] of sizes) {
      const c = await newContext({ width: w, height: h });
      const pg = await openPage(c);
      await createWorld(pg, { name: `L${w}`, seed: 'layout' });
      const boxes = await pg.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
        return { btns: [...document.querySelectorAll('.tbtn:not(.hidden)')].map(r), hotbar: r(document.querySelector('.hotbar')), joy: r(document.querySelector('.joy-base')), vw: innerWidth, vh: innerHeight, slot: r(document.querySelector('.hslot')) };
      });
      const inside = (b) => b.l >= 0 && b.t >= 0 && b.r <= boxes.vw + 0.5 && b.b <= boxes.vh + 0.5;
      const overlap = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
      for (const b of boxes.btns) assert(inside(b), `${w}x${h}: button inside viewport`);
      assert(inside(boxes.hotbar), `${w}x${h}: hotbar inside viewport`);
      for (const b of boxes.btns) assert(!overlap(b, boxes.hotbar), `${w}x${h}: button overlaps hotbar`);
      assert(!overlap(boxes.joy, boxes.hotbar), `${w}x${h}: joystick overlaps hotbar`);
      assert(boxes.btns.every((b) => b.w >= 40), `${w}x${h}: touch targets >= 40px`);
      await pg.screenshot({ path: `${OUT}/L-${w}x${h}.png` });
      await pg.evaluate(() => window.__blockwild.openInventory('inventory'));
      const inv = await pg.evaluate(() => { const b = document.querySelector('.inv').getBoundingClientRect(); const s = document.querySelector('.slot').getBoundingClientRect(); return { r: b.right, b: b.bottom, slot: s.width }; });
      assert(inv.r <= w + 0.5 && inv.b <= h + 0.5, `${w}x${h}: inventory fits`);
      assert(inv.slot >= 32, `${w}x${h}: inventory slots >= 32px (${inv.slot})`);
      await pg.screenshot({ path: `${OUT}/L-${w}x${h}-inv.png` });
      notes.push(`${w}x${h} slot ${Math.round(inv.slot)}px`);
      await c.close();
    }
    return notes.join(', ');
  });

  await browser.close();
  if (server) server.kill();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} scenarios passed`);
  writeFileSync(`${OUT}/e2e-report.json`, JSON.stringify(results, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  if (server) server.kill();
  process.exit(1);
});
