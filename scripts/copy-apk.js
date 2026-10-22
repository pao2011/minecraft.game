// Copies the built debug APK to dist/Blockwild-debug.apk.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';

const apk = 'android/app/build/outputs/apk/debug/app-debug.apk';
if (!existsSync(apk)) {
  console.error(`APK not found at ${apk}`);
  process.exit(1);
}
mkdirSync('dist', { recursive: true });
copyFileSync(apk, 'dist/Blockwild-debug.apk');
console.log(`dist/Blockwild-debug.apk (${(statSync(apk).size / 1048576).toFixed(2)} MB)`);
