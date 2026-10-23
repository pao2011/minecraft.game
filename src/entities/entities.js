// Entity manager: creatures, dropped items and projectiles; spawning rules and limits.
import * as THREE from 'three';
import { Mob } from './mob.js';
import { MOBS, HOSTILE_TYPES, NETHER_TYPES, END_TYPES } from './mobs.js';
import { moveEntity, collidesAt } from './physics.js';
import { buildMobModel } from '../rendering/mobModels.js';
import { iconCanvas } from '../rendering/icons.js';
import { rayBox } from '../world/raycast.js';
import { B, SOLID, BLOCKS } from '../world/blocks.js';
import { TILE } from '../world/tiles.js';
import { ENTITY_LIMITS, WORLD_HEIGHT, DIFFICULTY } from '../config/constants.js';
import { BIOMES } from '../world/biomes.js';
import { parsePosKey } from '../world/coords.js';

const HOTBAR_FIRST = [...Array(36).keys()];

// Creatures that emit light: their color goes above 1.0 so the glow pass picks them up.
const GLOWING = { emberling: 1.7, magmaling: 1.5, wisp: 2.1, cinderhound: 1.15, void_drake: 1.1, voidstalker: 1.1 };

export class EntityManager {
  constructor(game) {
    this.game = game;
    this.mobs = [];
    this.items = [];
    this.projectiles = [];
    this.spawnTimer = 2;
    this.spawnerTimers = new Map();
    this.iconTextures = new Map();
    this.group = new THREE.Group();
    game.renderer.scene.add(this.group);
    this.boneGeo = new THREE.BoxGeometry(0.12, 0.12, 0.45);
    this.boneMat = new THREE.MeshBasicMaterial({ color: 0xe6e2cf });
    this.fireGeo = new THREE.BoxGeometry(0.38, 0.38, 0.38);
    this.fireMat = new THREE.MeshBasicMaterial({ color: 0xff8a2a });
    this.arrowGeo = new THREE.BoxGeometry(0.06, 0.06, 0.7);
    this.arrowMat = new THREE.MeshBasicMaterial({ color: 0xcdb88a });
    this.boss = null;
  }

  get world() {
    return this.game.world;
  }

  get player() {
    return this.game.player;
  }

  // ---- Creatures ----------------------------------------------------------------------------

  spawnMob(type, pos, health) {
    if (!MOBS[type]) return null;
    const m = new Mob(type, pos);
    if (health) m.health = Math.min(health, m.def.health);
    m.model = buildMobModel(m.def);
    this.group.add(m.model.root);
    this.mobs.push(m);
    this.syncModel(m, 0);
    return m;
  }

  removeMob(m) {
    this.group.remove(m.model.root);
    m.model.material.dispose();
    m.removed = true;
  }

  /** Player melee hit. Returns true if the mob died. */
  attackMob(m, damage, from) {
    const killed = m.hurt(damage, from, 6);
    this.game.ambient.hit(m.pos.x, m.pos.y + m.height * 0.6, m.pos.z);
    this.game.audio.play(`${m.def.sound}_hurt`, { pos: m.pos });
    if (killed) this.onDeath(m);
    return killed;
  }

  onDeath(m) {
    this.game.audio.play(`${m.def.sound}_death`, { pos: m.pos });
    for (const [id, lo, hi, chance = 1] of m.def.drops) {
      if (Math.random() >= chance) continue;
      const n = lo + Math.floor(Math.random() * (hi - lo + 1));
      if (n > 0) this.spawnItem({ id, count: n }, { x: m.pos.x, y: m.pos.y + 0.5, z: m.pos.z });
    }
    if (m.def.boss) this.game.onBossKilled?.(m);
    const b = this.lightAt(m.pos.x, m.pos.y + 0.5, m.pos.z);
    this.game.renderer.spawnBlockParticles(Math.floor(m.pos.x), Math.floor(m.pos.y), Math.floor(m.pos.z), TILE.wool, b * 0.8, 10);
    this.game.ambient.poof(m.pos.x, m.pos.y + 0.2, m.pos.z, Math.max(0.4, b), m.def.boss ? 60 : 14);
    this.game.onMobKilled?.(m);
  }

  /** Nearest creature hit by a ray within maxDist. */
  raycast(origin, dir, maxDist) {
    let best = null;
    for (const m of this.mobs) {
      if (m.dead) continue;
      const hw = m.width / 2 + 0.1;
      const box = [m.pos.x - hw, m.pos.y, m.pos.z - hw, m.pos.x + hw, m.pos.y + m.height + 0.1, m.pos.z + hw];
      const hit = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, box);
      if (hit && hit.t <= maxDist && (!best || hit.t < best.dist)) best = { mob: m, dist: hit.t };
    }
    return best;
  }

  lightAt(x, y, z) {
    const [sky, blk] = this.world.getLight(Math.floor(x), Math.floor(y), Math.floor(z));
    return this.game.renderer.lightLevelToBrightness(sky, blk);
  }

  syncModel(m, dt) {
    const { root, body, parts, material } = m.model;
    root.position.set(m.pos.x, m.pos.y, m.pos.z);
    root.rotation.y = m.yaw;
    const speed = Math.hypot(m.vel.x, m.vel.z);
    const swing = Math.sin(m.walkPhase) * Math.min(0.8, speed * 0.35);
    let i = 0;
    for (const [name, p] of Object.entries(parts)) {
      if (name.startsWith('leg')) {
        if (m.type === 'skitter') p.rotation.y = Math.sin(m.walkPhase * 1.6 + i) * Math.min(0.5, speed * 0.15);
        else p.rotation.x = i % 2 === 0 ? swing : -swing;
        i++;
      } else if (name === 'armL' && m.type === 'bonecaster') p.rotation.x = -swing;
      else if (name === 'wingL' || name === 'wingR') {
        const flap = m.def.boss ? 0.35 : m.def.flying ? 0.8 : 0.5;
        p.rotation.z = m.onGround && !m.def.flying ? 0 : Math.sin(m.age * (m.def.boss ? 3 : 30)) * flap * (name === 'wingL' ? 1 : -1);
      } else if (name.startsWith('orbit')) p.rotation.y = m.age * 2.2 + (name.endsWith('2') || name.endsWith('3') ? Math.PI / 4 : 0);
    }
    const swell = m.fuse >= 0 ? 1 + Math.sin(m.age * 40) * 0.06 + (m.def.fuse - m.fuse) * 0.1 : 1;
    root.scale.set(swell, swell, swell);
    if (parts.head) parts.head.rotation.y = m.headYaw - m.yaw;
    if (m.dead) body.rotation.z = Math.min(Math.PI / 2, (1 - m.deathTimer) * Math.PI);
    let b = this.lightAt(m.pos.x, m.pos.y + m.height * 0.6, m.pos.z);
    if (m.hurtTimer > 0.2 || m.dead) material.color.setRGB(Math.min(1, b * 1.6 + 0.3), b * 0.35, b * 0.35);
    else if (m.burning && Math.sin(m.age * 25) > 0) material.color.setRGB(Math.min(1, b + 0.4), b * 0.7, b * 0.3);
    else if (m.fuse >= 0 && Math.sin(m.age * 30) > 0) material.color.setRGB(2.2, 2.2, 2.2);
    else if (GLOWING[m.type]) material.color.setScalar(Math.max(b, GLOWING[m.type]));
    else if (m.def.fireImmune && this.game.dim === 'nether') material.color.setScalar(Math.max(b, 0.55));
    else material.color.setScalar(b);
    void dt;
  }

  // ---- Items --------------------------------------------------------------------------------

  iconTexture(key) {
    if (!this.iconTextures.has(key)) {
      const t = new THREE.CanvasTexture(iconCanvas(key));
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      this.iconTextures.set(key, t);
    }
    return this.iconTextures.get(key);
  }

  /** Drop an item stack into the world. Merges into a nearby identical drop when possible. */
  spawnItem(stack, pos, vel = null, pickupDelay = 0.5) {
    if (!stack || stack.count <= 0) return;
    for (const it of this.items) {
      if (it.stack.id === stack.id && !it.stack.damage && !stack.damage && Math.hypot(it.pos.x - pos.x, it.pos.y - pos.y, it.pos.z - pos.z) < 1 && it.stack.count + stack.count <= 64) {
        it.stack.count += stack.count;
        it.age = Math.min(it.age, 10);
        return it;
      }
    }
    // Keep the drop count bounded: the oldest drop goes first (it would despawn soonest).
    if (this.items.length >= ENTITY_LIMITS.droppedItems) this.removeItem(this.items[0]);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.iconTexture(stack.id), alphaTest: 0.5 }));
    sprite.scale.set(0.38, 0.38, 0.38);
    this.group.add(sprite);
    const it = {
      stack: { ...stack },
      pos: { ...pos },
      vel: vel || { x: (Math.random() - 0.5) * 2.5, y: 3 + Math.random() * 1.5, z: (Math.random() - 0.5) * 2.5 },
      width: 0.25, height: 0.25, onGround: false,
      age: 0, pickupDelay, sprite, phase: Math.random() * 6,
    };
    this.items.push(it);
    return it;
  }

  removeItem(it) {
    this.group.remove(it.sprite);
    it.sprite.material.dispose();
    const i = this.items.indexOf(it);
    if (i >= 0) this.items.splice(i, 1);
  }

  updateItems(dt) {
    const p = this.player;
    for (const it of [...this.items]) {
      it.age += dt;
      it.pickupDelay -= dt;
      if (it.age > ENTITY_LIMITS.itemDespawnSeconds) {
        this.removeItem(it);
        continue;
      }
      if (!this.world.isLoaded(it.pos.x, it.pos.z)) continue;
      const inWater = this.world.getBlock(Math.floor(it.pos.x), Math.floor(it.pos.y + 0.1), Math.floor(it.pos.z)) === B.water;
      it.vel.y -= (inWater ? 2 : 22) * dt;
      if (inWater) it.vel.y = Math.min(it.vel.y + 6 * dt, 1);
      const f = it.onGround ? Math.exp(-8 * dt) : Math.exp(-0.5 * dt);
      it.vel.x *= f;
      it.vel.z *= f;
      if (collidesAt(this.world, it, it.pos)) it.pos.y += 4 * dt; // pushed out of a placed block
      else moveEntity(this.world, it, dt, { stepHeight: 0 });
      // Magnet toward the player once close.
      if (!p.dead && it.pickupDelay <= 0) {
        const dx = p.pos.x - it.pos.x, dy = p.pos.y + 0.9 - it.pos.y, dz = p.pos.z - it.pos.z;
        const d = Math.hypot(dx, dy, dz);
        if (d < ENTITY_LIMITS.pickupRadius) {
          const left = p.inventory.add(it.stack, HOTBAR_FIRST);
          if (left < it.stack.count) {
            this.game.audio.play('pickup');
            this.game.ambient.pickup(it.pos.x, it.pos.y, it.pos.z);
            this.game.onPickup?.(it.stack.id, it.stack.count - left);
          }
          if (left === 0) {
            this.removeItem(it);
            continue;
          }
          it.stack.count = left;
        } else if (d < 2.6 && p.inventory.spaceFor(it.stack) > 0) {
          it.vel.x += (dx / d) * 18 * dt;
          it.vel.y += (dy / d) * 18 * dt;
          it.vel.z += (dz / d) * 18 * dt;
        }
      }
      const bob = Math.sin(it.age * 2.5 + it.phase) * 0.06;
      it.sprite.position.set(it.pos.x, it.pos.y + 0.22 + bob, it.pos.z);
      it.sprite.material.color.setScalar(this.lightAt(it.pos.x, it.pos.y + 0.3, it.pos.z));
    }
  }

  // ---- Projectiles --------------------------------------------------------------------------

  shoot(m) {
    const p = this.player;
    const proj = m.def.projectile || { kind: 'bone', speed: 15, gravity: 9, damage: m.def.damage, radius: 0 };
    const from = { x: m.pos.x, y: m.pos.y + m.height * 0.8, z: m.pos.z };
    const to = { x: p.pos.x, y: p.pos.y + 1.2, z: p.pos.z };
    const dx = to.x - from.x, dz = to.z - from.z;
    const horiz = Math.hypot(dx, dz) || 1;
    const t = horiz / proj.speed;
    // Compensate for gravity so shots arc onto the target.
    const vy = (to.y - from.y) / t + 0.5 * proj.gravity * t;
    const spread = 0.06 * (DIFFICULTY[this.game.record.difficulty].id === 'hard' ? 0.5 : 1);
    this.addProjectile({
      pos: from, life: 6, owner: m, kind: proj.kind, gravity: proj.gravity, radius: proj.radius, damage: proj.damage,
      vel: { x: (dx / horiz + (Math.random() - 0.5) * spread) * proj.speed, y: vy, z: (dz / horiz + (Math.random() - 0.5) * spread) * proj.speed },
    });
    this.game.audio.play(proj.kind === 'fireball' ? 'fireball' : 'shoot', { pos: from });
  }

  /** The player's arrow: flies with gravity and damages the first creature it meets. */
  shootArrow(from, dir, speed, damage) {
    this.addProjectile({ pos: { ...from }, life: 8, owner: null, kind: 'arrow', fromPlayer: true, gravity: 12, radius: 0, damage, vel: { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed } });
    this.game.audio.play('arrow');
  }

  addProjectile(pr) {
    const mesh = new THREE.Mesh(pr.kind === 'fireball' ? this.fireGeo : pr.kind === 'arrow' ? this.arrowGeo : this.boneGeo, pr.kind === 'fireball' ? this.fireMat : pr.kind === 'arrow' ? this.arrowMat : this.boneMat);
    this.group.add(mesh);
    if (this.projectiles.length >= ENTITY_LIMITS.projectiles) this.removeProjectile(this.projectiles[0]);
    pr.mesh = mesh;
    this.projectiles.push(pr);
  }

  removeProjectile(pr) {
    this.group.remove(pr.mesh);
    const i = this.projectiles.indexOf(pr);
    if (i >= 0) this.projectiles.splice(i, 1);
  }

  updateProjectiles(dt) {
    const p = this.player;
    const diff = DIFFICULTY[this.game.record.difficulty];
    for (const pr of [...this.projectiles]) {
      pr.life -= dt;
      pr.vel.y -= pr.gravity * dt;
      const steps = 4;
      let gone = pr.life <= 0;
      for (let s = 0; s < steps && !gone; s++) {
        pr.pos.x += (pr.vel.x * dt) / steps;
        pr.pos.y += (pr.vel.y * dt) / steps;
        pr.pos.z += (pr.vel.z * dt) / steps;
        const id = this.world.getBlock(Math.floor(pr.pos.x), Math.floor(pr.pos.y), Math.floor(pr.pos.z));
        if (SOLID[id] && BLOCKS[id].shape === 'cube') {
          gone = true;
          if (pr.radius > 0) this.game.explode(pr.pos, pr.radius, { damage: pr.damage * diff.mobDamage * 2, destroy: true });
          else this.game.audio.play('thud', { pos: pr.pos });
        } else if (pr.fromPlayer) {
          for (const m of this.mobs) {
            if (m.dead) continue;
            const hw = m.width / 2 + 0.15;
            if (Math.abs(pr.pos.x - m.pos.x) < hw && Math.abs(pr.pos.z - m.pos.z) < hw && pr.pos.y > m.pos.y - 0.1 && pr.pos.y < m.pos.y + m.height + 0.1) {
              this.attackMob(m, pr.damage, pr.pos);
              gone = true;
              break;
            }
          }
        } else if (!p.dead && Math.abs(pr.pos.x - p.pos.x) < 0.4 && Math.abs(pr.pos.z - p.pos.z) < 0.4 && pr.pos.y > p.pos.y && pr.pos.y < p.pos.y + 1.85) {
          if (pr.radius > 0) this.game.explode(pr.pos, pr.radius, { damage: pr.damage * diff.mobDamage * 2, destroy: true });
          else this.game.survival.damage(pr.damage * diff.mobDamage, { type: 'projectile', from: pr.owner?.pos });
          gone = true;
        }
      }
      if (gone) {
        this.removeProjectile(pr);
        continue;
      }
      pr.mesh.position.set(pr.pos.x, pr.pos.y, pr.pos.z);
      pr.mesh.lookAt(pr.pos.x + pr.vel.x, pr.pos.y + pr.vel.y, pr.pos.z + pr.vel.z);
    }
  }

  // ---- Spawning -----------------------------------------------------------------------------

  /** Effective light for spawn checks: sky light scaled by time of day, or block light. */
  spawnLight(x, y, z) {
    const [sky, blk] = this.world.getLight(x, y, z);
    return Math.max(Math.round(sky * this.game.daylightLevel), blk);
  }

  surfaceY(x, z) {
    for (let y = WORLD_HEIGHT - 2; y > 1; y--) {
      const id = this.world.getBlock(x, y, z);
      if (id && (SOLID[id] || BLOCKS[id].fluid)) return SOLID[id] && !BLOCKS[id].leaves ? y + 1 : -1;
    }
    return -1;
  }

  canStand(x, y, z, height) {
    if (!SOLID[this.world.getBlock(x, y - 1, z)] || BLOCKS[this.world.getBlock(x, y - 1, z)].shape !== 'cube') return false;
    for (let h = 0; h < Math.ceil(height); h++) {
      const id = this.world.getBlock(x, y + h, z);
      if (SOLID[id] || BLOCKS[id].fluid) return false;
    }
    return true;
  }

  updateSpawning(dt) {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = 1;
    const rec = this.game.record;
    if (!rec.rules.mobSpawning) return;
    const diff = DIFFICULTY[rec.difficulty];
    const p = this.player;
    if (this.game.dim !== 'overworld') return this.updateOtherDimension(diff);
    const passive = this.mobs.filter((m) => !m.def.hostile && !m.def.ambient).length;
    const hostile = this.mobs.filter((m) => m.def.hostile).length;
    const pick = () => {
      const a = Math.random() * Math.PI * 2, d = 22 + Math.random() * 22;
      return [Math.floor(p.pos.x + Math.cos(a) * d), Math.floor(p.pos.z + Math.sin(a) * d)];
    };
    // Passive herds on grass in daylight-reachable spots.
    if (passive < ENTITY_LIMITS.passiveCap && Math.random() < 0.25) {
      const [x, z] = pick();
      if (this.world.isLoaded(x, z)) {
        const y = this.surfaceY(x, z);
        const ground = this.world.getBlock(x, y - 1, z);
        if (y > 0 && (ground === B.grass || ground === B.snow_grass) && this.world.getLight(x, y, z)[0] >= 9) {
          const biome = BIOMES[this.world.generator.column(x, z).biome];
          const type = biome.animals.length ? biome.animals[Math.floor(Math.random() * biome.animals.length)] : null;
          if (type) {
            const n = 2 + Math.floor(Math.random() * 2);
            for (let i = 0; i < n && passive + i < ENTITY_LIMITS.passiveCap; i++) {
              const sx = x + Math.floor(Math.random() * 3) - 1, sz = z + Math.floor(Math.random() * 3) - 1;
              const sy = this.surfaceY(sx, sz);
              if (sy > 0 && this.canStand(sx, sy, sz, MOBS[type].height)) this.spawnMob(type, { x: sx + 0.5, y: sy, z: sz + 0.5 });
            }
          }
        }
      }
    }
    // Hostiles in darkness: on the surface at night, underground at any time.
    if (diff.hostileCap > 0 && hostile < diff.hostileCap) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const [x, z] = pick();
        if (!this.world.isLoaded(x, z)) continue;
        const surf = this.surfaceY(x, z);
        let y = surf;
        let cave = false;
        if (Math.random() < 0.5 && p.pos.y < 60) {
          // Underground: probe a random height for an air pocket with a floor.
          const top = Math.min(surf > 0 ? surf - 4 : 60, Math.floor(p.pos.y) + 16);
          const start = 6 + Math.floor(Math.random() * Math.max(1, top - 6));
          y = -1;
          for (let yy = start; yy < top; yy++) {
            if (this.canStand(x, yy, z, 2)) {
              y = yy;
              cave = true;
              break;
            }
          }
        }
        if (y <= 0 || this.spawnLight(x, y, z) >= 7) continue;
        if (Math.hypot(x - p.pos.x, y - p.pos.y, z - p.pos.z) < 18) continue;
        const types = HOSTILE_TYPES.filter((t) => (cave ? true : !MOBS[t].caveOnly) && (!MOBS[t].caveOnly || y < 48));
        const type = cave && Math.random() < 0.45 ? 'gloomling' : types[Math.floor(Math.random() * types.length)];
        if (!this.canStand(x, y, z, MOBS[type].height)) continue;
        this.spawnMob(type, { x: x + 0.5, y, z: z + 0.5 });
        break;
      }
    }
    // Ambient cave bats: drift in darkness underground.
    const [skyHere] = this.world.getLight(Math.floor(p.pos.x), Math.floor(p.pos.y), Math.floor(p.pos.z));
    if (skyHere < 4 && p.pos.y < 50 && Math.random() < 0.3 && this.mobs.filter((m) => m.def.ambient).length < 6) {
      const x = Math.floor(p.pos.x + (Math.random() * 2 - 1) * 14), y = Math.floor(p.pos.y + Math.random() * 4), z = Math.floor(p.pos.z + (Math.random() * 2 - 1) * 14);
      if (this.world.isLoaded(x, z) && !SOLID[this.world.getBlock(x, y, z)] && !SOLID[this.world.getBlock(x, y + 1, z)] && this.world.getLight(x, y, z)[0] < 4 && Math.hypot(x - p.pos.x, z - p.pos.z) > 6) this.spawnMob('bat', { x: x + 0.5, y, z: z + 0.5 });
    }
    this.updateSpawners(diff);
  }

  /** Nether and End: hostile inhabitants only, no daylight rules. */
  updateOtherDimension(diff) {
    if (diff.hostileCap === 0) return;
    const p = this.player;
    const dim = this.game.dim;
    const pool = dim === 'nether' ? NETHER_TYPES : END_TYPES;
    const cap = dim === 'nether' ? diff.hostileCap : Math.min(5, diff.hostileCap);
    const hostile = this.mobs.filter((m) => m.def.hostile && !m.def.boss).length;
    if (hostile < cap && this.player.pos.y > -4) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const a = Math.random() * Math.PI * 2, d = 20 + Math.random() * 22;
        const x = Math.floor(p.pos.x + Math.cos(a) * d), z = Math.floor(p.pos.z + Math.sin(a) * d);
        if (!this.world.isLoaded(x, z)) continue;
        const type = pool[Math.floor(Math.random() * pool.length)];
        if (type === 'wisp' && this.mobs.filter((m) => m.type === 'wisp').length >= 2) continue;
        const def = MOBS[type];
        const y0 = Math.floor(p.pos.y) + Math.floor(Math.random() * 20) - 8;
        for (let k = 0; k < 24; k++) {
          const y = y0 + (k % 2 ? k : -k) / 2 | 0;
          if (y < 3 || y > 120) continue;
          const ok = def.flying
            ? !SOLID[this.world.getBlock(x, y, z)] && !SOLID[this.world.getBlock(x, y + 1, z)] && !SOLID[this.world.getBlock(x, y + 2, z)] && !BLOCKS[this.world.getBlock(x, y, z)].fluid
            : this.canStand(x, y, z, def.height);
          if (ok) {
            this.spawnMob(type, { x: x + 0.5, y, z: z + 0.5 });
            attempt = 99;
            break;
          }
        }
      }
    }
    this.updateSpawners(diff);
  }

  /** Spawn the Void Drake (once per End visit while it lives). */
  spawnBoss() {
    if (this.boss && !this.boss.dead && !this.boss.removed) return this.boss;
    this.boss = this.spawnMob('void_drake', { x: 0, y: 90, z: 0 });
    return this.boss;
  }

  updateSpawners(diff) {
    if (diff.hostileCap === 0) return;
    const p = this.player;
    for (const key of this.world.spawners) {
      const [x, y, z] = parsePosKey(key);
      if (Math.hypot(x - p.pos.x, y - p.pos.y, z - p.pos.z) > 16) continue;
      const t = (this.spawnerTimers.get(key) ?? 4) - 1;
      this.spawnerTimers.set(key, t);
      if (t > 0) continue;
      this.spawnerTimers.set(key, 8 + Math.random() * 8);
      const near = this.mobs.filter((m) => m.def.hostile && Math.hypot(m.pos.x - x, m.pos.z - z) < 9).length;
      if (near >= 4) continue;
      for (let i = 0; i < 6; i++) {
        const sx = x + Math.floor(Math.random() * 7) - 3, sz = z + Math.floor(Math.random() * 7) - 3;
        for (const sy of [y, y + 1, y - 1]) {
          if (this.canStand(sx, sy, sz, 2) && this.spawnLight(sx, sy, sz) < 11) {
            const pool = this.game.dim === 'nether' ? ['cinderhound', 'magmaling', 'cinderhound'] : ['shambler', 'bonecaster', 'skitter'];
            const type = pool[Math.floor(Math.random() * pool.length)];
            this.spawnMob(type, { x: sx + 0.5, y: sy, z: sz + 0.5 });
            this.game.renderer.spawnBlockParticles(sx, sy, sz, TILE.totem_side, 0.8, 8);
            return;
          }
        }
      }
    }
  }

  // ---- Main update --------------------------------------------------------------------------

  update(dt) {
    const p = this.player;
    const rec = this.game.record;
    const diff = DIFFICULTY[rec.difficulty];
    const ctx = {
      world: this.world, player: p, events: [],
      playerTargetable: !p.dead && rec.mode !== 'creative' && diff.hostileCap > 0,
      isDay: this.game.isDay && this.game.dim === 'overworld',
      dim: this.game.dim,
    };
    for (const m of this.mobs) {
      if (m.removed) continue;
      const d = Math.hypot(m.pos.x - p.pos.x, m.pos.z - p.pos.z);
      if (m.def.hostile && !m.def.boss && (d > ENTITY_LIMITS.mobDespawnDistance || diff.hostileCap === 0)) {
        this.removeMob(m);
        continue;
      }
      if (!this.world.isLoaded(m.pos.x, m.pos.z)) continue;
      if (d > ENTITY_LIMITS.mobSimulationDistance && !m.def.boss) continue; // frozen until the player returns
      // Far creatures think less often: update at a lower rate.
      m.thinkAcc = (m.thinkAcc || 0) + dt;
      const interval = d > 40 ? 0.2 : 0;
      if (m.thinkAcc < interval) {
        this.syncModel(m, dt);
        continue;
      }
      const step = Math.min(0.1, m.thinkAcc);
      m.thinkAcc = 0;
      const wasDead = m.dead;
      m.update(step, ctx);
      if (m.dead && !m.removed && !wasDead && !ctx.events.some((e) => e.mob === m && e.type === 'died')) this.onDeath(m);
      if (m.removed) {
        this.removeMob(m);
        continue;
      }
      this.syncModel(m, dt);
    }
    for (const e of ctx.events) {
      if (e.type === 'melee') {
        this.game.survival.damage(e.mob.def.damage * diff.mobDamage, { type: 'mob', from: e.mob.pos });
        this.game.audio.play(`${e.mob.def.sound}_attack`, { pos: e.mob.pos });
      } else if (e.type === 'shoot') this.shoot(e.mob);
      else if (e.type === 'sound') this.game.audio.play(`${e.mob.def.sound}_idle`, { pos: e.mob.pos });
      else if (e.type === 'died') this.onDeath(e.mob);
      else if (e.type === 'fuse') this.game.audio.play('fizz', { pos: e.mob.pos });
      else if (e.type === 'explode') this.game.explode(e.mob.pos, e.radius, { damage: 16 * diff.mobDamage, destroy: true, source: 'mob' });
      else if (e.type === 'teleport') {
        this.game.audio.play('portal', { pos: e.to, volume: 0.5 });
        this.game.ambient.teleport(e.from.x, e.from.y, e.from.z);
        this.game.ambient.teleport(e.to.x, e.to.y, e.to.z);
        this.game.renderer.spawnBlockParticles(Math.floor(e.from.x), Math.floor(e.from.y), Math.floor(e.from.z), TILE.obsidian, 0.8, 10);
        this.game.renderer.spawnBlockParticles(Math.floor(e.to.x), Math.floor(e.to.y), Math.floor(e.to.z), TILE.obsidian, 0.8, 10);
      }
    }
    // The drake is healed by every surviving void crystal.
    if (this.boss && (this.boss.dead || this.boss.removed)) this.boss = null;
    if (this.boss) this.boss.health = Math.min(this.boss.def.health, this.boss.health + this.world.crystals.size * 0.6 * dt);
    this.mobs = this.mobs.filter((m) => !m.removed);
    this.separate();
    this.updateItems(dt);
    this.updateProjectiles(dt);
    this.updateSpawning(dt);
  }

  /** Gentle push apart so herds do not stack inside each other. */
  separate() {
    const ms = this.mobs;
    for (let i = 0; i < ms.length; i++) {
      for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i], b = ms[j];
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const min = (a.width + b.width) / 2;
        const d2 = dx * dx + dz * dz;
        if (d2 > min * min || d2 < 1e-6 || Math.abs(a.pos.y - b.pos.y) > 1) continue;
        const d = Math.sqrt(d2);
        const push = (min - d) * 0.5;
        a.vel.x -= (dx / d) * push * 4;
        a.vel.z -= (dz / d) * push * 4;
        b.vel.x += (dx / d) * push * 4;
        b.vel.z += (dz / d) * push * 4;
      }
    }
  }

  /** Persist passive creatures near the player (hostiles despawn like in most sandboxes). */
  serialize() {
    return this.mobs.filter((m) => !m.dead && !m.def.hostile && !m.def.ambient).slice(0, 48).map((m) => m.toJSON());
  }

  restore(list) {
    for (const e of list || []) if (MOBS[e.type] && !MOBS[e.type].hostile) this.spawnMob(e.type, e.pos, e.health);
  }

  clear() {
    for (const m of this.mobs) this.removeMob(m);
    for (const it of [...this.items]) this.removeItem(it);
    for (const pr of [...this.projectiles]) this.removeProjectile(pr);
    this.mobs = [];
    this.boss = null;
  }

  dispose() {
    this.clear();
    this.game.renderer.scene.remove(this.group);
    for (const t of this.iconTextures.values()) t.dispose();
  }
}
