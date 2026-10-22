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
    this.aggro = 0; // seconds of provoked behavior for neutral creatures
    this.hopTimer = 0;
    this.fuse = -1; // blastling countdown (-1 = idle)
    this.tpTimer = 3 + Math.random() * 4;
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
    const def = this.def;
    if (def.retaliates || def.gaze) this.aggro = def.gaze ? 45 : 20;
    if (def.teleports && Math.random() < 0.6) this.wantTeleport = true;
    if (!def.hostile && !def.retaliates) {
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
    if (inLava && !this.def.fireImmune) this.hurtEnv(4, dt, ctx);
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

    const def = this.def;
    this.hopTimer -= dt;
    // Neutral creatures calm down; endermen-like ones turn hostile when stared at.
    const wasAggro = this.aggro > 0;
    if (this.aggro > 0) this.aggro -= dt;
    if (def.gaze && !wasAggro && ctx.playerTargetable && dPlayer < 32) {
      const look = player.lookDir();
      const dx = this.pos.x - player.pos.x, dy = this.pos.y + this.height * 0.9 - player.eye.y, dz = this.pos.z - player.pos.z;
      const l = Math.hypot(dx, dy, dz) || 1;
      if ((look.x * dx + look.y * dy + look.z * dz) / l > 0.985 && this.canSeeCached(world, player, dt)) {
        this.aggro = 45;
        this.setState('chase', 0);
        ctx.events.push({ type: 'sound', mob: this, name: 'attack' });
      }
    }
    if (wasAggro && this.aggro <= 0 && !def.hostile) this.setState('idle', 2);
    if (def.teleports) {
      this.tpTimer -= dt;
      if (this.wantTeleport || (this.aggro > 0 && this.tpTimer <= 0 && Math.random() < 0.02)) {
        this.wantTeleport = false;
        this.tpTimer = 3 + Math.random() * 4;
        this.teleport(world, this.aggro > 0 ? player.pos : this.pos, this.aggro > 0 ? 7 : 14, ctx);
      }
    }
    // Blastling fuse: stand still and swell, cancel if the target backs off.
    if (this.fuse >= 0) {
      this.fuse -= dt;
      if (dPlayer > def.attackRange + 2.5 && this.fuse > 0.3) this.fuse = -1;
      else if (this.fuse <= 0) {
        ctx.events.push({ type: 'explode', mob: this, radius: def.blastRadius });
        this.dead = true;
        this.removed = true;
        return;
      }
    }

    const aggressive = (def.hostile && !def.gaze) || this.aggro > 0;
    if (def.boss) move = this.bossBrain(dt, ctx, dPlayer);
    else if (def.flying) move = this.flyBrain(dt, ctx, dPlayer, aggressive);
    else if (this.fuse >= 0) {
      this.yaw = Math.atan2(-(player.pos.x - this.pos.x), -(player.pos.z - this.pos.z));
      move = null;
    } else if (aggressive) move = this.hostileBrain(dt, ctx, dPlayer);
    else move = this.passiveBrain(dt, ctx, dPlayer);

    // Steering and locomotion.
    const hopMul = def.hops ? (this.onGround ? 0.1 : 1.25) : 1;
    const speed = def.speed * (move?.speedMul ?? 1) * (this.inWater ? 0.6 : 1) * hopMul;
    if (def.hops && move && this.onGround && this.hopTimer <= 0) {
      this.vel.y = def.hopPower || 6;
      this.hopTimer = def.hopInterval || 0.6;
    }
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

    if (def.flying) {
      // Fliers steer vertically toward the brain's target height and ignore gravity.
      const ty = move?.y ?? this.pos.y;
      const vyT = Math.max(-speed, Math.min(speed, (ty - this.pos.y) * 2));
      this.vel.y += (vyT - this.vel.y) * (1 - Math.exp(-6 * dt));
    } else if (this.inWater) {
      this.vel.y += (this.pos.y % 1 > 0.3 ? 4 : 12) * dt;
      this.vel.y = Math.min(this.vel.y, 2.5);
      this.vel.y -= 6 * dt;
    } else {
      this.vel.y -= 28 * dt;
      if (this.def.slowFall && this.vel.y < -2.5) this.vel.y = -2.5;
    }
    const wasBlocked = this.hitHorizontal;
    if (def.noClip) {
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
      this.pos.z += this.vel.z * dt;
    } else moveEntity(world, this, dt, { stepHeight: def.flying ? 0 : 0.6 });
    if (move && !def.flying && this.onGround && (this.hitHorizontal || wasBlocked)) {
      // Jump up one-block steps when there is headroom.
      const fx = Math.floor(this.pos.x - Math.sin(this.yaw) * (this.width / 2 + 0.4));
      const fz = Math.floor(this.pos.z - Math.cos(this.yaw) * (this.width / 2 + 0.4));
      const y = Math.floor(this.pos.y + 0.01);
      if (SOLID[world.getBlock(fx, y, fz)] && !SOLID[world.getBlock(fx, y + 1, fz)] && !SOLID[world.getBlock(fx, y + Math.ceil(this.height), fz)]) this.vel.y = 8;
      else if (this.state === 'wander') this.setState('idle', 1 + Math.random() * 2);
    }
    this.headYaw += (this.yaw - this.headYaw) * Math.min(1, dt * 6);
  }

  /** Pick a free standing cell within `radius` of (center.x, center.z); null if none found. */
  pickGoalAround(world, center, radius, tries = 10) {
    for (let i = 0; i < tries; i++) {
      const x = Math.floor(center.x + (Math.random() * 2 - 1) * radius);
      const z = Math.floor(center.z + (Math.random() * 2 - 1) * radius);
      for (let dy = 4; dy >= -6; dy--) {
        const y = Math.floor(center.y) + dy;
        if (walkable(world, x, y, z, Math.ceil(this.height)) && world.getBlock(x, y - 1, z) !== B.water) return { x: x + 0.5, y, z: z + 0.5 };
      }
    }
    return null;
  }

  teleport(world, center, radius, ctx) {
    const g = this.pickGoalAround(world, center, radius);
    if (!g) return;
    ctx.events.push({ type: 'teleport', mob: this, from: { ...this.pos }, to: g });
    this.pos.x = g.x;
    this.pos.y = g.y;
    this.pos.z = g.z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.path = null;
  }

  /** Flying creatures steer in 3D: bats drift, shooters keep their distance and hover above the player. */
  flyBrain(dt, ctx, dPlayer, aggressive) {
    const { world, player } = ctx;
    const def = this.def;
    const free = (x, y, z) => !SOLID[world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))];
    if (aggressive && ctx.playerTargetable && dPlayer < def.detect) {
      const sees = this.canSeeCached(world, player, dt);
      this.yaw = Math.atan2(-(player.pos.x - this.pos.x), -(player.pos.z - this.pos.z));
      if (sees && dPlayer < def.attackRange && this.attackTimer <= 0) {
        this.attackTimer = def.attackCooldown * (0.8 + Math.random() * 0.4);
        ctx.events.push({ type: 'shoot', mob: this });
      }
      const dx = player.pos.x - this.pos.x, dz = player.pos.z - this.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      const keep = def.keepDistance || 8;
      let tx = this.pos.x, tz = this.pos.z;
      if (dPlayer > keep + 2) { tx += (dx / l) * 4; tz += (dz / l) * 4; }
      else if (dPlayer < keep - 2) { tx -= (dx / l) * 4; tz -= (dz / l) * 4; }
      else { tx += (-dz / l) * 3; tz += (dx / l) * 3; } // strafe around the player
      return { x: tx, z: tz, y: player.pos.y + (def.hover || 3), speedMul: 1 };
    }
    // Idle drift: pick a nearby open point and fly there.
    if (!this.goal || this.stateTime <= 0 || Math.hypot(this.goal.x - this.pos.x, this.goal.z - this.pos.z) < 0.8 || this.hitHorizontal) {
      this.stateTime = 3 + Math.random() * 4;
      this.goal = null;
      for (let i = 0; i < 6; i++) {
        const x = this.pos.x + (Math.random() * 2 - 1) * 7, y = this.pos.y + (Math.random() * 2 - 1) * 2.5, z = this.pos.z + (Math.random() * 2 - 1) * 7;
        if (free(x, y, z) && free(x, y + 1, z)) {
          this.goal = { x, y, z };
          break;
        }
      }
    }
    if (!this.goal) return null;
    return { x: this.goal.x, z: this.goal.z, y: this.goal.y, speedMul: 0.7 };
  }

  /** Void Drake: circles the island, breathes fire, and dives at the player. */
  bossBrain(dt, ctx, dPlayer) {
    const { player } = ctx;
    const def = this.def;
    if (!this.phase) {
      this.phase = 'circle';
      this.phaseT = 9;
      this.angle = Math.random() * 6;
    }
    this.phaseT -= dt;
    const targetable = ctx.playerTargetable;
    if (this.phase === 'circle' || !targetable) {
      this.angle += dt * 0.35;
      if (targetable && dPlayer < 70 && this.attackTimer <= 0) {
        this.attackTimer = def.attackCooldown * 2.4;
        ctx.events.push({ type: 'shoot', mob: this });
      }
      if (targetable && this.phaseT <= 0) {
        this.phase = 'dive';
        this.phaseT = 4.5;
      }
      const tx = Math.cos(this.angle) * 30, tz = Math.sin(this.angle) * 30;
      this.yaw = Math.atan2(-(tx - this.pos.x), -(tz - this.pos.z));
      return { x: tx, z: tz, y: 84 + Math.sin(this.angle * 2) * 5, speedMul: 1 };
    }
    // Dive: charge at the player's position, bite when close, then climb back out.
    this.yaw = Math.atan2(-(player.pos.x - this.pos.x), -(player.pos.z - this.pos.z));
    if (dPlayer < def.attackRange && this.attackTimer <= 0) {
      this.attackTimer = 1.2;
      ctx.events.push({ type: 'melee', mob: this });
      this.phase = 'circle';
      this.phaseT = 8 + Math.random() * 5;
    } else if (this.phaseT <= 0) {
      this.phase = 'circle';
      this.phaseT = 8 + Math.random() * 5;
    }
    return { x: player.pos.x, z: player.pos.z, y: player.pos.y + 1, speedMul: 1.3 };
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
        if (def.explodes) {
          if (dPlayer <= def.attackRange) {
            if (this.fuse < 0) {
              this.fuse = def.fuse;
              ctx.events.push({ type: 'fuse', mob: this });
            }
            return null;
          }
        } else if (dPlayer <= def.attackRange) {
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
