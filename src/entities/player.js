// First-person player: movement state machine (walk, sprint, sneak, swim, climb, fly) on top
// of the shared AABB physics. Survival stats live in game/survival.js.
import { PLAYER } from '../config/constants.js';
import { moveEntity, touchingBlocks, collidesAt } from './physics.js';
import { Inventory } from '../items/inventory.js';
import { ITEMS } from '../items/items.js';
import { B, SOLID, BLOCKS } from '../world/blocks.js';

export class Player {
  constructor() {
    this.pos = { x: 0.5, y: 80, z: 0.5 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.width = PLAYER.width;
    this.height = PLAYER.height;
    this.onGround = false;
    this.flying = false;
    this.sneaking = false;
    this.sprinting = false;
    this.inWater = false;
    this.headInWater = false;
    this.inLava = false;
    this.onLadder = false;
    this.inventory = new Inventory(36); // 0-8 hotbar, 9-35 backpack
    this.armor = new Inventory(4);
    this.selected = 0;
    this.health = PLAYER.maxHealth;
    this.hunger = PLAYER.maxHunger;
    this.saturation = 5;
    this.exhaustion = 0;
    this.air = 10;
    this.dead = false;
    this.spawnPoint = null; // bed spawn {x, y, z}
    this.fallStart = null;
    this.walkDist = 0;
    this.stepDist = 0;
    this.events = []; // 'jump', 'land', 'step' consumed by audio/survival each frame
  }

  get eyeHeight() {
    return this.sneaking && !this.flying ? PLAYER.sneakEyeHeight : PLAYER.eyeHeight;
  }

  get eye() {
    return { x: this.pos.x, y: this.pos.y + this.eyeHeight, z: this.pos.z };
  }

  get heldStack() {
    return this.inventory.get(this.selected);
  }

  lookDir() {
    const cp = Math.cos(this.pitch);
    return { x: -Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: -Math.cos(this.yaw) * cp };
  }

  /**
   * input: { moveX, moveZ (forward +), jump (held), jumpPressed, sneak, sprint, flyDown }
   * opts: { creative, autoJump, hungerAllowsSprint }
   */
  update(dt, input, world, opts) {
    if (this.dead) return;
    // Do not simulate until the ground under us is loaded; avoids falling into the void.
    if (!world.isLoaded(this.pos.x, this.pos.z)) {
      this.vel.x = this.vel.y = this.vel.z = 0;
      return;
    }
    this.updateEnvironment(world);
    const creative = opts.creative;
    if (!creative) this.flying = false;

    this.sneaking = !!input.sneak && !this.flying;
    if (input.sprint && input.moveZ > 0.3 && !this.sneaking && (creative || opts.hungerAllowsSprint)) this.sprinting = true;
    if (this.sprinting && (input.moveZ <= 0.3 || this.sneaking || this.hitHorizontal || (!creative && !opts.hungerAllowsSprint))) this.sprinting = false;

    let speed = this.flying ? (this.sprinting ? PLAYER.flySprintSpeed : PLAYER.flySpeed) : this.sneaking ? PLAYER.sneakSpeed : this.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
    if (this.inWater && !this.flying) speed = Math.min(speed, PLAYER.swimSpeed * (this.sprinting ? 1.4 : 1));
    if (this.inLava) speed *= 0.4;

    // Desired horizontal velocity in world space from analog input.
    const mag = Math.min(1, Math.hypot(input.moveX, input.moveZ));
    const sx = Math.sin(this.yaw), cx = Math.cos(this.yaw);
    const fx = -sx * input.moveZ + cx * input.moveX;
    const fz = -cx * input.moveZ - sx * input.moveX;
    const flen = Math.hypot(fx, fz) || 1;
    const tx = (fx / flen) * speed * mag, tz = (fz / flen) * speed * mag;
    const accel = this.flying ? 6 : this.onGround ? 16 : this.inWater ? 5 : 3.2;
    const k = 1 - Math.exp(-accel * dt);
    this.vel.x += (tx - this.vel.x) * k;
    this.vel.z += (tz - this.vel.z) * k;

    if (this.flying) {
      const vy = ((input.jump ? 1 : 0) - (input.flyDown || input.sneak ? 1 : 0)) * speed * 0.75;
      this.vel.y += (vy - this.vel.y) * (1 - Math.exp(-8 * dt));
    } else if (this.inWater || this.inLava) {
      this.vel.y -= (this.inLava ? 5 : 7) * dt;
      this.vel.y *= Math.exp(-2.2 * dt);
      if (input.jump) this.vel.y = Math.min(this.vel.y + 22 * dt, this.inLava ? 2 : 3.6);
      this.vel.y = Math.max(this.vel.y, -4);
      // Hop out at the shoreline.
      if (input.jump && this.hitHorizontal && !this.headInWater) this.vel.y = Math.max(this.vel.y, 6);
    } else if (this.onLadder) {
      this.vel.y -= PLAYER.gravity * dt;
      if (input.jump || (this.hitHorizontal && mag > 0.2)) this.vel.y = 2.8;
      else if (this.sneaking) this.vel.y = 0;
      else this.vel.y = Math.max(this.vel.y, -2.4);
    } else {
      this.vel.y -= PLAYER.gravity * dt;
      this.vel.y = Math.max(this.vel.y, -PLAYER.terminalVelocity);
      if (input.jumpPressed && this.onGround) this.jump();
      else if (opts.autoJump && this.onGround && this.hitHorizontal && mag > 0.3 && this.canAutoJump(world, tx, tz)) this.jump();
    }

    const before = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    const wasGround = this.onGround;
    moveEntity(world, this, dt, { stepHeight: this.flying ? 0 : 0.6, sneakGuard: this.sneaking && !this.flying });
    if (this.flying && this.onGround && creative && opts.landToStopFlying) this.flying = false;

    const moved = Math.hypot(this.pos.x - before.x, this.pos.z - before.z);
    this.walkDist += moved;
    if (this.onGround && !this.flying) {
      this.stepDist += moved;
      if (this.stepDist > (this.sprinting ? 2.1 : 1.7)) {
        this.stepDist = 0;
        this.events.push('step');
      }
    }
    this.trackFall(wasGround, before.y);
  }

  jump() {
    this.vel.y = PLAYER.jumpVelocity;
    if (this.sprinting) {
      this.vel.x -= Math.sin(this.yaw) * 1.2;
      this.vel.z -= Math.cos(this.yaw) * 1.2;
    }
    this.onGround = false;
    this.events.push(this.sprinting ? 'sprintjump' : 'jump');
  }

  /** Auto-jump only for 1-block steps with headroom, never into walls. */
  canAutoJump(world, tx, tz) {
    const len = Math.hypot(tx, tz) || 1;
    const ax = Math.floor(this.pos.x + (tx / len) * 0.7), az = Math.floor(this.pos.z + (tz / len) * 0.7);
    const y = Math.floor(this.pos.y + 0.01);
    const feet = world.getBlock(ax, y, az);
    if (!SOLID[feet] || BLOCKS[feet].shape === 'fence') return false;
    return !SOLID[world.getBlock(ax, y + 1, az)] && !SOLID[world.getBlock(ax, y + 2, az)] && !SOLID[world.getBlock(Math.floor(this.pos.x), y + 2, Math.floor(this.pos.z))];
  }

  updateEnvironment(world) {
    const touching = touchingBlocks(world, this);
    this.inWater = touching.some((t) => t.id === B.water);
    this.inLava = touching.some((t) => t.id === B.lava);
    this.onLadder = touching.some((t) => t.def.climbable);
    const eye = this.eye;
    const headId = world.getBlock(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z));
    this.headInWater = headId === B.water && eye.y - Math.floor(eye.y) < 0.9;
    this.headInLava = headId === B.lava;
    this.touching = touching;
  }

  trackFall(wasGround, prevY) {
    if (this.flying || this.inWater || this.onLadder || this.inLava) {
      this.fallStart = null;
      return;
    }
    if (!this.onGround) {
      if (this.fallStart === null || prevY > this.fallStart) this.fallStart = Math.max(prevY, this.pos.y);
    } else if (!wasGround) {
      const dist = this.fallStart !== null ? this.fallStart - this.pos.y : 0;
      this.fallStart = null;
      this.events.push({ type: 'land', dist });
    }
  }

  /** Move upward out of any solid blocks (safe spawn/teleport). */
  unstick(world) {
    for (let i = 0; i < 128 && collidesAt(world, this, this.pos); i++) this.pos.y += 1;
  }

  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  get armorPoints() {
    let n = 0;
    for (const s of this.armor.slots) if (s) n += ITEMS[s.id]?.armor?.points ?? 0;
    return n;
  }
}
