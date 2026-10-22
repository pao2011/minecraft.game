// Creature behavior. Each mob runs one explicit state machine; only the active state issues
// movement, so systems never fight over steering.
//   passive: idle <-> wander, follow (food lure), flee (after damage)
//   hostile: idle <-> wander -> chase -> attack / retreat (ranged) -> search -> wander
import { MOBS } from './mobs.js';
import { moveEntity, touchingBlocks } from './physics.js';
import { findPath, walkable } from './pathfind.js';
import { raycast } from '../world/raycast.js';
import { B, SOLID } from '../world/blocks.js';

let nextId = 1;
const LURES = { grazer: ['wheat'], woolly: ['wheat'], snout: ['carrot'], cluck: ['wheat_seeds'] };

export class Mob {
  constructor(type, pos) {
    this.id = nextId++;
    this.type = type;
    this.def = MOBS[type];
    this.pos = { ...pos };
    this.vel = { x: 0, y: 0, z: 0 };
    this.width = this.def.width;
    this.height = this.def.height;
    this.health = this.def.health;
    this.yaw = Math.random() * Math.PI * 2;
    this.headYaw = this.yaw;
    this.state = 'idle';
    this.stateTime = 1 + Math.random() * 3;
    this.goal = null;
    this.path = null;
    this.pathTimer = 0;
    this.attackTimer = 0;
    this.hurtTimer = 0;
    this.deathTimer = 0;
    this.dead = false;
    this.onGround = false;
    this.walkPhase = 0;
    this.lostSight = 0;
    this.lastSeen = null;
    this.burnTimer = 0;
    this.soundTimer = 4 + Math.random() * 10;
    this.age = 0;
    this.leapTimer = 0;
    this.removed = false;
  }

  setState(s, time = 0) {
    this.state = s;
    this.stateTime = time;
    this.path = null;
  }

  distTo(p) {
    return Math.hypot(p.x - this.pos.x, p.y - this.pos.y, p.z - this.pos.z);
  }

  canSee(world, player) {
    const from = { x: this.pos.x, y: this.pos.y + this.height * 0.85, z: this.pos.z };
    const to = player.eye;
    const dir = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    const dist = Math.hypot(dir.x, dir.y, dir.z);
    const hit = raycast(world, from, dir, dist, (id) => SOLID[id] && id !== B.glass && id !== B.glass_pane);
    return !hit;
  }

  /** Apply damage; returns true if this hit killed the mob. */
  hurt(amount, from, knock = 5) {
    if (this.dead || this.hurtTimer > 0.35) return false;
    this.health -= amount;
    this.hurtTimer = 0.5;
    if (from) {
      const dx = this.pos.x - from.x, dz = this.pos.z - from.z;
      const l = Math.hypot(dx, dz) || 1;
      this.vel.x += (dx / l) * knock;
      this.vel.z += (dz / l) * knock;
      this.vel.y = Math.max(this.vel.y, 4.5);
    }
    if (this.health <= 0) {
      this.dead = true;
      this.deathTimer = 1;
      return true;
    }
    if (!this.def.hostile) {
      this.setState('flee', 4);
      this.fleeFrom = from ? { ...from } : null;
    } else if (this.state !== 'attack') this.setState('chase', 0);
    return false;
  }

  /**
   * ctx: { world, player, playerTargetable, isDay, events: [], dt }
   * events collects requests for the manager: attacks, shots, sounds.
   */
  update(dt, ctx) {
    this.age += dt;
    if (this.hurtTimer > 0) this.hurtTimer -= dt;
    if (this.dead) {
      this.deathTimer -= dt;
      this.vel.x *= 0.85;
      this.vel.z *= 0.85;
      this.vel.y -= 28 * dt;
      moveEntity(ctx.world, this, dt, { stepHeight: 0 });
      if (this.deathTimer <= 0) this.removed = true;
      return;
    }
    const { world, player } = ctx;
    const touching = touchingBlocks(world, this);
    this.inWater = touching.some((t) => t.id === B.water);
    const inLava = touching.some((t) => t.id === B.lava);
    if (inLava) this.hurtEnv(4, dt, ctx);
    if (touching.some((t) => t.id === B.cactus)) this.hurtEnv(1, dt, ctx);

    // Daylight burns some undead-like creatures when under open sky.
    if (this.def.burnsInDay && ctx.isDay && !this.inWater) {
      const [sky] = world.getLight(Math.floor(this.pos.x), Math.floor(this.pos.y + this.height - 0.1), Math.floor(this.pos.z));
      this.burning = sky >= 15;
      if (this.burning) {
        this.burnTimer += dt;
        if (this.burnTimer > 1) {
          this.burnTimer = 0;
          this.hurt(2, null, 0);
          if (this.dead) ctx.events.push({ type: 'died', mob: this, cause: 'sun' });
        }
      }
    } else this.burning = false;

    this.soundTimer -= dt;
    if (this.soundTimer <= 0) {
      this.soundTimer = 6 + Math.random() * 12;
      ctx.events.push({ type: 'sound', mob: this, name: 'idle' });
    }

    let move = null; // {x, z, speedMul}
    const dPlayer = player.dead ? Infinity : this.distTo(player.pos);
    this.stateTime -= dt;
    this.attackTimer -= dt;
    this.leapTimer -= dt;
    this.pathTimer -= dt;

    if (this.def.hostile) move = this.hostileBrain(dt, ctx, dPlayer);
    else move = this.passiveBrain(dt, ctx, dPlayer);

    // Steering and locomotion.
    const speed = this.def.speed * (move?.speedMul ?? 1) * (this.inWater ? 0.6 : 1);
    if (move) {
      const dx = move.x - this.pos.x, dz = move.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.15) {
        const want = Math.atan2(-dx, -dz);
        let diff = ((want - this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
        this.yaw += Math.max(-dt * 8, Math.min(dt * 8, diff));
        const k = 1 - Math.exp(-10 * dt);
        this.vel.x += ((dx / d) * speed - this.vel.x) * k;
        this.vel.z += ((dz / d) * speed - this.vel.z) * k;
        this.walkPhase += dt * speed * 4;
      } else this.brake(dt);
    } else this.brake(dt);

    if (this.inWater) {
      this.vel.y += (this.pos.y % 1 > 0.3 ? 4 : 12) * dt;
      this.vel.y = Math.min(this.vel.y, 2.5);
      this.vel.y -= 6 * dt;
    } else {
      this.vel.y -= 28 * dt;
      if (this.def.slowFall && this.vel.y < -2.5) this.vel.y = -2.5;
    }
    const wasBlocked = this.hitHorizontal;
    moveEntity(world, this, dt, { stepHeight: 0.6 });
    if (move && this.onGround && (this.hitHorizontal || wasBlocked)) {
      // Jump up one-block steps when there is headroom.
      const fx = Math.floor(this.pos.x - Math.sin(this.yaw) * (this.width / 2 + 0.4));
      const fz = Math.floor(this.pos.z - Math.cos(this.yaw) * (this.width / 2 + 0.4));
      const y = Math.floor(this.pos.y + 0.01);
      if (SOLID[world.getBlock(fx, y, fz)] && !SOLID[world.getBlock(fx, y + 1, fz)] && !SOLID[world.getBlock(fx, y + Math.ceil(this.height), fz)]) this.vel.y = 8;
      else if (this.state === 'wander') this.setState('idle', 1 + Math.random() * 2);
    }
    this.headYaw += (this.yaw - this.headYaw) * Math.min(1, dt * 6);
  }

  hurtEnv(amount, dt, ctx) {
    this.envTimer = (this.envTimer || 0) + dt;
    if (this.envTimer > 0.6) {
      this.envTimer = 0;
      if (this.hurt(amount, null, 0)) ctx.events.push({ type: 'died', mob: this, cause: 'env' });
    }
  }

  brake(dt) {
    const k = Math.exp(-12 * dt);
    this.vel.x *= k;
    this.vel.z *= k;
  }

  pickWanderGoal(world, radius = 8) {
    for (let i = 0; i < 8; i++) {
      const x = Math.floor(this.pos.x + (Math.random() * 2 - 1) * radius);
      const z = Math.floor(this.pos.z + (Math.random() * 2 - 1) * radius);
      for (let dy = 2; dy >= -3; dy--) {
        const y = Math.floor(this.pos.y) + dy;
        if (walkable(world, x, y, z, Math.ceil(this.height)) && world.getBlock(x, y - 1, z) !== B.water) return { x: x + 0.5, y, z: z + 0.5 };
      }
    }
    return null;
  }

  /** Follow a computed path toward goal; refreshes the path periodically. */
  pathTo(world, goal, refresh = 1) {
    if (!this.path || this.pathTimer <= 0) {
      this.pathTimer = refresh + Math.random() * 0.4;
      const start = { x: Math.floor(this.pos.x), y: Math.floor(this.pos.y + 0.01), z: Math.floor(this.pos.z) };
      const g = { x: Math.floor(goal.x), y: Math.floor(goal.y + 0.01), z: Math.floor(goal.z) };
      this.path = findPath(world, start, g, { height: Math.ceil(this.height), maxNodes: 260 }) || [];
    }
    while (this.path.length) {
      const w = this.path[0];
      if (Math.hypot(w.x + 0.5 - this.pos.x, w.z + 0.5 - this.pos.z) < 0.45) this.path.shift();
      else return { x: w.x + 0.5, z: w.z + 0.5 };
    }
    return { x: goal.x, z: goal.z };
  }

  passiveBrain(dt, ctx, dPlayer) {
    const { world, player } = ctx;
    const lure = LURES[this.type];
    const held = player.heldStack?.id;
    if (this.state !== 'flee' && lure && held && lure.includes(held) && dPlayer < 10) {
      this.state = 'follow';
      if (dPlayer < 2.2) return null;
      return { ...this.pathTo(world, player.pos, 0.8), speedMul: 1.1 };
    }
    if (this.state === 'follow') this.setState('idle', 1);
    switch (this.state) {
      case 'flee': {
        if (this.stateTime <= 0) {
          this.setState('idle', 2);
          return null;
        }
        const from = this.fleeFrom || player.pos;
        const dx = this.pos.x - from.x, dz = this.pos.z - from.z;
        const l = Math.hypot(dx, dz) || 1;
        return { x: this.pos.x + (dx / l) * 4, z: this.pos.z + (dz / l) * 4, speedMul: 1.7 };
      }
      case 'wander': {
        if (!this.goal || this.stateTime <= 0 || Math.hypot(this.goal.x - this.pos.x, this.goal.z - this.pos.z) < 0.6) {
          this.setState('idle', 2 + Math.random() * 5);
          return null;
        }
        return this.pathTo(world, this.goal, 3);
      }
      default:
        if (this.stateTime <= 0) {
          this.goal = this.pickWanderGoal(world);
          if (this.goal) this.setState('wander', 8);
          else this.stateTime = 2;
        }
        return null;
    }
  }

  hostileBrain(dt, ctx, dPlayer) {
    const { world, player } = ctx;
    const def = this.def;
    const targetable = ctx.playerTargetable;
    // Gloomlings shy away from bright torchlight.
    if (def.caveOnly) {
      const [, blk] = world.getLight(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.5), Math.floor(this.pos.z));
      if (blk >= 11 && this.state !== 'retreat') {
        this.setState('retreat', 2);
        this.retreatFrom = { ...this.pos };
      }
    }
    if (this.state === 'retreat') {
      if (this.stateTime <= 0) this.setState('search', 3);
      const from = this.retreatFrom || player.pos;
      const dx = this.pos.x - from.x + (this.pos.x - player.pos.x) * 0.3, dz = this.pos.z - from.z + (this.pos.z - player.pos.z) * 0.3;
      const l = Math.hypot(dx, dz) || 1;
      return { x: this.pos.x + (dx / l) * 4, z: this.pos.z + (dz / l) * 4, speedMul: 1.2 };
    }
    const sees = targetable && dPlayer < def.detect && (dPlayer < 5 || this.canSeeCached(world, player, dt));
    if (sees) {
      this.lastSeen = { ...player.pos };
      this.lostSight = 0;
      if (this.state === 'idle' || this.state === 'wander' || this.state === 'search') this.setState('chase');
    } else if (this.state === 'chase' || this.state === 'attack') {
      this.lostSight += dt;
      if (!targetable || this.lostSight > 4 || dPlayer > def.detect * 1.6) this.setState('search', 6);
    }
    switch (this.state) {
      case 'chase':
      case 'attack': {
        if (def.ranged) {
          if (dPlayer < def.attackRange && this.attackTimer <= 0 && this.canSeeCached(world, player, 0)) {
            this.attackTimer = def.attackCooldown * (0.8 + Math.random() * 0.4);
            ctx.events.push({ type: 'shoot', mob: this });
          }
          this.yaw = Math.atan2(-(player.pos.x - this.pos.x), -(player.pos.z - this.pos.z));
          if (dPlayer < def.keepDistance - 1.5) {
            const dx = this.pos.x - player.pos.x, dz = this.pos.z - player.pos.z;
            const l = Math.hypot(dx, dz) || 1;
            const res = { x: this.pos.x + (dx / l) * 3, z: this.pos.z + (dz / l) * 3, speedMul: 1 };
            this.yaw = Math.atan2(-(player.pos.x - this.pos.x), -(player.pos.z - this.pos.z));
            return res;
          }
          if (dPlayer > def.keepDistance + 2) return this.pathTo(world, player.pos, 1);
          return null;
        }
        if (dPlayer <= def.attackRange) {
          this.state = 'attack';
          this.yaw = Math.atan2(-(player.pos.x - this.pos.x), -(player.pos.z - this.pos.z));
          if (this.attackTimer <= 0 && Math.abs(player.pos.y - this.pos.y) < 1.8) {
            this.attackTimer = def.attackCooldown;
            ctx.events.push({ type: 'melee', mob: this });
          }
          return null;
        }
        this.state = 'chase';
        if (def.leaps && this.onGround && dPlayer < 5 && dPlayer > 2 && this.leapTimer <= 0) {
          this.leapTimer = 2.5;
          const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
          const l = Math.hypot(dx, dz) || 1;
          this.vel.x = (dx / l) * 7;
          this.vel.z = (dz / l) * 7;
          this.vel.y = 6;
        }
        return { ...this.pathTo(world, player.pos, 0.9), speedMul: 1.05 };
      }
      case 'search': {
        if (this.stateTime <= 0 || !this.lastSeen) {
          this.setState('wander', 6);
          this.goal = this.pickWanderGoal(world, 10);
          return null;
        }
        if (Math.hypot(this.lastSeen.x - this.pos.x, this.lastSeen.z - this.pos.z) < 1) return null;
        return this.pathTo(world, this.lastSeen, 1.5);
      }
      case 'wander': {
        if (!this.goal || this.stateTime <= 0 || Math.hypot(this.goal.x - this.pos.x, this.goal.z - this.pos.z) < 0.6) {
          this.setState('idle', 2 + Math.random() * 4);
          return null;
        }
        return { ...this.pathTo(world, this.goal, 3), speedMul: 0.6 };
      }
      default:
        if (this.stateTime <= 0) {
          this.goal = this.pickWanderGoal(world, 10);
          if (this.goal) this.setState('wander', 8);
          else this.stateTime = 2;
        }
        return null;
    }
  }

  /** Line-of-sight checks are throttled; raycasts are the expensive part of AI. */
  canSeeCached(world, player, dt) {
    this.losTimer = (this.losTimer || 0) - dt;
    if (this.losTimer <= 0 || this.losCache === undefined) {
      this.losTimer = 0.3 + Math.random() * 0.2;
      this.losCache = this.canSee(world, player);
    }
    return this.losCache;
  }

  toJSON() {
    return { type: this.type, pos: { ...this.pos }, health: this.health };
  }
}
