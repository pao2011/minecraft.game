// Entry point.
import './ui/styles.css';
import { App } from './game/app.js';
import { log } from './util/log.js';

const app = new App();
app.start().catch((err) => {
  log.error('Startup failed', err);
  const el = document.getElementById('boot-error');
  if (el) {
    el.textContent = `Blockwild could not start: ${err.message}. Your browser may not support WebGL.`;
    el.hidden = false;
  }
});
