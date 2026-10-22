// Health, hunger, breath and damage rules. Damage goes through one entry point with an
// invulnerability window, so no update loop can apply it every frame.
import { PLAYER, SURVIVAL, DIFFICULTY } from '../config/constants.js';
import { ITEMS } from '../items/items.js';
import { B } from '../world/blocks.js';

const BYPASS_ARMOR = new Set(['fall', 'starve', 'drown', 'void']);
const BLOCKABLE = new Set(['mob', 'projectile']);

export class Survival {
  constructor(game) {
    this.game = game;
    this.regenTimer = 0;
    this.starveTimer = 0;
    this.drownTimer = 0;
    this.envTimer = 0;
    this.invuln = 0;
    this.lastWalk = 0;
  }

  get player() {
    return this.game.player;
  }

  get creative() {
    return this.game.record.mode === 'creative';
  }

  get difficulty() {
    return DIFFICULTY[this.game.record.difficulty];
  }

  exhaust(amount) {
    if (this.creative) return;
    this.player.exhaustion += amount * this.difficulty.hungerRate;
  }

  update(dt) {
    const p = this.player;
    if (p.dead) return;
    this.invuln = Math.max(0, this.invuln - dt);
    const diff = this.difficulty;
    // Movement costs energy.
    const walked = p.walkDist - this.lastWalk;
    this.lastWalk = p.walkDist;
    if (!p.flying && walked > 0 && walked < 5) this.exhaust(walked * (p.sprinting ? SURVIVAL.exhaustionSprintPerBlock : p.inWater ? 0.015 : SURVIVAL.exhaustionWalkPerBlock));

    for (const e of p.takeEvents()) {
      if (e === 'jump') this.exhaust(SURVIVAL.exhaustionJump);
      else if (e === 'sprintjump') this.exhaust(SURVIVAL.exhaustionSprintJump);
      else if (e === 'step') this.game.onFootstep();
      else if (e.type === 'land') {
        this.game.onLand(e.dist);
        const below = this.game.world.getBlock(Math.floor(p.pos.x), Math.floor(p.pos.y - 0.1), Math.floor(p.pos.z));
        let dmg = Math.floor(e.dist - SURVIVAL.fallDamageThreshold + 0.4);
        if (below === B.hay) dmg = Math.floor(dmg * 0.2);
        if (dmg > 0) this.damage(dmg, { type: 'fall' });
      }
    }
    if (p.dead) return;

    while (p.exhaustion >= SURVIVAL.exhaustionPerHungerPoint) {
      p.exhaustion -= SURVIVAL.exhaustionPerHungerPoint;
      if (p.saturation > 0) p.saturation = Math.max(0, p.saturation - 1);
      else if (diff.hungerRate > 0) p.hunger = Math.max(0, p.hunger - 1);
    }

    if (this.creative) {
      p.health = PLAYER.maxHealth;
      p.hunger = PLAYER.maxHunger;
      p.air = SURVIVAL.maxAir;
      return;
    }

    // Natural regeneration.
    this.regenTimer += dt;
    if (diff.passiveRegen) {
      if (this.regenTimer > 2) {
        this.regenTimer = 0;
        this.heal(1);
        if (p.hunger < PLAYER.maxHunger) p.hunger += 1;
      }
    } else if (p.health < PLAYER.maxHealth && p.hunger >= SURVIVAL.regenHungerThreshold) {
      const interval = p.saturation > 0 && p.hunger >= PLAYER.maxHunger ? 1 : SURVIVAL.regenInterval;
      if (this.regenTimer > interval) {
        this.regenTimer = 0;
        this.heal(1);
        this.exhaust(SURVIVAL.exhaustionRegen);
      }
    } else this.regenTimer = Math.min(this.regenTimer, SURVIVAL.regenInterval);

    // Starvation stops at a difficulty-dependent floor.
    if (p.hunger <= 0) {
      this.starveTimer += dt;
      if (this.starveTimer > SURVIVAL.starveInterval) {
        this.starveTimer = 0;
        if (p.health > diff.starveFloor) this.damage(1, { type: 'starve' });
      }
    } else this.starveTimer = 0;

    // Breath.
    if (p.headInWater) {
      p.air = Math.max(0, p.air - dt);
      if (p.air <= 0) {
        this.drownTimer += dt;
        if (this.drownTimer > SURVIVAL.drownInterval) {
          this.drownTimer = 0;
          this.damage(2, { type: 'drown' });
        }
      }
    } else {
      p.air = Math.min(SURVIVAL.maxAir, p.air + dt * 4);
      this.drownTimer = 0;
    }

    // Environmental hazards.
    this.envTimer += dt;
    if (this.envTimer > 0.5) {
      this.envTimer = 0;
      if (p.inLava) this.damage(4, { type: 'lava' });
      const touching = p.touching || [];
      const hw = p.width / 2 + 0.02;
      const cactus = touching.some((t) => t.id === B.cactus) || this.cactusAdjacent(hw);
      if (cactus) this.damage(1, { type: 'cactus' });
      if (p.pos.y < -8) this.damage(4, { type: 'void' });
    }
  }

  cactusAdjacent(hw) {
    const p = this.player, w = this.game.world;
    for (const [dx, dz] of [[hw, 0], [-hw, 0], [0, hw], [0, -hw]]) {
      for (const dy of [0.1, 1]) {
        const x = Math.floor(p.pos.x + dx), y = Math.floor(p.pos.y + dy), z = Math.floor(p.pos.z + dz);
        if (w.getBlock(x, y, z) !== B.cactus) continue;
        // Cactus collision box is inset 1/16; touching it counts.
        const lx = p.pos.x + dx - x, lz = p.pos.z + dz - z;
        if (lx > 0.0625 - 0.03 && lx < 0.9375 + 0.03 && lz > 0.0625 - 0.03 && lz < 0.9375 + 0.03) return true;
      }
    }
    return false;
  }

  heal(n) {
    const p = this.player;
    p.health = Math.min(PLAYER.maxHealth, p.health + n);
  }

  /**
   * Apply damage. source: { type: 'mob'|'projectile'|'fall'|'lava'|..., from?: {x,y,z} }.
   * Returns the damage actually dealt.
   */
  damage(amount, source = { type: 'generic' }) {
    const p = this.player;
    if (p.dead || this.creative || amount <= 0) return 0;
    if (this.invuln > 0) return 0;
    if (this.shieldBlocks(source, amount)) return 0;
    let dmg = amount;
    if (!BYPASS_ARMOR.has(source.type)) {
      const armor = p.armorPoints;
      dmg *= 1 - Math.min(0.8, armor * 0.04);
      this.wearArmor(amount);
    }
    dmg = Math.max(0.5, Math.round(dmg * 2) / 2);
    p.health = Math.max(0, p.health - dmg);
    this.invuln = SURVIVAL.invulnerabilityTime;
    this.exhaust(0.1);
    if (source.from) {
      const dx = p.pos.x - source.from.x, dz = p.pos.z - source.from.z;
      const l = Math.hypot(dx, dz) || 1;
      p.vel.x += (dx / l) * 5;
      p.vel.z += (dz / l) * 5;
      p.vel.y = Math.max(p.vel.y, 4);
    }
    this.game.onPlayerHurt(dmg, source);
    if (p.health <= 0) this.game.onPlayerDeath(source);
    return dmg;
  }

  /** A raised shield (offhand or main hand, while sneaking) stops frontal creature hits and shots. */
  shieldBlocks(source, amount) {
    const p = this.player;
    if (!p.sneaking || !source.from || !BLOCKABLE.has(source.type)) return false;
    let inv = null, idx = 0;
    if (ITEMS[p.offhand.get(0)?.id]?.shield) inv = p.offhand;
    else if (ITEMS[p.heldStack?.id]?.shield) [inv, idx] = [p.inventory, p.selected];
    if (!inv) return false;
    const dx = source.from.x - p.pos.x, dz = source.from.z - p.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    if ((-Math.sin(p.yaw) * dx + -Math.cos(p.yaw) * dz) / l < 0.25) return false; // attacker is behind
    const s = inv.get(idx);
    s.damage = (s.damage || 0) + Math.max(1, Math.round(amount));
    if (s.damage >= ITEMS[s.id].tool.durability) {
      inv.set(idx, null);
      this.game.onItemBroken(s.id);
    } else inv.set(idx, s);
    this.invuln = 0.4;
    this.game.audio.play('shield');
    this.game.input.vibrate(20);
    return true;
  }

  wearArmor(amount) {
    const inv = this.player.armor;
    const wear = Math.max(1, Math.floor(amount / 4));
    for (let i = 0; i < 4; i++) {
      const s = inv.get(i);
      if (!s) continue;
      s.damage = (s.damage || 0) + wear;
      if (s.damage >= ITEMS[s.id].armor.durability) {
        inv.set(i, null);
        this.game.onItemBroken(s.id);
      } else inv.set(i, s);
    }
  }

  canEat(id) {
    const f = ITEMS[id]?.food;
    if (!f) return false;
    return this.creative || this.player.hunger < PLAYER.maxHunger || id === 'apple';
  }

  /** Apply a food item's effects (the caller consumes the item). */
  eat(id) {
    const f = ITEMS[id]?.food;
    if (!f) return false;
    const p = this.player;
    p.hunger = Math.min(PLAYER.maxHunger, p.hunger + f.hunger);
    p.saturation = Math.min(p.hunger, p.saturation + f.saturation);
    if (f.heal) this.heal(f.heal);
    return true;
  }

  resetForRespawn() {
    const p = this.player;
    p.health = PLAYER.maxHealth;
    p.hunger = PLAYER.maxHunger;
    p.saturation = 5;
    p.exhaustion = 0;
    p.air = SURVIVAL.maxAir;
    p.dead = false;
    p.vel = { x: 0, y: 0, z: 0 };
    p.fallStart = null;
    this.invuln = 2;
  }
}
