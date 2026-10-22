// Unified input: on-screen touch controls (joystick, look area, buttons) and keyboard/mouse.
// Each pointer is owned by exactly one control from pointerdown to pointerup/cancel, so a
// joystick finger never rotates the camera and a look finger never presses buttons.
import { ICONS } from '../ui/svg.js';

const KEYMAP = {
  KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  Space: 'jump', ShiftLeft: 'sneak', ShiftRight: 'sneak', ControlLeft: 'sprintKey', KeyR: 'sprintKey',
};

export class InputManager {
  constructor(root, settings) {
    this.root = root;
    this.settings = settings;
    this.enabled = false;
    this.keys = new Set();
    this.look = { dx: 0, dy: 0 };
    this.joy = { x: 0, y: 0, pointer: null };
    this.held = { jump: false, mine: false, use: false, flyDown: false };
    this.toggles = { sneak: false, sprint: false };
    this.edges = new Set();
    this.hotbarSelect = null;
    this.scroll = 0;
    this.pointerLocked = false;
    this.touchMode = false;
    this.owners = new Map(); // pointerId -> control name
    this.buildTouchUI();
    this.bindKeyboardMouse();
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => document.hidden && this.releaseAll());
  }

  // ---- Touch -------------------------------------------------------------------------------

  buildTouchUI() {
    const el = document.createElement('div');
    el.className = 'touch-ui hidden';
    el.innerHTML = `
      <div class="look-zone" data-ctl="look"></div>
      <div class="joy" data-ctl="joy"><div class="joy-base"><div class="joy-thumb"></div></div></div>
      <div class="tbtns">
        <button class="tbtn t-jump" data-ctl="jump" aria-label="Jump">${ICONS.jump}</button>
        <button class="tbtn t-sneak" data-ctl="sneak" aria-label="Sneak">${ICONS.sneak}</button>
        <button class="tbtn t-sprint" data-ctl="sprint" aria-label="Sprint">${ICONS.sprint}</button>
        <button class="tbtn t-mine" data-ctl="mine" aria-label="Mine or attack">${ICONS.mine}</button>
        <button class="tbtn t-use" data-ctl="use" aria-label="Place or use">${ICONS.use}</button>
        <button class="tbtn t-fly hidden" data-ctl="fly" aria-label="Toggle flight">${ICONS.fly}</button>
        <button class="tbtn t-down hidden" data-ctl="down" aria-label="Fly down">${ICONS.down}</button>
      </div>
      <div class="ttop">
        <button class="tbtn small t-inv" data-ctl="inventory" aria-label="Inventory">${ICONS.inventory}</button>
        <button class="tbtn small t-pause" data-ctl="pause" aria-label="Pause">${ICONS.pause}</button>
      </div>`;
    this.root.appendChild(el);
    this.touchEl = el;
    this.joyEl = el.querySelector('.joy');
    this.joyBase = el.querySelector('.joy-base');
    this.joyThumb = el.querySelector('.joy-thumb');
    this.btn = Object.fromEntries([...el.querySelectorAll('[data-ctl]')].map((b) => [b.dataset.ctl, b]));
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    el.addEventListener('pointerup', (e) => this.onPointerUp(e));
    el.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    el.addEventListener('lostpointercapture', (e) => this.onPointerUp(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setTouchMode(on) {
    this.touchMode = on;
  }

  setCreative(creative, flying) {
    this.btn.fly.classList.toggle('hidden', !creative);
    this.btn.down.classList.toggle('hidden', !(creative && flying));
    this.btn.fly.classList.toggle('on', !!flying);
  }

  onPointerDown(e) {
    if (!this.enabled) return;
    const target = e.target.closest('[data-ctl]');
    if (!target || this.owners.has(e.pointerId)) return;
    const ctl = target.dataset.ctl;
    e.preventDefault();
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events may not support capture */
    }
    this.owners.set(e.pointerId, { ctl, x: e.clientX, y: e.clientY, t: performance.now(), el: target });
    this.edges.add('anyInput');
    switch (ctl) {
      case 'joy':
        this.joy.pointer = e.pointerId;
        this.joy.ox = e.clientX;
        this.joy.oy = e.clientY;
        this.positionJoystick(e.clientX, e.clientY);
        break;
      case 'look':
        break;
      case 'jump':
        this.held.jump = true;
        this.edges.add('jumpPressed');
        break;
      case 'sneak':
        this.toggles.sneak = !this.toggles.sneak;
        break;
      case 'sprint':
        if (this.settings.get('sprintMode') === 'hold') this.toggles.sprint = true;
        else this.toggles.sprint = !this.toggles.sprint;
        break;
      case 'mine':
        this.held.mine = true;
        this.edges.add('minePressed');
        break;
      case 'use':
        this.held.use = true;
        this.edges.add('usePressed');
        break;
      case 'fly':
        this.edges.add('flyToggle');
        break;
      case 'down':
        this.held.flyDown = true;
        break;
      case 'inventory':
        this.edges.add('inventory');
        break;
      case 'pause':
        this.edges.add('pause');
        break;
    }
    target.classList.add('pressed');
    this.syncToggles();
    this.vibrate(8);
  }

  onPointerMove(e) {
    const o = this.owners.get(e.pointerId);
    if (!o) return;
    e.preventDefault();
    if (o.ctl === 'look') {
      const sens = this.settings.get('lookSensitivity');
      this.look.dx += (e.clientX - o.x) * sens * 0.0055;
      this.look.dy += (e.clientY - o.y) * sens * 0.0055 * (this.settings.get('invertY') ? -1 : 1);
      o.x = e.clientX;
      o.y = e.clientY;
    } else if (o.ctl === 'joy') {
      const r = this.joyRadius();
      let dx = e.clientX - this.joy.ox, dy = e.clientY - this.joy.oy;
      const len = Math.hypot(dx, dy);
      // Finger may travel past the rim: the base follows so direction changes stay responsive.
      if (len > r * 1.6) {
        this.joy.ox += (dx / len) * (len - r * 1.6);
        this.joy.oy += (dy / len) * (len - r * 1.6);
        dx = e.clientX - this.joy.ox;
        dy = e.clientY - this.joy.oy;
        this.positionJoystick(this.joy.ox, this.joy.oy);
      }
      const l2 = Math.hypot(dx, dy);
      const dead = 0.12;
      let m = Math.min(1, l2 / r);
      m = m < dead ? 0 : (m - dead) / (1 - dead);
      this.joy.x = l2 ? (dx / l2) * m : 0;
      this.joy.y = l2 ? (-dy / l2) * m : 0;
      const tx = (l2 ? dx / l2 : 0) * Math.min(l2, r), ty = (l2 ? dy / l2 : 0) * Math.min(l2, r);
      this.joyThumb.style.transform = `translate(${tx}px, ${ty}px)`;
    }
  }

  onPointerUp(e) {
    const o = this.owners.get(e.pointerId);
    if (!o) return;
    this.owners.delete(e.pointerId);
    o.el.classList.remove('pressed');
    switch (o.ctl) {
      case 'joy':
        this.resetJoystick();
        break;
      case 'jump':
        this.held.jump = false;
        break;
      case 'mine':
        this.held.mine = false;
        break;
      case 'use':
        this.held.use = false;
        break;
      case 'down':
        this.held.flyDown = false;
        break;
      case 'sprint':
        if (this.settings.get('sprintMode') === 'hold') this.toggles.sprint = false;
        break;
    }
    this.syncToggles();
  }

  joyRadius() {
    return (this.joyBase.offsetWidth || 120) / 2;
  }

  positionJoystick(x, y) {
    const rect = this.joyEl.getBoundingClientRect();
    this.joyBase.style.left = `${x - rect.left}px`;
    this.joyBase.style.top = `${y - rect.top}px`;
    this.joyBase.classList.add('active');
  }

  resetJoystick() {
    this.joy.pointer = null;
    this.joy.x = this.joy.y = 0;
    this.joyThumb.style.transform = '';
    this.joyBase.style.left = '';
    this.joyBase.style.top = '';
    this.joyBase.classList.remove('active');
  }

  syncToggles() {
    this.btn.sneak.classList.toggle('on', this.toggles.sneak);
    this.btn.sprint.classList.toggle('on', this.toggles.sprint);
  }

  vibrate(ms) {
    if (!this.settings.get('vibration')) return;
    try {
      if (window.AndroidHost?.vibrate) window.AndroidHost.vibrate(ms);
      else navigator.vibrate?.(ms);
    } catch {
      /* vibration is best-effort */
    }
  }

  // ---- Keyboard / mouse -------------------------------------------------------------------

  bindKeyboardMouse() {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (KEYMAP[e.code]) {
        if (!this.keys.has(e.code) && KEYMAP[e.code] === 'jump') {
          this.edges.add('jumpPressed');
          const now = performance.now();
          if (now - (this.lastSpace || 0) < 300) this.edges.add('flyToggle');
          this.lastSpace = now;
        }
        this.keys.add(e.code);
        if (this.enabled) e.preventDefault();
      }
      if (e.repeat) return;
      if (e.code === 'KeyE') this.edges.add('inventory');
      else if (e.code === 'Escape') this.edges.add('escape');
      else if (e.code === 'KeyQ') this.edges.add('drop');
      else if (e.code === 'F3') {
        this.edges.add('debug');
        e.preventDefault();
      } else if (e.code === 'KeyF') this.edges.add('flyToggle');
      else if (/^Digit[1-9]$/.test(e.code)) this.hotbarSelect = Number(e.code.slice(5)) - 1;
      this.edges.add('anyInput');
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.lockTarget;
      if (!this.pointerLocked) {
        this.held.mine = this.held.use = false;
        if (this.enabled && !this.touchMode) this.edges.add('lockLost');
      }
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      const sens = this.settings.get('lookSensitivity');
      this.look.dx += e.movementX * sens * 0.0024;
      this.look.dy += e.movementY * sens * 0.0024 * (this.settings.get('invertY') ? -1 : 1);
    });
    window.addEventListener('mousedown', (e) => {
      if (!this.pointerLocked) return;
      if (e.button === 0) {
        this.held.mine = true;
        this.edges.add('minePressed');
      } else if (e.button === 2) {
        this.held.use = true;
        this.edges.add('usePressed');
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.held.mine = false;
      else if (e.button === 2) this.held.use = false;
    });
    window.addEventListener('wheel', (e) => {
      if (this.pointerLocked) this.scroll += Math.sign(e.deltaY);
    }, { passive: true });
    window.addEventListener('contextmenu', (e) => {
      if (this.pointerLocked) e.preventDefault();
    });
  }

  requestPointerLock(el) {
    this.lockTarget = el;
    if (this.touchMode || !el.requestPointerLock) return;
    try {
      const p = el.requestPointerLock();
      p?.catch?.(() => {});
    } catch {
      /* pointer lock refused (e.g. iframe); keyboard still works */
    }
  }

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // ---- Per-frame snapshot -------------------------------------------------------------------

  /** Release every held control (focus loss, menus opening). */
  releaseAll() {
    for (const [id, o] of this.owners) {
      o.el.classList.remove('pressed');
      try {
        o.el.releasePointerCapture(id);
      } catch {
        /* already released */
      }
    }
    this.owners.clear();
    this.resetJoystick();
    this.keys.clear();
    this.held.jump = this.held.mine = this.held.use = this.held.flyDown = false;
    if (this.settings.get('sprintMode') === 'hold') this.toggles.sprint = false;
    this.look.dx = this.look.dy = 0;
    this.syncToggles();
  }

  frame() {
    const k = (name) => [...this.keys].some((c) => KEYMAP[c] === name);
    let moveX = this.joy.x, moveZ = this.joy.y;
    if (k('fwd')) moveZ += 1;
    if (k('back')) moveZ -= 1;
    if (k('right')) moveX += 1;
    if (k('left')) moveX -= 1;
    const len = Math.hypot(moveX, moveZ);
    if (len > 1) {
      moveX /= len;
      moveZ /= len;
    }
    const snap = {
      moveX, moveZ,
      lookDX: this.look.dx, lookDY: this.look.dy,
      jump: this.held.jump || k('jump'),
      jumpPressed: this.edges.has('jumpPressed'),
      sneak: this.toggles.sneak || k('sneak'),
      sprint: this.toggles.sprint || k('sprintKey'),
      flyDown: this.held.flyDown,
      mine: this.held.mine,
      use: this.held.use,
      edges: this.edges,
      hotbar: this.hotbarSelect,
      scroll: this.scroll,
    };
    this.look.dx = this.look.dy = 0;
    this.edges = new Set();
    this.hotbarSelect = null;
    this.scroll = 0;
    return snap;
  }

  /** Sprint toggle turns off automatically when the player stops (mobile convenience). */
  clearSprint() {
    if (this.toggles.sprint && this.settings.get('sprintMode') !== 'hold') {
      this.toggles.sprint = false;
      this.syncToggles();
    }
  }
}
