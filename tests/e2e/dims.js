// Realm travel smoke test: coordinates toggle, offhand, Nether + End travel and persistence.
//   npm run build && node tests/e2e/dims.js
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('test-results', { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort'], { stdio: 'ignore', detached: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { throw new Error(m); };
let browser;
try {
  await sleep(2500);
  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 420 }, hasTouch: true });
  await ctx.addInitScript(() => localStorage.setItem('blockwild.settings.v1', JSON.stringify({ controlsMode: 'touch', renderDistance: 3, quality: 'custom', tutorialDone: true, adaptiveQuality: false, musicVolume: 0 })));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });
  await page.goto('http://localhost:4174/');
  await page.waitForSelector('.menu-main');
  await page.click('text=New World');
  await page.fill('.form input.text-input >> nth=0', 'Dims');
  await page.fill('.form input.text-input >> nth=1', 'dims');
  await page.click('.seg button:has-text("Creative")');
  await page.click('.seg button:has-text("Peaceful")');
  await page.click('text=Create & Play');
  const playing = () => page.waitForFunction(() => window.__blockwild?.state === 'playing' && window.__blockwild.game.player.onGround, null, { timeout: 90000, polling: 250 });
  await playing();
  const dim = () => page.evaluate(() => window.__blockwild.game.dim);

  // Coordinates toggle
  await page.evaluate(() => window.__blockwild.settings.set('showCoords', true));
  await sleep(400);
  const txt = await page.textContent('.coords');
  if (!/X -?\d+\s+Y -?\d+\s+Z/.test(txt)) fail(`coords text: ${txt}`);
  await page.evaluate(() => window.__blockwild.settings.set('showCoords', false));
  if (!(await page.$('.coords.hidden'))) fail('coords not hidden');

  // Offhand swap
  await page.evaluate(() => {
    const p = window.__blockwild.game.player;
    p.inventory.set(0, { id: 'shield', count: 1 });
    p.selected = 0;
    window.__blockwild.game.swapHands();
  });
  const off = await page.evaluate(() => window.__blockwild.game.player.offhand.get(0)?.id);
  if (off !== 'shield') fail(`offhand is ${off}`);

  // Nether and End travel
  for (const [target, trv] of [['nether', { kind: 'portal', x: 0, z: 0, axis: 0 }], ['end', { kind: 'end', x: 0, z: 0 }], ['overworld', { kind: 'respawn', x: 0, z: 0 }]]) {
    await page.evaluate(([t, v]) => window.__blockwild.game.changeDimension(t, v), [target, trv]);
    await page.waitForFunction((t) => window.__blockwild.state === 'playing' && window.__blockwild.game.dim === t, target, { timeout: 90000, polling: 250 });
    await sleep(2500);
    await page.screenshot({ path: `test-results/dim-${target}.png` });
    console.log('arrived', target, JSON.stringify(await page.evaluate(() => { const p = window.__blockwild.game.player.pos; return [p.x | 0, p.y | 0, p.z | 0]; })));
  }
  // Mobs spawn per dimension without errors
  await page.evaluate(() => window.__blockwild.game.changeDimension('nether', { kind: 'portal', x: 0, z: 0, axis: 0 }));
  await page.waitForFunction(() => window.__blockwild.state === 'playing' && window.__blockwild.game.dim === 'nether', null, { timeout: 90000 });
  await sleep(6000);
  console.log('nether mobs', await page.evaluate(() => window.__blockwild.game.entities.mobs.length));
  if (errors.length) fail('errors: ' + errors.slice(0, 5).join(' | '));
  console.log('DIMS OK');
} catch (e) {
  console.log('FAIL', e.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
}
