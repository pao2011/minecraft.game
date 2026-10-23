// Procedural sound: every effect is synthesized with WebAudio from noise and oscillators,
// so the game ships no recorded audio. Buses: master -> sfx / ambient / music.
const MATERIAL = {
  stone: { f: 1700, q: 1.2, type: 'bandpass', dur: 0.09, tone: 0 },
  wood: { f: 650, q: 1.5, type: 'bandpass', dur: 0.1, tone: 190 },
  grass: { f: 2400, q: 0.6, type: 'highpass', dur: 0.1, tone: 0 },
  gravel: { f: 1100, q: 0.9, type: 'bandpass', dur: 0.13, tone: 0, grain: true },
  sand: { f: 3400, q: 0.5, type: 'highpass', dur: 0.12, tone: 0 },
  glass: { f: 3200, q: 3, type: 'bandpass', dur: 0.12, tone: 2600 },
  wool: { f: 700, q: 0.7, type: 'lowpass', dur: 0.12, tone: 0 },
  snow: { f: 2600, q: 2, type: 'bandpass', dur: 0.12, tone: 0 },
  metal: { f: 2000, q: 4, type: 'bandpass', dur: 0.15, tone: 880 },
  liquid: { f: 900, q: 0.8, type: 'lowpass', dur: 0.25, tone: 0 },
};

// Creature voices: base pitch, duration, waveform and character.
const VOICES = {
  grazer: { f: 115, dur: 0.75, wave: 'sawtooth', lp: 700, glide: -25, vib: 4 },
  snout: { f: 230, dur: 0.22, wave: 'square', lp: 900, glide: -40, vib: 0, repeat: 2 },
  cluck: { f: 900, dur: 0.07, wave: 'triangle', lp: 3000, glide: 200, vib: 0, repeat: 3 },
  woolly: { f: 320, dur: 0.55, wave: 'sawtooth', lp: 1400, glide: -30, vib: 9 },
  shambler: { f: 85, dur: 0.9, wave: 'sawtooth', lp: 420, glide: -20, vib: 3, noise: 0.4 },
  skitter: { f: 1800, dur: 0.04, wave: 'square', lp: 5000, glide: -600, vib: 0, repeat: 5, noise: 0.3 },
  bonecaster: { f: 1400, dur: 0.03, wave: 'square', lp: 4000, glide: -300, vib: 0, repeat: 6 },
  hopper: { f: 520, dur: 0.12, wave: 'triangle', lp: 2200, glide: 160, vib: 0, repeat: 2 },
  bat: { f: 3200, dur: 0.05, wave: 'sine', lp: 6000, glide: 900, vib: 0, repeat: 3 },
  prowler: { f: 70, dur: 0.8, wave: 'sawtooth', lp: 380, glide: 30, vib: 6, noise: 0.5 },
  blastling: { f: 210, dur: 0.5, wave: 'sawtooth', lp: 600, glide: 120, vib: 0, noise: 1 },
  gloop: { f: 190, dur: 0.18, wave: 'sine', lp: 700, glide: 110, vib: 0 },
  emberling: { f: 600, dur: 0.3, wave: 'square', lp: 1800, glide: -200, vib: 18, noise: 0.5 },
  cinderhound: { f: 130, dur: 0.4, wave: 'sawtooth', lp: 900, glide: -70, vib: 0, repeat: 2, noise: 0.4 },
  magmaling: { f: 150, dur: 0.22, wave: 'triangle', lp: 650, glide: 80, vib: 0, noise: 0.5 },
  wisp: { f: 880, dur: 0.7, wave: 'sine', lp: 2400, glide: 220, vib: 7 },
  voidstalker: { f: 55, dur: 1.1, wave: 'sawtooth', lp: 500, glide: 260, vib: 14, noise: 0.5 },
  drake: { f: 62, dur: 1.3, wave: 'sawtooth', lp: 520, glide: -30, vib: 5, noise: 0.8 },
  gloomling: { f: 140, dur: 0.6, wave: 'triangle', lp: 800, glide: 60, vib: 12, noise: 0.6 },
};

const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19];

export class AudioManager {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    this.active = 0;
    this.ambientState = { wind: 0, rain: 0, cave: 0, water: 0 };
    this.musicTimer = 40;
    settings.onChange(() => this.applyVolumes());
  }

  /** Create/resume the context; must run inside a user gesture on mobile. */
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        const c = this.ctx;
        this.master = c.createGain();
        this.master.connect(c.destination);
        this.sfx = c.createGain();
        this.ambient = c.createGain();
        this.music = c.createGain();
        for (const g of [this.sfx, this.ambient, this.music]) g.connect(this.master);
        const len = c.sampleRate * 2;
        this.noise = c.createBuffer(1, len, c.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.startAmbient();
        this.applyVolumes();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null; // audio unsupported: the game stays silent
    }
  }

  suspend() {
    this.ctx?.suspend?.().catch(() => {});
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.get('muted') ? 0 : s.get('masterVolume'), t, 0.05);
    this.sfx.gain.setTargetAtTime(s.get('sfxVolume'), t, 0.05);
    this.ambient.gain.setTargetAtTime(s.get('ambientVolume'), t, 0.05);
    this.music.gain.setTargetAtTime(s.get('musicVolume') * 0.6, t, 0.05);
  }

  setListener(x, y, z, yaw) {
    Object.assign(this.listener, { x, y, z, yaw });
  }

  /** Distance attenuation and stereo pan for a world position. */
  spatial(pos) {
    if (!pos) return { gain: 1, pan: 0 };
    const l = this.listener;
    const dx = pos.x - l.x, dy = pos.y - l.y, dz = pos.z - l.z;
    const d = Math.hypot(dx, dy, dz);
    const gain = Math.max(0, 1 - d / 28) ** 1.6;
    // Listener right vector for yaw: (cos, 0, -sin).
    const pan = d > 0.5 ? Math.max(-1, Math.min(1, (dx * Math.cos(l.yaw) - dz * Math.sin(l.yaw)) / d)) * 0.8 : 0;
    return { gain, pan };
  }

  out(gainValue, pan, bus = this.sfx) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = gainValue;
    if (pan && c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(bus);
    } else g.connect(bus);
    return g;
  }

  noiseBurst(dest, t, dur, filterType, freq, q, vol, grain = false) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    if (grain) {
      for (let k = 1; k < 4; k++) {
        g.gain.setValueAtTime(vol * (0.4 + Math.random() * 0.6), t + (dur * k) / 4);
      }
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 1.5, dur + 0.05);
    this.track(src, dur);
  }

  tone(dest, t, freq, dur, vol, wave = 'sine', glide = 0) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = wave;
    o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + glide), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    this.track(o, dur);
  }

  track(node, dur) {
    this.active++;
    setTimeout(() => this.active--, (dur + 0.1) * 1000);
  }

  material(kind, mat, dest, t) {
    const m = MATERIAL[mat] || MATERIAL.stone;
    const scale = { hit: [0.6, 0.35], break: [1.6, 0.6], place: [0.9, 0.5], step: [0.7, 0.14] }[kind];
    const jitter = 0.85 + Math.random() * 0.3;
    this.noiseBurst(dest, t, m.dur * scale[0], m.type, m.f * jitter, m.q, scale[1], m.grain || kind === 'break');
    if (m.tone) this.tone(dest, t, m.tone * jitter, m.dur * scale[0], scale[1] * 0.35, 'sine', -m.tone * 0.3);
    if (kind === 'break') this.noiseBurst(dest, t + 0.03, 0.18, 'lowpass', 500, 0.7, 0.3);
  }

  voice(name, variant, dest, t) {
    const v = VOICES[name];
    if (!v) return;
    const pitch = variant === 'hurt' ? 1.35 : variant === 'death' ? 0.8 : variant === 'attack' ? 1.1 : 1;
    const dur = variant === 'death' ? v.dur * 1.6 : variant === 'hurt' ? v.dur * 0.6 : v.dur;
    const reps = v.repeat || 1;
    for (let r = 0; r < reps; r++) {
      const st = t + r * (dur * 1.4);
      const c = this.ctx;
      const o = c.createOscillator();
      o.type = v.wave;
      const f0 = v.f * pitch * (0.92 + Math.random() * 0.16);
      o.frequency.setValueAtTime(f0, st);
      o.frequency.linearRampToValueAtTime(Math.max(30, f0 + v.glide * (variant === 'death' ? -3 : 1)), st + dur);
      if (v.vib) {
        const lfo = c.createOscillator();
        const lg = c.createGain();
        lfo.frequency.value = v.vib;
        lg.gain.value = f0 * 0.04;
        lfo.connect(lg);
        lg.connect(o.frequency);
        lfo.start(st);
        lfo.stop(st + dur + 0.05);
      }
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = v.lp;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.25, st + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
      o.connect(f);
      f.connect(g);
      g.connect(dest);
      o.start(st);
      o.stop(st + dur + 0.05);
      this.track(o, dur);
      if (v.noise) this.noiseBurst(dest, st, dur, 'bandpass', v.lp, 0.8, 0.12 * v.noise);
    }
  }

  /** Play a named effect. opts: { pos, volume } */
  play(name, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running' || this.active > 28) return;
    const { gain, pan } = this.spatial(opts.pos);
    if (gain < 0.02) return;
    const dest = this.out(gain * (opts.volume ?? 1), pan);
    const t = this.ctx.currentTime + 0.005;
    const [kind, rest] = name.split('_');
    if ((kind === 'hit' || kind === 'break' || kind === 'place' || kind === 'step') && rest) return this.material(kind, rest, dest, t);
    if (VOICES[kind]) return this.voice(kind, rest || 'idle', dest, t);
    switch (name) {
      case 'pickup':
        this.tone(dest, t, 620, 0.07, 0.18, 'sine', 700);
        break;
      case 'click':
        this.tone(dest, t, 1100, 0.03, 0.12, 'square', -300);
        break;
      case 'open':
        this.noiseBurst(dest, t, 0.12, 'bandpass', 900, 1, 0.25);
        this.tone(dest, t, 300, 0.12, 0.12, 'triangle', 120);
        break;
      case 'craft':
        this.tone(dest, t, 660, 0.12, 0.16, 'triangle');
        this.tone(dest, t + 0.08, 990, 0.18, 0.14, 'triangle');
        break;
      case 'eat':
        this.noiseBurst(dest, t, 0.08, 'bandpass', 1400 + Math.random() * 600, 1.5, 0.3, true);
        break;
      case 'burp':
        this.tone(dest, t, 140, 0.2, 0.25, 'sawtooth', -50);
        break;
      case 'hurt':
        this.noiseBurst(dest, t, 0.14, 'lowpass', 900, 0.8, 0.5);
        this.tone(dest, t, 220, 0.18, 0.25, 'sawtooth', -110);
        break;
      case 'land':
        this.noiseBurst(dest, t, 0.1, 'lowpass', 420, 0.7, 0.35);
        break;
      case 'deny':
        this.tone(dest, t, 150, 0.09, 0.15, 'square', -30);
        break;
      case 'door_open':
      case 'door_close':
        this.tone(dest, t, name === 'door_open' ? 180 : 140, 0.2, 0.18, 'sawtooth', name === 'door_open' ? 90 : -50);
        this.noiseBurst(dest, t + 0.12, 0.08, 'bandpass', 700, 1.2, 0.3);
        break;
      case 'splash':
        this.noiseBurst(dest, t, 0.35, 'lowpass', 1400, 0.6, 0.4);
        break;
      case 'grow':
        for (let k = 0; k < 4; k++) this.tone(dest, t + k * 0.05, 1200 + k * 300, 0.08, 0.08, 'sine');
        break;
      case 'shoot':
        this.noiseBurst(dest, t, 0.18, 'highpass', 2200, 0.6, 0.25);
        break;
      case 'thud':
        this.noiseBurst(dest, t, 0.06, 'bandpass', 900, 1, 0.3);
        break;
      case 'toolbreak':
        this.tone(dest, t, 1800, 0.25, 0.2, 'square', -1400);
        this.noiseBurst(dest, t, 0.2, 'highpass', 3000, 0.5, 0.3);
        break;
      case 'thunder':
        this.noiseBurst(dest, t, 1.8, 'lowpass', 220, 0.7, 0.9);
        this.noiseBurst(dest, t + 0.5, 1.4, 'lowpass', 140, 0.7, 0.7);
        this.tone(dest, t, 48, 1.6, 0.5, 'sawtooth', -20);
        break;
      case 'explode':
        this.noiseBurst(dest, t, 0.7, 'lowpass', 500, 0.7, 0.9);
        this.tone(dest, t, 90, 0.5, 0.5, 'sawtooth', -60);
        break;
      case 'fizz':
        this.noiseBurst(dest, t, 0.5, 'highpass', 3000, 0.6, 0.22, true);
        break;
      case 'arrow':
        this.noiseBurst(dest, t, 0.2, 'bandpass', 1800, 1.2, 0.22);
        this.tone(dest, t, 300, 0.1, 0.12, 'triangle', 500);
        break;
      case 'portal':
        [0, 7, 12].forEach((s, k) => this.tone(dest, t + k * 0.12, 220 * 2 ** (s / 12), 0.8, 0.12, 'sine', 40));
        break;
      case 'shield':
        this.noiseBurst(dest, t, 0.08, 'bandpass', 1200, 3, 0.4);
        this.tone(dest, t, 520, 0.12, 0.2, 'square', -200);
        break;
      case 'fireball':
        this.noiseBurst(dest, t, 0.4, 'bandpass', 900, 0.8, 0.35);
        this.tone(dest, t, 180, 0.35, 0.2, 'sawtooth', 160);
        break;
      case 'levelup':
        [0, 4, 7, 12].forEach((s, k) => this.tone(dest, t + k * 0.09, 440 * 2 ** (s / 12), 0.2, 0.14, 'triangle'));
        break;
      default:
        break;
    }
  }

  // ---- Ambient beds -------------------------------------------------------------------------

  startAmbient() {
    const c = this.ctx;
    const loop = (type, freq, q) => {
      const src = c.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = c.createGain();
      g.gain.value = 0;
      src.connect(f);
      f.connect(g);
      g.connect(this.ambient);
      src.start();
      return { src, f, g };
    };
    this.windBed = loop('lowpass', 380, 0.4);
    this.rainBed = loop('bandpass', 2600, 0.4);
    this.caveBed = loop('lowpass', 140, 1.2);
    this.waterBed = loop('lowpass', 520, 0.6);
  }

  /** levels in 0..1 for wind (open surface), rain, cave (underground), water (submerged). */
  setAmbient(levels, dt) {
    if (!this.ctx || !this.windBed) return;
    const t = this.ctx.currentTime;
    const s = this.ambientState;
    for (const k of Object.keys(s)) s[k] += ((levels[k] ?? 0) - s[k]) * Math.min(1, dt * 1.5);
    const gust = 0.6 + 0.4 * Math.sin(t * 0.37) * Math.sin(t * 0.13 + 1);
    this.windBed.g.gain.setTargetAtTime(s.wind * 0.1 * gust, t, 0.3);
    this.windBed.f.frequency.setTargetAtTime(300 + gust * 260, t, 0.5);
    this.rainBed.g.gain.setTargetAtTime(s.rain * 0.16, t, 0.3);
    this.caveBed.g.gain.setTargetAtTime(s.cave * 0.14, t, 0.5);
    this.waterBed.g.gain.setTargetAtTime(s.water * 0.25, t, 0.2);
    // Occasional cave drips.
    if (s.cave > 0.4 && Math.random() < dt * 0.25) {
      const g = this.out(0.25 * s.cave, Math.random() * 1.4 - 0.7, this.ambient);
      this.tone(g, t, 1400 + Math.random() * 900, 0.12, 0.2, 'sine', -600);
    }
    this.updateMusic(dt);
  }

  /** Sparse generative melody: a few soft pentatonic notes every minute or two. */
  updateMusic(dt) {
    if (this.settings.get('musicVolume') <= 0) return;
    this.musicTimer -= dt;
    if (this.musicTimer > 0) return;
    this.musicTimer = 70 + Math.random() * 110;
    const c = this.ctx;
    const t = c.currentTime + 0.1;
    const root = 196 * 2 ** ([0, 3, 5, 7][Math.floor(Math.random() * 4)] / 12);
    const delay = c.createDelay(1);
    delay.delayTime.value = 0.42;
    const fb = c.createGain();
    fb.gain.value = 0.35;
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(this.music);
    const notes = 6 + Math.floor(Math.random() * 6);
    let at = t;
    for (let i = 0; i < notes; i++) {
      const f = root * 2 ** (PENTA[Math.floor(Math.random() * PENTA.length)] / 12);
      const dur = 0.9 + Math.random() * 1.4;
      const o = c.createOscillator();
      o.type = i % 3 === 0 ? 'sine' : 'triangle';
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.09, at + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g);
      g.connect(this.music);
      g.connect(delay);
      o.start(at);
      o.stop(at + dur + 0.1);
      at += 0.5 + Math.random() * 0.9;
    }
  }
}
