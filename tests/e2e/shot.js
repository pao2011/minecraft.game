// Dev helper: screenshot a URL after waiting for a JS condition. Usage: node tests/e2e/shot.js <url> <out.png> [waitExpr] [w] [h]
import { chromium } from 'playwright';
const [url, out, waitExpr = 'true', w = '960', h = '540'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
try {
  await page.waitForFunction(waitExpr, null, { timeout: 60000, polling: 250 });
} catch (e) {
  logs.push('[wait timeout] ' + e.message.split('\n')[0]);
}
await page.screenshot({ path: out });
console.log(logs.slice(-30).join('\n'));
await browser.close();
