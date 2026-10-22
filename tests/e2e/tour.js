// Dev tool: visual tour screenshots of features (creatures, structures, caves, weather, UI).
import { chromium } from 'playwright';
const OUT = process.argv[2] || 'test-results/tour';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 900, height: 420 }, hasTouch: true });
await ctx.addInitScript(() => localStorage.setItem('blockwild.settings.v1', JSON.stringify({ controlsMode: 'touch', renderDistance: 4, quality: 'custom', tutorialDone: true, adaptiveQuality: false })));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(process.env.BW_URL || 'http://localhost:5173/');
await page.waitForFunction(() => document.querySelector('.menu-main'));
await page.click('text=New World');
await page.fill('.form input.text-input >> nth=1', process.env.SEED || 'tour-7');
await page.click('text=Create & Play');
await page.waitForFunction(() => window.__blockwild?.state === 'playing', null, { timeout: 90000 });
const shot = async (name, wait = 1500) => { await page.waitForTimeout(wait); await page.screenshot({ path: `${OUT}/${name}.png` }); };
const settle = () => page.waitForFunction(() => window.__blockwild.game.loadProgress() >= 0.999, null, { timeout: 90000, polling: 200 });
// 1. Creatures in daylight
await page.evaluate(() => {
  const g = window.__blockwild.game; const p = g.player;
  p.yaw = 0; p.pitch = -0.15;
  const types = ['grazer', 'snout', 'cluck', 'woolly'];
  types.forEach((t, i) => { const x = p.pos.x - 3 + i * 2, z = p.pos.z - 5; let y = 120; while (y > 1 && !window.__bw.BLOCKS[g.world.getBlock(Math.floor(x), y - 1, Math.floor(z))].solid) y--; g.entities.spawnMob(t, { x, y, z }); });
  g.record.rules.mobSpawning = false;
});
await shot('01-animals', 2500);
// 2. Hostiles at night with a torch
await page.evaluate(() => {
  const g = window.__blockwild.game; const p = g.player;
  for (const m of g.entities.mobs) g.entities.removeMob(m); g.entities.mobs = [];
  g.record.time.tod = 0.8; g.record.mode = 'creative';
  const types = ['shambler', 'skitter', 'bonecaster', 'gloomling'];
  types.forEach((t, i) => { const x = p.pos.x - 3 + i * 2, z = p.pos.z - 5; let y = 120; while (y > 1 && !window.__bw.BLOCKS[g.world.getBlock(Math.floor(x), y - 1, Math.floor(z))].solid) y--; const m = g.entities.spawnMob(t, { x, y, z }); m.update = () => {}; });
  const x = Math.floor(p.pos.x) + 1, z = Math.floor(p.pos.z) - 3; let y = 120; while (y > 1 && !window.__bw.BLOCKS[g.world.getBlock(x, y - 1, z)].solid) y--; g.world.setBlock(x, y, z, window.__bw.B.torch, 0);
});
await shot('02-hostiles-night', 2500);
// 3. Nearest surface structure
const st = await page.evaluate(() => {
  const g = window.__blockwild.game; const p = g.player; g.record.time.tod = 0.2;
  for (const m of g.entities.mobs) g.entities.removeMob(m); g.entities.mobs = [];
  const list = window.__bw.structuresIn(g.world.generator, p.pos.x - 400, p.pos.z - 400, p.pos.x + 400, p.pos.z + 400).filter((s) => !s.under);
  list.sort((a, b) => Math.hypot(a.x - p.pos.x, a.z - p.pos.z) - Math.hypot(b.x - p.pos.x, b.z - p.pos.z));
  const s = list[0]; if (!s) return null;
  p.flying = true; p.pos = { x: s.x + s.sx / 2 + 7, y: s.y + 6, z: s.z + s.sz + 7 }; p.yaw = Math.atan2(7, 7); p.pitch = -0.35;
  return { type: s.type, x: s.x, y: s.y, z: s.z, all: list.slice(0, 6).map((q) => q.type) };
});
console.log('structure', JSON.stringify(st));
await settle(); await shot('03-structure', 1500);
// 4. Underground: dungeon or geode
const ug = await page.evaluate(() => {
  const g = window.__blockwild.game; const p = g.player;
  const list = window.__bw.structuresIn(g.world.generator, p.pos.x - 500, p.pos.z - 500, p.pos.x + 500, p.pos.z + 500).filter((s) => s.under);
  const pick = (type) => list.filter((s) => s.type === type).sort((a, b) => Math.hypot(a.x - p.pos.x, a.z - p.pos.z) - Math.hypot(b.x - p.pos.x, b.z - p.pos.z))[0];
  const d = pick('dungeon'), geo = pick('geode');
  window.__tourTargets = { d, geo };
  if (d) { p.pos = { x: d.x + 2.5, y: d.y + 1, z: d.z + 6.5 }; p.yaw = Math.PI * 0.75; p.pitch = -0.1; p.flying = false; }
  return { d: d && [d.x, d.y, d.z], geo: geo && [geo.x, geo.y, geo.z] };
});
console.log('underground', JSON.stringify(ug));
await settle(); await shot('04-dungeon', 1500);
await page.evaluate(() => { const g = window.__blockwild.game; const p = g.player; const geo = window.__tourTargets.geo; if (geo) { p.pos = { x: geo.x + 6.5, y: geo.y + 5, z: geo.z + 6.5 }; p.flying = true; p.yaw = 0.3; p.pitch = -0.4; } });
await settle(); await shot('05-geode', 1500);
// 6. Cave with torch light
await page.evaluate(() => {
  const g = window.__blockwild.game; const p = g.player; const w = g.world; const { B, BLOCKS } = window.__bw;
  const x0 = Math.floor(p.pos.x), z0 = Math.floor(p.pos.z);
  for (let r = 0; r < 60; r++) for (let dx = -r; dx <= r; dx++) for (const dz of [-r, r]) for (let y = 15; y < 45; y++) {
    const x = x0 + dx, z = z0 + dz;
    if (w.getBlock(x, y, z) === B.air && w.getBlock(x, y + 1, z) === B.air && w.getBlock(x, y + 2, z) === B.air && BLOCKS[w.getBlock(x, y - 1, z)].solid && w.getLight(x, y, z)[0] === 0) {
      p.pos = { x: x + 0.5, y, z: z + 0.5 }; p.flying = false; p.pitch = -0.1;
      w.setBlock(x + 1, y, z + 1, B.torch, 0); w.setBlock(x - 2, y, z - 2, B.torch, 0);
      return;
    }
  }
});
await settle(); await shot('06-cave', 1500);
// 7. Rain and snow
await page.evaluate(() => { const g = window.__blockwild.game; const p = g.player; p.pos.y = 90; p.flying = true; p.pitch = -0.2; g.setWeather('rain'); g.rain = 1; g.record.time.tod = 0.3; });
await settle(); await shot('07-rain', 2000);
const snow = await page.evaluate(() => {
  const g = window.__blockwild.game; const p = g.player; const gen = g.world.generator;
  for (let r = 0; r < 3000; r += 40) for (let a = 0; a < 6.28; a += 0.3) { const x = Math.round(p.pos.x + Math.cos(a) * r), z = Math.round(p.pos.z + Math.sin(a) * r); if (gen.biomeAt(x, z).key === 'snowy') { p.pos = { x, y: gen.column(x, z).h + 4, z }; return [x, z]; } }
  return null;
});
console.log('snow', JSON.stringify(snow));
await settle(); await shot('08-snow', 2000);
// 9. Desert
await page.evaluate(() => {
  const g = window.__blockwild.game; const p = g.player; const gen = g.world.generator; g.setWeather('clear'); g.rain = 0;
  for (let r = 0; r < 4000; r += 40) for (let a = 0; a < 6.28; a += 0.3) { const x = Math.round(p.pos.x + Math.cos(a) * r), z = Math.round(p.pos.z + Math.sin(a) * r); if (gen.biomeAt(x, z).key === 'desert') { p.pos = { x, y: gen.column(x, z).h + 5, z }; return; } }
});
await settle(); await shot('09-desert', 1500);
// 10. Mountains
await page.evaluate(() => {
  const g = window.__blockwild.game; const p = g.player; const gen = g.world.generator;
  for (let r = 0; r < 4000; r += 40) for (let a = 0; a < 6.28; a += 0.3) { const x = Math.round(p.pos.x + Math.cos(a) * r), z = Math.round(p.pos.z + Math.sin(a) * r); const c = gen.column(x, z); if (gen.biomeAt(x, z).key === 'mountains' && c.h > 95) { p.pos = { x: x + 30, y: c.h + 5, z: z + 30 }; p.yaw = Math.atan2(30, 30); p.pitch = -0.15; return; } }
});
await settle(); await shot('10-mountains', 1500);
// UI: furnace, chest, workbench, pause
await page.evaluate(() => {
  const g = window.__blockwild.game; const p = g.player; g.record.mode = 'survival'; p.flying = false;
  p.inventory.set(0, { id: 'raw_iron', count: 8 }); p.inventory.set(1, { id: 'coal', count: 4 }); p.inventory.set(2, { id: 'iron_pickaxe', count: 1, damage: 90 });
  const x = Math.floor(p.pos.x) + 2, y = Math.floor(p.pos.y), z = Math.floor(p.pos.z);
  g.world.setBlock(x, y, z, window.__bw.B.furnace, 0);
  const st = g.containerAt(x, y, z, 'furnace'); st.slots[0] = { id: 'raw_iron', count: 5 }; st.slots[1] = { id: 'coal', count: 2 };
  g.openContainer(x, y, z, 'furnace');
});
await shot('11-furnace', 2500);
await page.evaluate(() => { window.__blockwild.closeInventory(); window.__blockwild.game.openCrafting('workbench'); });
await shot('12-workbench', 600);
await page.evaluate(() => { window.__blockwild.closeInventory(); window.__blockwild.pause(); });
await shot('13-pause', 600);
console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
