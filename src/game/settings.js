// Persistent user settings with schema validation. Unknown or malformed values fall back to
// defaults, so a damaged settings blob can never break startup.
import { QUALITY_PRESETS } from '../config/constants.js';

const num = (def, min, max) => ({ type: 'number', def, min, max });
const bool = (def) => ({ type: 'boolean', def });
const pick = (def, options) => ({ type: 'enum', def, options });

export const SCHEMA = {
  quality: pick('medium', ['low', 'medium', 'high', 'custom']),
  renderDistance: num(5, 2, 10),
  particles: num(0.7, 0, 1),
  clouds: bool(true),
  fancyLeaves: bool(true),
  waterAnimation: bool(true),
  resolution: num(1, 0.5, 1.5),
  fpsCap: pick('60', ['30', '60', 'unlimited']),
  adaptiveQuality: bool(true),
  fov: num(72, 50, 100),
  lookSensitivity: num(1, 0.2, 3),
  invertY: bool(false),
  sprintMode: pick('toggle', ['toggle', 'hold']),
  autoJump: bool(true),
  controlsMode: pick('auto', ['auto', 'touch', 'keyboard']),
  buttonSize: num(1, 0.7, 1.4),
  joystickSize: num(1, 0.7, 1.4),
  buttonOpacity: num(0.75, 0.2, 1),
  leftHanded: bool(false),
  vibration: bool(true),
  hudScale: num(1, 0.7, 1.3),
  textScale: num(1, 0.85, 1.3),
  crosshair: pick('plus', ['plus', 'dot', 'circle']),
  reducedMotion: bool(false),
  brightness: num(0.5, 0, 1),
  masterVolume: num(0.8, 0, 1),
  sfxVolume: num(0.8, 0, 1),
  ambientVolume: num(0.6, 0, 1),
  musicVolume: num(0.4, 0, 1),
  muted: bool(false),
  showDebug: bool(false),
  showCoords: bool(false),
  tutorialDone: bool(false),
  tutorialStep: num(0, 0, 100),
};

const KEY = 'blockwild.settings.v1';

function validate(key, value) {
  const s = SCHEMA[key];
  if (!s) return undefined;
  if (s.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return s.def;
    return Math.min(s.max, Math.max(s.min, n));
  }
  if (s.type === 'boolean') return typeof value === 'boolean' ? value : s.def;
  return s.options.includes(String(value)) ? String(value) : s.def;
}

export class Settings {
  constructor(storage = safeLocalStorage()) {
    this.storage = storage;
    this.values = Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.def]));
    this.listeners = new Set();
    this.load();
  }

  load() {
    try {
      const raw = this.storage?.getItem(KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const k of Object.keys(SCHEMA)) if (k in data) this.values[k] = validate(k, data[k]);
    } catch {
      // Corrupt settings: keep defaults; they are re-saved on the next change.
    }
  }

  save() {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.values));
    } catch {
      /* storage full or unavailable (private mode) - settings live for this session only */
    }
  }

  get(k) {
    return this.values[k];
  }

  set(k, v) {
    const val = validate(k, v);
    if (val === undefined || val === this.values[k]) return;
    this.values[k] = val;
    if (['renderDistance', 'particles', 'clouds', 'fancyLeaves', 'waterAnimation', 'resolution'].includes(k) && this.values.quality !== 'custom') this.values.quality = 'custom';
    this.save();
    for (const fn of this.listeners) fn(k, val);
  }

  applyPreset(name) {
    const p = QUALITY_PRESETS[name];
    if (!p) return;
    Object.assign(this.values, {
      quality: name,
      renderDistance: p.renderDistance,
      particles: p.particles,
      clouds: p.clouds,
      fancyLeaves: p.fancyLeaves,
      waterAnimation: p.waterAnimation,
      resolution: p.pixelRatio,
    });
    this.save();
    for (const fn of this.listeners) fn('quality', name);
  }

  resetControls() {
    for (const k of ['lookSensitivity', 'invertY', 'sprintMode', 'autoJump', 'controlsMode', 'buttonSize', 'joystickSize', 'buttonOpacity', 'leftHanded', 'vibration']) this.values[k] = SCHEMA[k].def;
    this.save();
    for (const fn of this.listeners) fn('controls', null);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function safeLocalStorage() {
  try {
    const ls = globalThis.localStorage;
    const probe = '__bw_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    const mem = new Map();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  }
}
