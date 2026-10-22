// Owns the DOM overlay: the current menu screen, HUD, inventory screen, toasts and fades.
import { h } from './dom.js';
import { HUD } from './hud.js';
import { InventoryScreen } from './inventoryScreen.js';

export class UIManager {
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('ui');
    this.hud = new HUD(this);
    this.inventory = new InventoryScreen(this);
    this.screenEl = null;
    this.fadeEl = h('div.fade');
    this.root.append(this.hud.el, this.inventory.el, this.hud.toasts, this.fadeEl, h('div.rotate-hint', h('span', 'Rotate your device to landscape for the best experience')));
    this.hud.toasts.style.pointerEvents = 'none';
    this.inGame = false;
    this.handVisible = true;
  }

  setScreen(el) {
    this.clearScreen();
    if (!el) return;
    this.screenEl = el;
    this.root.appendChild(el);
  }

  clearScreen() {
    this.screenEl?.remove();
    this.screenEl = null;
  }

  toast(msg, kind) {
    this.hud.toast(msg, kind);
  }

  fade(on) {
    this.fadeEl.classList.toggle('on', on);
  }

  /** Push visual settings into CSS variables. */
  applySettings(s) {
    const r = document.documentElement.style;
    r.setProperty('--hud', s.get('hudScale'));
    r.setProperty('--text-scale', s.get('textScale'));
    r.setProperty('--btn-size', s.get('buttonSize'));
    r.setProperty('--joy-size', s.get('joystickSize'));
    r.setProperty('--btn-opacity', s.get('buttonOpacity'));
    document.body.classList.toggle('left-handed', s.get('leftHanded'));
    this.hud.setCrosshair(s.get('crosshair'));
    this.hud.toggleDebug(s.get('showDebug'));
    this.hud.toggleCoords(s.get('showCoords'));
  }
}
