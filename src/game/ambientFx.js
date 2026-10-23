// Gameplay-driven particle emitters: light sources and special blocks near the player are found by
// a slow layer-by-layer scan, then emit continuously; plus weather, biome and dimension ambience
// and one-shot effects (explosions, hits, dust). Rendering is ParticleSystem's job.
import { B, SOLID, BLOCKS } from '../world/blocks.js';
import { SHAPE } from '../rendering/particles.js';

const RADIUS = 18;
const DY = 10;
const MAX_EMITTERS = 260;
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Emitter kinds by block id.
const KIND = new Uint8Array(256);
const K = { torch: 1, lantern: 2, lava: 3, glowBlock: 4, ore: 5, portal: 6, endPortal: 7, leaves: 8, spores: 9, crystal: 10, magma: 11 };
KIND[B.torch] = K.torch;
KIND[B.lantern] = K.lantern;
KIND[B.lava] = K.lava;
KIND[B.magma_block] = K.magma;
KIND[B.nether_portal] = K.portal;
KIND[B.end_portal] = K.endPortal;
KIND[B.glowcap] = K.spores;
KIND[B.void_crystal] = K.crystal;
for (const n of ['ember_block', 'lumen_stone', 'crystal_lamp', 'crystal_block', 'totem']) KIND[B[n]] = K.glowBlock;
for (const n of ['crystal_ore', 'starstone_ore', 'tidestone_ore', 'verdant_ore', 'quartz_ore', 'abyssal_ore', 'gold_ore', 'nether_gold_ore', 'ember_ore']) KIND[B[n]] = K.ore;
for (const n of ['oak_leaves', 'birch_leaves', 'dark_leaves', 'cherry_leaves']) KIND[B[n]] = K.leaves;

const GLOW_COLOR = {
  [B.ember_block]: [2.2, 0.8, 0.2], [B.lumen_stone]: [2.0, 1.8, 0.9], [B.crystal_lamp]: [0.7, 1.9, 2.1],
  [B.crystal_block]: [0.6, 1.5, 2.2], [B.totem]: [1.6, 0.5, 2.2], [B.glowcap]: [0.7, 2.0, 1.4], [B.magma_block]: [2.2, 0.8, 0.2],
};
const ORE_COLOR = {
  [B.crystal_ore]: [0.7, 1.8, 2.4], [B.starstone_ore]: [1.6, 1.3, 2.4], [B.tidestone_ore]: [0.4, 2.0, 2.0], [B.verdant_ore]: [0.5, 2.2, 0.9],
  [B.quartz_ore]: [2.2, 2.1, 2.0], [B.abyssal_ore]: [1.5, 0.6, 2.2], [B.gold_ore]: [2.4, 1.9, 0.5], [B.nether_gold_ore]: [2.4, 1.9, 0.5], [B.ember_ore]: [2.3, 0.8, 0.2],
};
const LEAF_COLOR = { [B.oak_leaves]: [0.36, 0.62, 0.2], [B.birch_leaves]: [0.62, 0.74, 0.28], [B.dark_leaves]: [0.2, 0.42, 0.16], [B.cherry_leaves]: [1.0, 0.62, 0.78] };
const WALL_TORCH = [null, [0.5, 0.85, 0.2], [0.8, 0.85, 0.5], [0.5, 0.85, 0.8], [0.2, 0.85, 0.5]];
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FIREFLY_BIOMES = new Set(['plains', 'forest', 'swamp', 'dense_forest', 'taiga']);
const BUTTERFLY_BIOMES = new Set(['plains', 'forest', 'swamp', 'cherry']);
const BUTTERFLY_COLORS = [[1.0, 0.55, 0.75], [1.0, 0.85, 0.3], [0.5, 0.75, 1.0], [1.0, 0.6, 0.3], [0.85, 0.6, 1.0]];
const LEAF_BIOMES = new Set(['forest', 'dense_forest', 'swamp', 'plains', 'taiga', 'cherry']);

export class AmbientFx {
  constructor(game) {
    this.game = game;
    this.emitters = [];
    this.pending = [];
    this.layer = 0;
    this.acc = {};
    this.fireflies = 0;
    this.butterflies = 0;
    this.wasInWater = false;
  }

  get pfx() {
    return this.game.renderer.pfx;
  }

  reset() {
    this.emitters = [];
    this.pending = [];
    this.layer = 0;
    this.pfx.clear();
  }

  /** Probability gate: true about `rate` times per second at full density. */
  tick(rate, dt) {
    return Math.random() < rate * dt * this.density;
  }

  update(dt, ctx) {
    const { eye, nightness, biome, rain, precip, underwater, dim, heightAt } = ctx;
    this.density = this.game.renderer.quality.particles;
    if (this.density <= 0.01 || dt <= 0) return;
    this.scan(eye);
    this.emitFromBlocks(dt, eye);
    this.emitMobs(dt, eye);
    this.emitAmbient(dt, eye, { nightness, biome, rain, precip, underwater, dim, heightAt });
    this.emitTrails(dt);
  }

  // ---- Block emitters (progressive scan) ----------------------------------------------------

  scan(eye) {
    const w = this.game.world;
    const cx = Math.floor(eye.x), cz = Math.floor(eye.z), cy = Math.floor(eye.y);
    const y = cy - DY + this.layer;
    if (this.layer === 0) this.pending = [];
    if (y >= 1 && y < 127) {
      for (let x = cx - RADIUS; x <= cx + RADIUS; x++) {
        for (let z = cz - RADIUS; z <= cz + RADIUS; z++) {
          const id = w.getBlock(x, y, z);
          const k = KIND[id];
          if (!k || this.pending.length >= MAX_EMITTERS) continue;
          // Plentiful blocks are thinned by a position hash so dense lava seas and forests stay cheap.
          if ((k === K.lava || k === K.magma) && (((x * 7 + z * 13 + y * 3) & 7) !== 0 || w.getBlock(x, y + 1, z) !== 0)) continue;
          if (k === K.leaves && (((x * 5 + z * 11 + y) & 15) !== 0 || w.getBlock(x, y - 1, z) !== 0)) continue;
          this.pending.push({ x, y, z, id, k, meta: w.getMeta?.(x, y, z) ?? 0 });
        }
      }
    }
    if (++this.layer > DY * 2) {
      this.layer = 0;
      this.emitters = this.pending;
    }
  }

  emitFromBlocks(dt, eye) {
    const p = this.pfx;
    const w = this.game.world;
    const cull = (RADIUS + 2) * (RADIUS + 2);
    for (const e of this.emitters) {
      const dx = e.x + 0.5 - eye.x, dz = e.z + 0.5 - eye.z;
      if (dx * dx + dz * dz > cull) continue;
      switch (e.k) {
        case K.torch: {
          const o = e.meta & 7 ? WALL_TORCH[e.meta & 7] : [0.5, 0.68, 0.5];
          if (this.tick(14, dt)) {
            p.emit('glow', {
              x: e.x + o[0] + rnd(-0.03, 0.03), y: e.y + o[1], z: e.z + o[2] + rnd(-0.03, 0.03),
              vx: rnd(-0.05, 0.05), vy: rnd(0.45, 0.9), vz: rnd(-0.05, 0.05), life: rnd(0.25, 0.5), s0: 0.1, s1: 0.02,
              r: 2.3, g: 1.15, b: 0.35, a0: 0.9, a1: 0, sway: 0.1, seed: rnd(0, 6),
            });
          }
          if (this.tick(2.2, dt)) {
            p.emit('matter', { x: e.x + o[0], y: e.y + o[1] + 0.1, z: e.z + o[2], vx: rnd(-0.04, 0.04), vy: rnd(0.4, 0.7), vz: rnd(-0.04, 0.04), life: rnd(1, 1.7), s0: 0.05, s1: 0.2, r: 0.3, g: 0.3, b: 0.32, a0: 0.4, a1: 0, sway: 0.15, seed: rnd(0, 6) });
          }
          if (this.tick(0.9, dt)) {
            p.emit('glow', { x: e.x + o[0], y: e.y + o[1], z: e.z + o[2], vx: rnd(-0.5, 0.5), vy: rnd(0.8, 1.6), vz: rnd(-0.5, 0.5), life: rnd(0.5, 0.9), s0: 0.07, s1: 0.03, r: 2.6, g: 1.6, b: 0.5, shape: SHAPE.spark, grav: 1.5, a0: 1, a1: 0 });
          }
          break;
        }
        case K.lantern:
          if (this.tick(3, dt)) p.emit('glow', { x: e.x + rnd(0.3, 0.7), y: e.y + rnd(0.1, 0.5), z: e.z + rnd(0.3, 0.7), vy: rnd(0.15, 0.4), life: rnd(1, 1.8), s0: 0.05, s1: 0.02, r: 2.0, g: 1.3, b: 0.5, sway: 0.2, seed: rnd(0, 6), flick: 9 });
          break;
        case K.lava:
        case K.magma:
          if (this.tick(e.k === K.lava ? 1.6 : 0.8, dt)) {
            p.emit('glow', {
              x: e.x + rnd(0.1, 0.9), y: e.y + 1.02, z: e.z + rnd(0.1, 0.9), vx: rnd(-0.4, 0.4), vy: rnd(1.4, 3), vz: rnd(-0.4, 0.4),
              life: rnd(0.6, 1.3), s0: 0.06, s1: 0.015, r: 2.4, g: 0.9, b: 0.15, grav: 4.5, a0: 1, a1: 0, shape: Math.random() < 0.4 ? SHAPE.spark : SHAPE.soft,
            });
          }
          if (e.k === K.lava && this.tick(0.25, dt)) {
            p.emit('matter', { x: e.x + rnd(0.2, 0.8), y: e.y + 1.05, z: e.z + rnd(0.2, 0.8), vy: rnd(0.5, 0.9), life: rnd(1.4, 2.2), s0: 0.1, s1: 0.4, r: 0.22, g: 0.2, b: 0.2, a0: 0.3, a1: 0, sway: 0.2, seed: rnd(0, 6) });
          }
          break;
        case K.glowBlock:
        case K.spores: {
          const c = GLOW_COLOR[e.id];
          if (this.tick(e.k === K.spores ? 1.4 : 1.8, dt)) {
            const f = FACES[Math.floor(Math.random() * 6)];
            p.emit('glow', { x: e.x + 0.5 + f[0] * 0.55 + rnd(-0.3, 0.3), y: e.y + 0.5 + f[1] * 0.55 + rnd(-0.3, 0.3), z: e.z + 0.5 + f[2] * 0.55 + rnd(-0.3, 0.3), vy: rnd(0.15, 0.45), vx: rnd(-0.1, 0.1), life: rnd(1.2, 2.4), s0: 0.05, s1: 0.015, r: c[0], g: c[1], b: c[2], sway: 0.25, seed: rnd(0, 6), flick: rnd(5, 9) });
          }
          break;
        }
        case K.ore:
          if (this.tick(0.45, dt)) {
            const f = pick(FACES);
            if (!SOLID[w.getBlock(e.x + f[0], e.y + f[1], e.z + f[2])]) {
              const c = ORE_COLOR[e.id];
              p.emit('glow', { x: e.x + 0.5 + f[0] * 0.53 + rnd(-0.35, 0.35) * (1 - Math.abs(f[0])), y: e.y + 0.5 + f[1] * 0.53 + rnd(-0.35, 0.35) * (1 - Math.abs(f[1])), z: e.z + 0.5 + f[2] * 0.53 + rnd(-0.35, 0.35) * (1 - Math.abs(f[2])), life: rnd(0.5, 0.9), s0: 0.02, s1: 0.2, r: c[0], g: c[1], b: c[2], shape: SHAPE.spark, a0: 1, a1: 0, rot: rnd(0, 1.5), spin: rnd(-1, 1) });
            }
          }
          break;
        case K.portal: {
          if (this.tick(7, dt)) {
            const alongZ = e.meta & 1;
            const u = rnd(0.05, 0.95);
            p.emit('glow', {
              x: e.x + (alongZ ? 0.5 + rnd(-0.12, 0.12) : u), y: e.y + rnd(0, 1), z: e.z + (alongZ ? u : 0.5 + rnd(-0.12, 0.12)),
              vx: alongZ ? 0 : rnd(-0.3, 0.3), vz: alongZ ? rnd(-0.3, 0.3) : 0, vy: rnd(-0.1, 0.5), life: rnd(0.8, 1.6), s0: 0.07, s1: 0.015,
              r: rnd(1.0, 1.6), g: 0.3, b: rnd(1.8, 2.5), a0: 0.9, a1: 0, sway: 0.25, seed: rnd(0, 6), shape: Math.random() < 0.3 ? SHAPE.spark : SHAPE.soft,
            });
          }
          break;
        }
        case K.endPortal:
          if (this.tick(5, dt)) p.emit('glow', { x: e.x + rnd(0, 1), y: e.y + 0.7, z: e.z + rnd(0, 1), vy: rnd(0.4, 1), life: rnd(1, 2), s0: 0.06, s1: 0.02, r: 0.5, g: 1.8, b: 1.5, sway: 0.2, seed: rnd(0, 6), flick: 6 });
          break;
        case K.crystal: {
          if (this.tick(6, dt)) {
            const a = rnd(0, 6.28), r = 0.6 + rnd(0, 0.5);
            p.emit('glow', { x: e.x + 0.5 + Math.cos(a) * r, y: e.y + rnd(0, 1.4), z: e.z + 0.5 + Math.sin(a) * r, vy: rnd(0.3, 0.9), vx: -Math.sin(a) * 0.7, vz: Math.cos(a) * 0.7, life: rnd(0.8, 1.5), s0: 0.08, s1: 0.02, r: 1.7, g: 0.6, b: 2.4, shape: SHAPE.spark, a0: 1, a1: 0, rot: rnd(0, 1.5) });
          }
          break;
        }
        case K.leaves:
          if (this.leafy && this.tick(e.id === B.cherry_leaves ? 0.9 : 0.3, dt)) {
            const c = LEAF_COLOR[e.id];
            const b = this.dayBright;
            p.emit('matter', { x: e.x + rnd(0.1, 0.9), y: e.y - 0.05, z: e.z + rnd(0.1, 0.9), vx: rnd(-0.2, 0.2), vy: -rnd(0.7, 1.1), vz: rnd(-0.2, 0.2), life: rnd(5, 8), s0: 0.11, s1: 0.1, r: c[0] * b, g: c[1] * b, b: c[2] * b, a0: 0.95, a1: 0.9, shape: SHAPE.leaf, rot: rnd(0, 6), spin: rnd(-2.5, 2.5), sway: 0.7, swayF: rnd(1.5, 3), seed: rnd(0, 6), coll: true });
          }
          break;
        default:
          break;
      }
    }
  }

  // ---- Creatures with glowing or magical bodies --------------------------------------------

  emitMobs(dt, eye) {
    const p = this.pfx;
    for (const m of this.game.entities.mobs) {
      if (m.dead) continue;
      const dx = m.pos.x - eye.x, dz = m.pos.z - eye.z;
      if (dx * dx + dz * dz > 900) continue;
      const cy = m.pos.y + m.height * rnd(0.1, 0.9);
      switch (m.type) {
        case 'emberling':
        case 'magmaling':
        case 'cinderhound':
          if (this.tick(m.type === 'cinderhound' ? 4 : 9, dt)) p.emit('glow', { x: m.pos.x + rnd(-0.3, 0.3), y: cy, z: m.pos.z + rnd(-0.3, 0.3), vy: rnd(0.6, 1.3), life: rnd(0.35, 0.7), s0: 0.14, s1: 0.02, r: 2.4, g: 1.0, b: 0.25, sway: 0.2, seed: rnd(0, 6) });
          break;
        case 'wisp':
          if (this.tick(10, dt)) p.emit('glow', { x: m.pos.x + rnd(-0.2, 0.2), y: cy, z: m.pos.z + rnd(-0.2, 0.2), vy: rnd(-0.1, 0.3), life: rnd(0.6, 1.1), s0: 0.1, s1: 0.01, r: 0.6, g: 1.8, b: 2.4, sway: 0.3, seed: rnd(0, 6) });
          break;
        case 'voidstalker':
        case 'void_drake':
          if (this.tick(m.type === 'void_drake' ? 30 : 8, dt)) {
            const s = m.type === 'void_drake' ? 1.6 : 0.4;
            p.emit('glow', { x: m.pos.x + rnd(-s, s), y: m.pos.y + rnd(0, m.height), z: m.pos.z + rnd(-s, s), vy: rnd(-0.6, 0.6), vx: rnd(-0.3, 0.3), life: rnd(0.6, 1.2), s0: 0.1, s1: 0.02, r: 1.5, g: 0.5, b: 2.4, sway: 0.3, seed: rnd(0, 6), shape: Math.random() < 0.3 ? SHAPE.spark : SHAPE.soft });
          }
          break;
        case 'blastling':
          if (m.fuse >= 0 && this.tick(26, dt)) p.emit('glow', { x: m.pos.x + rnd(-0.25, 0.25), y: m.pos.y + m.height + rnd(0, 0.2), z: m.pos.z + rnd(-0.25, 0.25), vy: rnd(1, 2), life: rnd(0.2, 0.4), s0: 0.1, s1: 0.02, r: 2.6, g: 2.0, b: 0.6, shape: SHAPE.spark, grav: 2 });
          break;
        case 'gloop':
          if (this.tick(0.6, dt)) p.emit('matter', { x: m.pos.x + rnd(-0.2, 0.2), y: m.pos.y + 0.05, z: m.pos.z + rnd(-0.2, 0.2), life: 0.5, s0: 0.1, s1: 0.2, r: 0.4, g: 0.8, b: 0.4, a0: 0.5, a1: 0 });
          break;
        default:
          break;
      }
    }
  }

  // ---- Weather, biome and dimension ambience ------------------------------------------------

  emitAmbient(dt, eye, { nightness, biome, rain, precip, underwater, dim, heightAt }) {
    const p = this.pfx;
    this.leafy = dim === 'overworld' && LEAF_BIOMES.has(biome?.key) && rain < 0.5;
    this.dayBright = Math.max(0.35, 1 - nightness * 0.75);
    const around = (r) => ({ x: eye.x + rnd(-r, r), z: eye.z + rnd(-r, r) });

    if (dim === 'overworld' && !underwater) {
      // Fireflies drift above the grass at night.
      if (nightness > 0.45 && FIREFLY_BIOMES.has(biome?.key) && rain < 0.3 && this.fireflies < 70 && this.tick(5 * nightness, dt)) {
        const { x, z } = around(11);
        const ground = heightAt(Math.floor(x), Math.floor(z));
        if (ground > 0 && Math.abs(ground - eye.y) < 14) {
          this.fireflies++;
          const life = rnd(6, 10);
          setTimeout(() => this.fireflies--, life * 1000);
          p.emit('glow', { x, y: ground + rnd(0.4, 2.4), z, vx: rnd(-0.15, 0.15), vy: rnd(-0.05, 0.1), vz: rnd(-0.15, 0.15), life, s0: 0.07, s1: 0.07, r: 1.6, g: 2.1, b: 0.45, a0: 1, a1: 0.8, sway: 0.55, swayF: rnd(0.8, 1.6), seed: rnd(0, 6), flick: rnd(2, 5), fadeIn: 1 });
        }
      }
      // Butterflies flutter over meadows in daylight.
      if (nightness < 0.3 && rain < 0.2 && BUTTERFLY_BIOMES.has(biome?.key) && this.butterflies < 14 && this.tick(0.7, dt)) {
        const { x, z } = around(10);
        const ground = heightAt(Math.floor(x), Math.floor(z));
        if (ground > 0 && Math.abs(ground - eye.y) < 10) {
          this.butterflies++;
          const life = rnd(12, 20);
          setTimeout(() => this.butterflies--, life * 1000);
          const c = pick(BUTTERFLY_COLORS);
          const b = 0.55 + 0.45 * (1 - nightness);
          p.emit('matter', { x, y: ground + rnd(0.6, 1.8), z, vx: rnd(-0.3, 0.3), vy: rnd(-0.05, 0.1), vz: rnd(-0.3, 0.3), life, s0: 0.09, s1: 0.09, r: c[0] * b, g: c[1] * b, b: c[2] * b, a0: 1, a1: 1, shape: SHAPE.square, sway: 0.9, swayF: rnd(1.4, 2.4), seed: rnd(0, 6), flick: rnd(22, 30), fadeIn: 1 });
        }
      }
      // Rain splashes where drops hit the ground.
      if (precip === 'rain' && rain > 0.15) {
        const n = Math.round(24 * rain * dt * this.density + Math.random());
        for (let i = 0; i < Math.min(3, n); i++) {
          const { x, z } = around(9);
          const g = heightAt(Math.floor(x), Math.floor(z));
          if (g < 0 || Math.abs(g - eye.y) > 12) continue;
          p.emit('matter', { x, y: g + 0.05, z, vx: rnd(-0.5, 0.5), vy: rnd(1.2, 2.2), vz: rnd(-0.5, 0.5), life: rnd(0.25, 0.4), s0: 0.04, s1: 0.025, r: 0.75, g: 0.85, b: 1, a0: 0.7, a1: 0, grav: 12 });
          p.emit('matter', { x, y: g + 0.03, z, life: 0.35, s0: 0.05, s1: 0.45, r: 0.8, g: 0.9, b: 1, a0: 0.35, a1: 0, shape: SHAPE.ring });
        }
      }
    }
    if (dim === 'nether') {
      if (this.tick(14, dt)) {
        const { x, z } = around(12);
        p.emit('glow', { x, y: eye.y + rnd(-5, 8), z, vx: rnd(0.1, 0.5), vy: rnd(0.15, 0.6), vz: rnd(-0.2, 0.2), life: rnd(4, 7), s0: 0.06, s1: 0.03, r: 2.2, g: 0.8, b: 0.2, a0: 0.9, a1: 0, sway: 0.6, seed: rnd(0, 6), flick: rnd(3, 7) });
      }
      if (this.tick(8, dt)) {
        const { x, z } = around(12);
        p.emit('matter', { x, y: eye.y + rnd(-2, 10), z, vx: rnd(0.2, 0.7), vy: -rnd(0.1, 0.35), vz: rnd(-0.2, 0.2), life: rnd(5, 8), s0: 0.07, s1: 0.07, r: 0.42, g: 0.34, b: 0.32, a0: 0.55, a1: 0.4, sway: 0.5, seed: rnd(0, 6), shape: SHAPE.square, rot: rnd(0, 3), spin: rnd(-1, 1) });
      }
    } else if (dim === 'end') {
      if (this.tick(12, dt)) {
        const { x, z } = around(13);
        p.emit('glow', { x, y: eye.y + rnd(-9, 10), z, vy: rnd(0.2, 0.7), vx: rnd(-0.2, 0.2), life: rnd(5, 9), s0: 0.05, s1: 0.05, r: rnd(1.0, 1.6), g: 0.7, b: 2.2, a0: 0.8, a1: 0.5, sway: 0.5, seed: rnd(0, 6), flick: rnd(2, 4), fadeIn: 1 });
      }
    }
    if (underwater) {
      if (this.tick(6, dt)) {
        const { x, z } = around(3.5);
        p.emit('matter', { x, y: eye.y + rnd(-2, 1), z, vy: rnd(0.5, 1.1), vx: rnd(-0.05, 0.05), life: rnd(1.5, 3), s0: 0.03, s1: 0.045, r: 0.8, g: 0.95, b: 1, a0: 0.45, a1: 0.1, shape: SHAPE.ring, sway: 0.15, seed: rnd(0, 6) });
      }
      if (this.tick(4, dt)) {
        const { x, z } = around(6);
        p.emit('glow', { x, y: eye.y + rnd(-3, 3), z, vy: rnd(0.02, 0.1), life: rnd(3, 5), s0: 0.03, s1: 0.03, r: 0.5, g: 1.2, b: 1.6, a0: 0.6, a1: 0.2, sway: 0.2, seed: rnd(0, 6), fadeIn: 0.8 });
      }
    }
  }

  // ---- Projectile trails -------------------------------------------------------------------

  emitTrails(dt) {
    const p = this.pfx;
    for (const pr of this.game.entities.projectiles) {
      if (pr.kind === 'fireball') {
        if (this.tick(60, dt)) p.emit('glow', { x: pr.pos.x + rnd(-0.1, 0.1), y: pr.pos.y + rnd(-0.1, 0.1), z: pr.pos.z + rnd(-0.1, 0.1), life: rnd(0.25, 0.45), s0: 0.22, s1: 0.03, r: 2.4, g: 1.0, b: 0.25, a0: 0.9, a1: 0 });
        if (this.tick(20, dt)) p.emit('matter', { x: pr.pos.x, y: pr.pos.y, z: pr.pos.z, vy: 0.5, life: rnd(0.6, 1), s0: 0.1, s1: 0.35, r: 0.25, g: 0.23, b: 0.23, a0: 0.4, a1: 0 });
      } else if (pr.kind === 'arrow' && this.tick(30, dt)) {
        p.emit('glow', { x: pr.pos.x, y: pr.pos.y, z: pr.pos.z, life: 0.25, s0: 0.05, s1: 0.01, r: 1.0, g: 1.0, b: 1.1, a0: 0.5, a1: 0 });
      }
    }
  }

  /** Green sparkles when something grows (bone meal). */
  grow(x, y, z) {
    for (let i = 0; i < 14; i++) {
      this.pfx.emit('glow', { x: x + rnd(0, 1), y: y + rnd(0.2, 1.3), z: z + rnd(0, 1), vy: rnd(0.4, 1.2), life: rnd(0.6, 1.2), s0: 0.1, s1: 0.02, r: 0.5, g: 2.2, b: 0.8, shape: SHAPE.spark, rot: rnd(0, 1.5), spin: rnd(-2, 2), sway: 0.2, seed: rnd(0, 6) });
    }
  }

  /** Little twinkle when an item is picked up. */
  pickup(x, y, z) {
    for (let i = 0; i < 4; i++) this.pfx.emit('glow', { x: x + rnd(-0.2, 0.2), y: y + rnd(0.1, 0.5), z: z + rnd(-0.2, 0.2), vy: rnd(0.5, 1.2), life: rnd(0.3, 0.5), s0: 0.08, s1: 0.01, r: 1.8, g: 1.8, b: 1.2, shape: SHAPE.spark });
  }

  /** Flame at a torch held in hand: just ahead of the camera, lower right. */
  heldFlame(dt, eye, yaw, pitch) {
    if (!this.tick(10, dt)) return;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const fwd = [-sy * cp, sp, -cy * cp], right = [cy, 0, -sy], up = [sy * sp, cp, cy * sp];
    const o = [0.78, 0.2, -0.22];
    const px = eye.x + fwd[0] * o[0] + right[0] * o[1] + up[0] * o[2];
    const py = eye.y + fwd[1] * o[0] + right[1] * o[1] + up[1] * o[2] + 0.12;
    const pz = eye.z + fwd[2] * o[0] + right[2] * o[1] + up[2] * o[2];
    this.pfx.emit('glow', { x: px, y: py, z: pz, vy: rnd(0.4, 0.8), life: rnd(0.2, 0.4), s0: 0.06, s1: 0.015, r: 2.3, g: 1.15, b: 0.35, a0: 0.9, a1: 0 });
  }

  /** Splash when the player enters or leaves water, plus a wake while swimming. */
  waterEffects(dt, p) {
    const w = this.game.world;
    if (p.inWater !== this.wasInWater) {
      this.wasInWater = p.inWater;
      let y = Math.floor(p.pos.y);
      for (let i = 0; i < 4 && w.getBlock(Math.floor(p.pos.x), y + 1, Math.floor(p.pos.z)) === B.water; i++) y++;
      this.splash(p.pos.x, y + 0.9, p.pos.z, Math.min(1.6, 0.6 + Math.abs(p.vel.y) * 0.08));
    } else if (p.inWater && !p.headInWater && Math.hypot(p.vel.x, p.vel.z) > 1.2 && this.tick(14, dt)) {
      this.pfx.emit('matter', { x: p.pos.x + rnd(-0.3, 0.3), y: Math.floor(p.pos.y + 0.9) + 0.85, z: p.pos.z + rnd(-0.3, 0.3), life: 0.7, s0: 0.1, s1: 0.7, r: 0.85, g: 0.95, b: 1, a0: 0.4, a1: 0, shape: SHAPE.ring });
    }
  }

  splash(x, y, z, power = 1) {
    for (let i = 0; i < 16 * power; i++) {
      const a = rnd(0, 6.28), s = rnd(0.6, 2.2) * power;
      this.pfx.emit('matter', { x, y, z, vx: Math.cos(a) * s, vy: rnd(2, 5) * power, vz: Math.sin(a) * s, life: rnd(0.4, 0.8), s0: 0.06, s1: 0.03, r: 0.8, g: 0.9, b: 1, a0: 0.85, a1: 0, grav: 14 });
    }
    for (let i = 0; i < 2; i++) this.pfx.emit('matter', { x, y, z, life: 0.7 + i * 0.2, s0: 0.2, s1: 1.4 + i * 0.6, r: 0.9, g: 0.97, b: 1, a0: 0.5, a1: 0, shape: SHAPE.ring });
  }

  // ---- One-shot effects --------------------------------------------------------------------

  /** Soft dust puff. color: [r, g, b] 0..1 already lit. */
  dust(x, y, z, color, n = 4, spread = 0.25) {
    for (let i = 0; i < n; i++) {
      this.pfx.emit('matter', { x: x + rnd(-spread, spread), y: y + 0.05, z: z + rnd(-spread, spread), vx: rnd(-0.5, 0.5), vy: rnd(0.2, 0.7), vz: rnd(-0.5, 0.5), life: rnd(0.4, 0.8), s0: 0.1, s1: 0.32, r: color[0], g: color[1], b: color[2], a0: 0.45, a1: 0, drag: 2, seed: rnd(0, 6) });
    }
  }

  /** Floor color for dust under the player: sampled from the block's average tint. */
  footDust(x, y, z, bright, n = 3) {
    const id = this.game.world.getBlock(Math.floor(x), Math.floor(y - 0.2), Math.floor(z));
    const d = BLOCKS[id];
    if (!d) return;
    const c = DUST[d.sound] || DUST.stone;
    this.dust(x, y, z, [c[0] * bright, c[1] * bright, c[2] * bright], n);
  }

  hit(x, y, z) {
    for (let i = 0; i < 6; i++) {
      this.pfx.emit('glow', { x, y, z, vx: rnd(-2.5, 2.5), vy: rnd(0.5, 3), vz: rnd(-2.5, 2.5), life: rnd(0.2, 0.4), s0: 0.1, s1: 0.02, r: 2.4, g: 1.4, b: 0.5, shape: SHAPE.spark, grav: 8, rot: rnd(0, 3) });
    }
  }

  poof(x, y, z, bright = 1, n = 14) {
    for (let i = 0; i < n; i++) {
      const a = rnd(0, 6.28), s = rnd(0.5, 1.8);
      this.pfx.emit('matter', { x, y: y + rnd(0, 0.5), z, vx: Math.cos(a) * s, vy: rnd(0.3, 1.2), vz: Math.sin(a) * s, life: rnd(0.5, 0.9), s0: 0.2, s1: 0.5, r: 0.85 * bright, g: 0.85 * bright, b: 0.88 * bright, a0: 0.7, a1: 0, drag: 2.5, seed: rnd(0, 6) });
    }
    for (let i = 0; i < 6; i++) this.pfx.emit('glow', { x, y: y + 0.3, z, vx: rnd(-1.5, 1.5), vy: rnd(0.5, 2), vz: rnd(-1.5, 1.5), life: rnd(0.4, 0.8), s0: 0.1, s1: 0.01, r: 1.6, g: 1.7, b: 2.0, shape: SHAPE.spark, grav: 2 });
  }

  explosion(x, y, z, radius = 3) {
    const n = Math.round(30 + radius * 14);
    for (let i = 0; i < n; i++) {
      const a = rnd(0, 6.28), e = rnd(-1, 1), s = rnd(2, 6 + radius * 1.5);
      const hs = Math.sqrt(1 - e * e);
      this.pfx.emit('glow', { x, y, z, vx: Math.cos(a) * hs * s, vy: e * s * 0.8, vz: Math.sin(a) * hs * s, life: rnd(0.35, 0.8), s0: 0.45 + radius * 0.1, s1: 0.05, r: 2.6, g: rnd(0.8, 1.6), b: 0.2, a0: 1, a1: 0, drag: 3.2 });
    }
    for (let i = 0; i < n * 0.7; i++) {
      const a = rnd(0, 6.28), e = rnd(-0.3, 1), s = rnd(1, 3 + radius);
      const hs = Math.sqrt(1 - e * e);
      this.pfx.emit('matter', { x, y, z, vx: Math.cos(a) * hs * s, vy: e * s + 0.5, vz: Math.sin(a) * hs * s, life: rnd(0.9, 1.9), s0: 0.5, s1: 1.6 + radius * 0.3, r: 0.2, g: 0.19, b: 0.19, a0: 0.6, a1: 0, drag: 1.6, seed: rnd(0, 6) });
    }
    for (let i = 0; i < 18; i++) {
      this.pfx.emit('glow', { x, y, z, vx: rnd(-8, 8), vy: rnd(0, 8), vz: rnd(-8, 8), life: rnd(0.4, 1), s0: 0.1, s1: 0.02, r: 2.6, g: 2.0, b: 0.8, shape: SHAPE.spark, grav: 12, rot: rnd(0, 3) });
    }
  }

  teleport(x, y, z) {
    for (let i = 0; i < 24; i++) {
      this.pfx.emit('glow', { x: x + rnd(-0.4, 0.4), y: y + rnd(0, 1.8), z: z + rnd(-0.4, 0.4), vx: rnd(-1, 1), vy: rnd(-0.5, 1.5), vz: rnd(-1, 1), life: rnd(0.5, 1.1), s0: 0.12, s1: 0.02, r: 1.6, g: 0.5, b: 2.4, shape: i % 3 ? SHAPE.soft : SHAPE.spark });
    }
  }
}

const DUST = {
  grass: [0.34, 0.5, 0.22], gravel: [0.5, 0.48, 0.46], sand: [0.8, 0.72, 0.5], snow: [0.9, 0.93, 0.98], stone: [0.5, 0.5, 0.52], wood: [0.5, 0.38, 0.24], wool: [0.8, 0.8, 0.8],
};
