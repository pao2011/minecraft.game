// Short contextual tutorial: one compact hint at a time, advanced by real gameplay events.
import { h } from '../ui/dom.js';

const STEPS = [
  { id: 'move', touch: 'Drag the left joystick to walk around.', keys: 'Use W A S D to walk around.' },
  { id: 'look', touch: 'Drag anywhere on the right side to look around.', keys: 'Move the mouse to look around (click the game to capture it).' },
  { id: 'jump', touch: 'Tap the up-arrow button to jump.', keys: 'Press Space to jump.' },
  { id: 'mine', touch: 'Aim at a block and hold the pickaxe button to break it. Trees give logs!', keys: 'Aim at a block and hold the left mouse button to break it. Trees give logs!' },
  { id: 'pickup', touch: 'Walk over the dropped item to collect it.', keys: 'Walk over the dropped item to collect it.' },
  { id: 'hotbar', touch: 'Tap a hotbar slot at the bottom to choose what you hold.', keys: 'Press 1-9 or scroll to choose a hotbar slot.' },
  { id: 'place', touch: 'Select a block and tap the cube button to place it.', keys: 'Select a block and right-click to place it.' },
  { id: 'inventory', touch: 'Open your inventory with the grid button (top right).', keys: 'Press E to open your inventory.' },
  { id: 'craft', touch: 'In Crafting, turn logs into planks, then planks into a Workbench.', keys: 'In Crafting, turn logs into planks, then planks into a Workbench.' },
  { id: 'save', touch: 'Your world saves automatically. Pause (top right) to save & quit anytime. Have fun!', keys: 'Your world saves automatically. Press Esc to pause, save & quit anytime. Have fun!', timeout: 9 },
];

export class Tutorial {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.timer = 0;
    this.moved = 0;
    this.looked = 0;
  }

  get settings() {
    return this.app.settings;
  }

  get active() {
    return !this.settings.get('tutorialDone') && this.app.game && !this.app.game.creative;
  }

  get step() {
    return STEPS[this.settings.get('tutorialStep')] || null;
  }

  restart() {
    this.settings.set('tutorialDone', false);
    this.settings.set('tutorialStep', 0);
  }

  finish() {
    this.settings.set('tutorialDone', true);
    this.render();
  }

  advance() {
    const next = this.settings.get('tutorialStep') + 1;
    if (next >= STEPS.length) return this.finish();
    this.settings.set('tutorialStep', next);
    this.timer = 0;
    this.app.audio.play('levelup');
    this.render();
  }

  /** Gameplay events: 'mine', 'pickup', 'place', 'inventory', 'craft', 'hotbar', 'jump'. */
  event(name) {
    if (!this.active) return;
    if (this.step?.id === name) this.advance();
  }

  update(dt, inp, game) {
    if (!this.active) {
      if (this.el) this.render();
      return;
    }
    const s = this.step;
    if (!s) return;
    if (!this.el) this.render();
    if (s.id === 'move') {
      this.moved += Math.hypot(inp.moveX, inp.moveZ) * dt;
      if (this.moved > 1.5) this.advance();
    } else if (s.id === 'look') {
      this.looked += Math.abs(inp.lookDX) + Math.abs(inp.lookDY);
      if (this.looked > 1.2) this.advance();
    } else if (s.id === 'jump') {
      if (inp.edges.has('jumpPressed') && game.player.onGround === false) this.advance();
      else if (inp.edges.has('jumpPressed')) this.pendingJump = true;
      if (this.pendingJump && !game.player.onGround) this.advance();
    } else if (s.timeout) {
      this.timer += dt;
      if (this.timer > s.timeout) this.advance();
    }
  }

  render() {
    this.el?.remove();
    this.el = null;
    if (!this.active || !this.app.ui.inGame) return;
    const s = this.step;
    if (!s) return;
    const touch = this.app.input.touchMode;
    const idx = this.settings.get('tutorialStep');
    this.el = h('div.hint-banner',
      h('div.step', `Tutorial ${idx + 1}/${STEPS.length}`),
      h('div.msg', touch ? s.touch : s.keys),
      h('div.inline', h('button.btn', { on: { click: () => this.advance() } }, 'Next'), h('button.btn.ghost', { on: { click: () => this.finish() } }, 'Skip tutorial')));
    this.app.ui.root.appendChild(this.el);
  }

  hide() {
    this.el?.remove();
    this.el = null;
  }
}
