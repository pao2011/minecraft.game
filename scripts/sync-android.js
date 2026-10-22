// Copies the production web build into the Android app's assets (android/app/src/main/assets/www).
import { cpSync, rmSync, existsSync, mkdirSync } from 'node:fs';

const src = 'build/web';
const dst = 'android/app/src/main/assets/www';
if (!existsSync(`${src}/index.html`)) {
  console.error('No web build found. Run "npm run build" first.');
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`Copied ${src} -> ${dst}`);
