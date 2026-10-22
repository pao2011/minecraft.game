import { chromium } from 'playwright';
const S = process.argv[2];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 960, height: 540 }, hasTouch: true, isMobile: false });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { if (!m.text().includes('[vite]')) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.addInitScript(() => localStorage.setItem('blockwild.settings.v1', JSON.stringify({ controlsMode: 'touch', renderDistance: 4, quality: 'custom' })));
await page.goto('http://localhost:5173/');
await page.waitForFunction(() => document.querySelector('.menu-main'), null, { timeout: 30000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${S}/e1-menu.png` });
await page.click('text=New World');
await page.waitForTimeout(300);
await page.fill('input.text-input >> nth=1', 'explore-seed-1');
await page.click('text=Create & Play');
const t0 = Date.now();
try {
  await page.waitForFunction(() => window.__blockwild?.state === 'playing', null, { timeout: 90000, polling: 500 });
} catch (e) { logs.push('timeout waiting for playing: ' + await page.evaluate(() => window.__blockwild?.state + ' ' + window.__blockwild?.game?.loadProgress())); }
logs.push(`load took ${Date.now() - t0} ms`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${S}/e2-game.png` });
const info = await page.evaluate(() => { const g = window.__blockwild.game; return g && { pos: g.player.pos, chunks: g.world.chunks.size, queue: g.meshQueue.size, fps: window.__blockwild.fps, biome: g.currentBiome?.name }; });
logs.push(JSON.stringify(info));
console.log(logs.join('\n'));
await browser.close();
