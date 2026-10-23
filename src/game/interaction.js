// Targeting, mining, attacking, placing and using items/blocks. Mining and placing are
// separate controls, so opening a chest (Use) can never destroy it (Mine).
import { raycast } from '../world/raycast.js';
import { BLOCKS, B, SOLID } from '../world/blocks.js';
import { ITEMS, breakTime, placedBlock, maxDurability } from '../items/items.js';
import { PLAYER, SURVIVAL } from '../config/constants.js';
import { entityBox } from '../entities/physics.js';
import { posKey } from '../world/coords.js';
import { TILE } from '../world/tiles.js';
import * as THREE from 'three';
import { lightPortal, tryOpenGate, nearestSanctum } from './portals.js';

const ATTACK_COOLDOWN = 0.45;
const PLACE_REPEAT = 0.28;
const EAT_TIME = 1.2;
// Hit-face normal -> side index of the supporting wall relative to the new cell.
const WALL_SIDE = (n) => (n[2] === -1 ? 2 : n[0] === 1 ? 3 : n[2] === 1 ? 0 : n[0] === -1 ? 1 : -1);

export class Interaction {
  constructor(game) {
    this.game = game;
    this.target = null;
    this.mining = null;
    this.attackTimer = 0;
    this.useTimer = 0;
    this.breakDelay = 0;
    this.eating = null;
    this.hitSoundTimer = 0;
    this.drawing = null; // bow draw: {t, slot}
    this.bobber = null; // fishing line: {x, y, z, t, bite, window, mesh}
    this.slot = null; // {inv, idx} of the item currently used by Use (main hand, else offhand)
  }

  /** The stack Use acts on: the main-hand item, or the offhand item when the main hand is empty. */
  useSlot() {
    const p = this.player;
    const main = p.inventory.get(p.selected);
    if (main || !p.offhand.get(0)) return { inv: p.inventory, idx: p.selected, stack: main };
    return { inv: p.offhand, idx: 0, stack: p.offhand.get(0) };
  }

  /** Stop anything in progress (hand swap, menus, travel). */
  cancelActions() {
    this.eating = null;
    this.drawing = null;
    this.resetMining();
    this.cancelFishing();
  }

  get player() {
    return this.game.player;
  }

  get creative() {
    return this.game.record.mode === 'creative';
  }

  facingIndex() {
    const dx = -Math.sin(this.player.yaw), dz = -Math.cos(this.player.yaw);
    if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3;
    return dz > 0 ? 2 : 0;
  }

  computeTarget() {
    const p = this.player;
    const reach = this.creative ? PLAYER.creativeReach : PLAYER.reach;
    const origin = p.eye, dir = p.lookDir();
    const hit = raycast(this.game.world, origin, dir, reach);
    const mob = this.game.entities.raycast(origin, dir, Math.min(reach, 4));
    if (mob && (!hit || mob.dist < hit.dist)) return { kind: 'mob', mob: mob.mob, dist: mob.dist };
    if (hit) return { kind: 'block', hit };
    return null;
  }

  resetMining() {
    this.mining = null;
    this.game.renderer.setCrack(null);
  }

  update(dt, input) {
    const p = this.player;
    this.attackTimer -= dt;
    this.useTimer -= dt;
    this.breakDelay -= dt;
    if (p.dead) {
      this.target = null;
      this.game.renderer.setSelection(null);
      this.resetMining();
      return;
    }
    this.target = this.computeTarget();
    this.game.renderer.setSelection(this.target?.kind === 'block' ? this.target.hit : null);

    // Eating takes precedence while Use is held with food.
    if (this.eating) {
      const { inv, idx } = this.eating.slot;
      const held = inv.get(idx);
      if (!input.use || !held || held.id !== this.eating.id) this.eating = null;
      else {
        this.eating.t += dt;
        if (Math.floor(this.eating.t * 4) !== Math.floor((this.eating.t - dt) * 4)) this.game.audio.play('eat');
        if (this.eating.t >= EAT_TIME) {
          this.game.survival.eat(held.id);
          if (!this.creative) {
            inv.consume(idx);
            const back = ITEMS[held.id].returns;
            if (back && p.inventory.add({ id: back, count: 1 }) > 0) this.game.entities.spawnItem({ id: back, count: 1 }, { ...p.eye });
          }
          this.game.onAte(held.id);
          this.eating = null;
          this.useTimer = 0.4;
        }
      }
    }
    this.updateBow(dt, input);
    this.updateFishing(dt);

    if (input.edges.has('minePressed') || input.mine) this.handleMine(dt, input);
    else this.resetMining();

    if (input.edges.has('usePressed')) {
      this.useTimer = PLACE_REPEAT * 1.6;
      this.handleUse(true);
    } else if (input.use && this.useTimer <= 0 && !this.eating) {
      this.useTimer = PLACE_REPEAT;
      this.handleUse(false);
    }

    if (input.edges.has('drop')) this.dropHeld(false);
  }

  handleMine(dt, input) {
    const t = this.target;
    const p = this.player;
    if (t?.kind === 'mob') {
      this.resetMining();
      if ((input.edges.has('minePressed') || this.attackTimer <= 0) && this.attackTimer <= 0) this.attack(t.mob);
      return;
    }
    if (t?.kind !== 'block') {
      this.resetMining();
      if (input.edges.has('minePressed')) this.game.renderer.triggerSwing();
      return;
    }
    const { x, y, z, id } = t.hit;
    const held = p.heldStack;
    if (this.creative) {
      if (this.breakDelay > 0 && !input.edges.has('minePressed')) return;
      if (BLOCKS[id].hardness < 0 && id !== B.bedrock) return;
      this.breakDelay = 0.22;
      this.game.renderer.triggerSwing();
      this.breakBlock(x, y, z, id, held);
      return;
    }
    const time = breakTime(id, held?.id, { inWater: p.headInWater, onGround: p.onGround || p.flying || p.onLadder || p.inWater });
    if (time === Infinity) {
      if (input.edges.has('minePressed')) this.game.toast("This block can't be broken", 'deny');
      this.resetMining();
      return;
    }
    if (!this.mining || this.mining.x !== x || this.mining.y !== y || this.mining.z !== z || this.mining.id !== id) {
      this.mining = { x, y, z, id, progress: 0 };
    }
    this.mining.progress += dt / Math.max(0.05, time);
    this.game.survival.exhaust(SURVIVAL.exhaustionMine * dt * 20);
    this.hitSoundTimer -= dt;
    if (this.hitSoundTimer <= 0) {
      this.hitSoundTimer = 0.25;
      this.game.renderer.triggerSwing();
      this.game.audio.play(`hit_${BLOCKS[id].sound}`, { pos: { x: x + 0.5, y: y + 0.5, z: z + 0.5 } });
      if (Math.random() < 0.6) this.game.renderer.spawnBlockParticles(x, y, z, BLOCKS[id].faces[2], this.game.blockBrightness(x, y + 1, z), 2);
    }
    if (this.mining.progress >= 1) {
      this.breakBlock(x, y, z, id, held);
      this.resetMining();
    } else this.game.renderer.setCrack(t.hit, this.mining.progress);
  }

  breakBlock(x, y, z, id, held) {
    const w = this.game.world;
    if (!w.canModify(x, y, z)) return;
    this.game.renderer.spawnBlockParticles(x, y, z, BLOCKS[id].faces[2], this.game.blockBrightness(x, y + 1, z), 16);
    this.game.audio.play(`break_${BLOCKS[id].sound}`, { pos: { x: x + 0.5, y: y + 0.5, z: z + 0.5 } });
    this.game.lastBreakTool = held?.id ?? null;
    w.breakBlock(x, y, z, 'player');
    if (!this.creative && held && ITEMS[held.id]?.tool?.durability && BLOCKS[id].hardness > 0) this.useTool(ITEMS[held.id].tool.type === 'sword' ? 2 : 1);
    this.game.onBlockMined(id);
  }

  /** Spend tool durability on the selected slot; breaks the tool at zero. */
  useTool(amount, slot = null) {
    const p = this.player;
    const { inv, idx } = slot || { inv: p.inventory, idx: p.selected };
    const s = inv.get(idx);
    if (!s || !maxDurability(s.id)) return;
    s.damage = (s.damage || 0) + amount;
    if (s.damage >= maxDurability(s.id)) {
      inv.set(idx, null);
      this.game.onItemBroken(s.id);
    } else inv.set(idx, s);
  }

  attack(mob) {
    const p = this.player;
    const held = p.heldStack;
    const tool = ITEMS[held?.id]?.tool;
    let dmg = tool?.damage ?? 1;
    // Falling strikes hit harder (a small skill reward on touch screens too).
    if (!p.onGround && p.vel.y < -1 && !p.inWater) dmg *= 1.5;
    this.attackTimer = tool?.type === 'sword' ? ATTACK_COOLDOWN * 0.8 : ATTACK_COOLDOWN;
    this.game.renderer.triggerSwing();
    this.game.entities.attackMob(mob, dmg, p.pos);
    this.game.survival.exhaust(SURVIVAL.exhaustionAttack);
    if (!this.creative && tool) this.useTool(tool.type === 'sword' ? 1 : 2);
    this.game.input.vibrate(15);
  }

  // ---- Use ----------------------------------------------------------------------------------

  handleUse(fresh) {
    const p = this.player;
    const t = this.target;
    const us = this.useSlot();
    this.slot = us;
    const held = us.stack;
    const item = held ? ITEMS[held.id] : null;
    if (t?.kind === 'block' && !p.sneaking && fresh) {
      const d = BLOCKS[t.hit.id];
      if (d.interact && this.interactBlock(t.hit, d)) return;
    }
    if (!item) return;
    if (item.food && !(item.plants && t?.kind === 'block' && t.hit.id === B.farmland)) {
      if (!fresh) return;
      if (this.game.survival.canEat(held.id)) this.eating = { id: held.id, t: 0, slot: us };
      else this.game.toast("You're not hungry right now", 'deny');
      return;
    }
    if (item.use === 'bucket' || item.use === 'water_bucket' || item.use === 'lava_bucket') {
      if (fresh) this.useBucket(item.use);
      return;
    }
    if (item.use === 'bow') {
      if (!fresh || this.drawing) return;
      if (!this.creative && p.inventory.count('arrow') === 0) return this.game.toast('You need arrows', 'deny');
      this.drawing = { t: 0, slot: us };
      return;
    }
    if (item.use === 'fish') {
      if (fresh) this.useRod();
      return;
    }
    if (item.use === 'compass' || item.use === 'clock') {
      if (fresh) this.useGauge(item.use);
      return;
    }
    if (item.use === 'void_eye') {
      if (fresh) this.useVoidEye(t);
      return;
    }
    if (item.use === 'ignite') {
      if (fresh && t?.kind === 'block') this.useFlint(t.hit);
      return;
    }
    if (t?.kind !== 'block') return;
    const hit = t.hit;
    if (item.tool?.type === 'hoe' && (hit.id === B.grass || hit.id === B.dirt || hit.id === B.coarse_dirt || hit.id === B.snow_grass) && hit.normal[1] !== -1) {
      if (this.game.world.getBlock(hit.x, hit.y + 1, hit.z) !== B.air) return;
      this.game.world.setBlock(hit.x, hit.y, hit.z, hit.id === B.coarse_dirt ? B.dirt : B.farmland);
      this.game.audio.play('place_gravel');
      if (!this.creative) this.useTool(1, us);
      this.game.onTilled();
      return;
    }
    if (item.use === 'fertilize') {
      if (fresh && this.fertilize(hit)) {
        if (!this.creative) us.inv.consume(us.idx);
      }
      return;
    }
    const blockId = placedBlock(held.id);
    if (blockId !== null) this.placeBlock(hit, blockId, held, fresh);
  }

  // ---- Bow ------------------------------------------------------------------------------------

  updateBow(dt, input) {
    const d = this.drawing;
    if (!d) return;
    const held = d.slot.inv.get(d.slot.idx);
    if (!held || held.id !== 'bow') {
      this.drawing = null;
      return;
    }
    d.t += dt;
    if (input.use) return;
    this.drawing = null;
    if (d.t < 0.25) return;
    const p = this.player;
    if (!this.creative) {
      if (p.inventory.remove('arrow', 1) === 0) return;
      this.useTool(1, d.slot);
    }
    const pull = Math.min(1, d.t / 0.9);
    const dir = p.lookDir();
    const eye = p.eye;
    this.game.entities.shootArrow({ x: eye.x + dir.x * 0.5, y: eye.y - 0.1, z: eye.z + dir.z * 0.5 }, dir, 12 + 30 * pull, 2 + 7 * pull);
    this.game.renderer.triggerSwing();
  }

  // ---- Fishing --------------------------------------------------------------------------------

  useRod() {
    const p = this.player;
    const w = this.game.world;
    if (this.bobber) {
      if (this.bobber.bite) this.catchFish();
      else this.cancelFishing();
      return;
    }
    const hit = raycast(w, p.eye, p.lookDir(), 12, (id) => id === B.water);
    if (!hit) return this.game.toast('Cast the line onto water', 'deny');
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial({ color: 0xd8342c }));
    this.game.entities.group.add(mesh);
    this.bobber = { x: hit.x + 0.5, y: hit.y + 0.85, z: hit.z + 0.5, t: 3 + Math.random() * 8, bite: false, window: 0, mesh };
    this.game.audio.play('splash', { volume: 0.5 });
  }

  cancelFishing() {
    if (!this.bobber) return;
    this.game.entities.group.remove(this.bobber.mesh);
    this.bobber.mesh.geometry.dispose();
    this.bobber.mesh.material.dispose();
    this.bobber = null;
  }

  updateFishing(dt) {
    const b = this.bobber;
    if (!b) return;
    const p = this.player;
    const held = p.heldStack?.id === 'fishing_rod' || p.offhand.get(0)?.id === 'fishing_rod';
    if (!held || Math.hypot(b.x - p.pos.x, b.z - p.pos.z) > 16) return this.cancelFishing();
    if (b.bite) {
      b.window -= dt;
      if (b.window <= 0) {
        b.bite = false;
        b.t = 3 + Math.random() * 6;
      }
    } else {
      b.t -= dt;
      if (b.t <= 0) {
        b.bite = true;
        b.window = 1.2;
        this.game.audio.play('splash');
        this.game.renderer.spawnBlockParticles(Math.floor(b.x), Math.floor(b.y - 1), Math.floor(b.z), TILE.water, 1, 8);
        this.game.toast('Something bites! Tap Use to reel in');
      }
    }
    b.mesh.position.set(b.x, b.y + Math.sin(performance.now() / 300) * 0.04 - (b.bite ? 0.25 : 0), b.z);
  }

  catchFish() {
    const p = this.player;
    const r = Math.random();
    const id = r < 0.84 ? 'raw_fish' : r < 0.91 ? 'bone' : r < 0.96 ? 'string' : r < 0.99 ? 'gold_ingot' : 'azure_crystal';
    const left = p.inventory.add({ id, count: 1 });
    if (left) this.game.entities.spawnItem({ id, count: 1 }, { ...p.eye });
    this.game.audio.play('pickup');
    this.game.renderer.triggerSwing();
    this.game.toast(`Caught: ${ITEMS[id].name}`);
    this.cancelFishing();
    if (!this.creative) this.useTool(1, this.rodSlot());
  }

  rodSlot() {
    const p = this.player;
    return p.heldStack?.id === 'fishing_rod' ? { inv: p.inventory, idx: p.selected } : { inv: p.offhand, idx: 0 };
  }

  // ---- Small tools ------------------------------------------------------------------------------

  useGauge(kind) {
    const g = this.game;
    if (g.dim !== 'overworld') return g.toast(kind === 'compass' ? 'The needle spins wildly' : 'The clock has stopped');
    if (kind === 'clock') {
      const t = g.record.time;
      const hours = Math.floor((t.tod * 24 + 6) % 24), mins = Math.floor((((t.tod * 24 + 6) % 1) * 60) / 10) * 10;
      return g.toast(`Day ${t.day + 1} · ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`);
    }
    const sp = g.record.worldSpawn, p = this.player;
    const dx = sp.x - p.pos.x, dz = sp.z - p.pos.z;
    const dist = Math.round(Math.hypot(dx, dz));
    const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    const bearing = Math.round(Math.atan2(dx, -dz) / (Math.PI / 4));
    g.toast(dist < 4 ? 'You are at the world spawn' : `World spawn: ${dist} blocks ${names[((bearing % 8) + 8) % 8]}`);
  }

  useVoidEye(t) {
    const g = this.game;
    const w = g.world;
    if (t?.kind === 'block' && t.hit.id === B.end_frame) {
      const { x, y, z } = t.hit;
      const meta = w.getMeta(x, y, z);
      if (meta & 4) return;
      w.setBlock(x, y, z, B.end_frame, meta | 4);
      if (!this.creative) this.slot.inv.consume(this.slot.idx);
      g.audio.play('portal');
      if (tryOpenGate(w, x, y, z)) g.toast('The Void Gate hums open!');
      return;
    }
    if (g.dim !== 'overworld') return g.toast('The eye is dull here');
    const p = this.player;
    const found = nearestSanctum(w.generator, p.pos.x, p.pos.z);
    if (!found) return g.toast('The eye sees nothing nearby');
    const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    const bearing = Math.round(Math.atan2(found.x - p.pos.x, -(found.z - p.pos.z)) / (Math.PI / 4));
    g.toast(`The eye gazes ${names[((bearing % 8) + 8) % 8]} (about ${Math.round(found.dist)} blocks) and sinks deep below`);
  }

  useFlint(hit) {
    const g = this.game;
    const w = g.world;
    let used = false;
    if (hit.id === B.blast_charge) {
      g.ignite(hit.x, hit.y, hit.z);
      used = true;
    } else {
      for (const [dx, dy, dz] of [[hit.normal[0], hit.normal[1], hit.normal[2]], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
        if (hit.id === B.obsidian && lightPortal(w, hit.x + dx, hit.y + dy, hit.z + dz)) {
          used = true;
          g.audio.play('portal');
          break;
        }
      }
    }
    if (used && !this.creative) this.useTool(1, this.slot);
    if (!used) g.audio.play('click', { volume: 0.4 });
  }

  interactBlock(hit, d) {
    const w = this.game.world;
    const { x, y, z } = hit;
    switch (d.interact) {
      case 'door': {
        const meta = w.getMeta(x, y, z);
        const other = meta & 8 ? y - 1 : y + 1;
        w.setBlock(x, y, z, B.door, meta ^ 4);
        if (w.getBlock(x, other, z) === B.door) w.setBlock(x, other, z, B.door, w.getMeta(x, other, z) ^ 4);
        this.game.audio.play(meta & 4 ? 'door_close' : 'door_open', { pos: { x, y, z } });
        return true;
      }
      case 'trapdoor': {
        const meta = w.getMeta(x, y, z);
        w.setBlock(x, y, z, B.trapdoor, meta ^ 4);
        this.game.audio.play(meta & 4 ? 'door_close' : 'door_open', { pos: { x, y, z } });
        return true;
      }
      case 'bed':
        this.game.useBed(x, y, z);
        return true;
      case 'workbench':
        this.game.openCrafting('workbench');
        return true;
      case 'furnace':
        this.game.openContainer(x, y, z, 'furnace');
        return true;
      case 'chest':
        this.game.openContainer(x, y, z, 'chest');
        return true;
    }
    return false;
  }

  useBucket(kind) {
    const p = this.player;
    const w = this.game.world;
    const hit = raycast(w, p.eye, p.lookDir(), PLAYER.reach, (id, d) => (kind === 'bucket' ? id === B.water || id === B.lava : !!d.id && !d.fluid));
    if (!hit) return;
    if (kind === 'bucket') {
      if ((hit.id !== B.water && hit.id !== B.lava) || (hit.meta & 7) !== 0) return;
      w.setBlock(hit.x, hit.y, hit.z, B.air);
      this.swapHeld(hit.id === B.lava ? 'lava_bucket' : 'water_bucket');
      this.game.audio.play('splash');
      return;
    }
    const fluid = kind === 'lava_bucket' ? B.lava : B.water;
    if (fluid === B.water && this.game.dim === 'nether') {
      // The heat flashes water away.
      this.swapHeld('bucket');
      this.game.audio.play('fizz');
      this.game.toast('The water evaporates in the heat', 'warn');
      return;
    }
    const replace = BLOCKS[hit.id].replaceable ? hit : null;
    const c = replace ? { x: hit.x, y: hit.y, z: hit.z } : hit.place;
    const cur = w.getBlock(c.x, c.y, c.z);
    if (!w.canModify(c.x, c.y, c.z) || (cur !== B.air && !BLOCKS[cur].replaceable)) return;
    if (cur !== B.air && cur !== B.water && cur !== B.lava) w.breakBlock(c.x, c.y, c.z, 'fluid');
    w.setBlock(c.x, c.y, c.z, fluid, 0);
    this.swapHeld('bucket');
    this.game.audio.play('splash');
  }

  swapHeld(id) {
    if (this.creative) return;
    const p = this.player;
    const { inv, idx } = this.slot || { inv: p.inventory, idx: p.selected };
    const s = inv.get(idx);
    if (s.count > 1) {
      inv.consume(idx);
      const left = p.inventory.add({ id, count: 1 });
      if (left) this.game.entities.spawnItem({ id, count: 1 }, { ...p.eye });
    } else inv.set(idx, { id, count: 1 });
  }

  fertilize(hit) {
    const w = this.game.world;
    const d = BLOCKS[hit.id];
    if (d.crop) {
      const stage = hit.meta & 7;
      if (stage >= 7) return false;
      w.setBlock(hit.x, hit.y, hit.z, hit.id, Math.min(7, stage + 2 + Math.floor(Math.random() * 3)));
    } else if (d.sapling) {
      if (!w.growSapling(hit.x, hit.y, hit.z, d.sapling) && Math.random() < 0.5) return true;
    } else if (hit.id === B.grass) {
      for (let i = 0; i < 12; i++) {
        const x = hit.x + Math.floor(Math.random() * 7) - 3, z = hit.z + Math.floor(Math.random() * 7) - 3;
        if (w.getBlock(x, hit.y, z) === B.grass && w.getBlock(x, hit.y + 1, z) === B.air) w.setBlock(x, hit.y + 1, z, Math.random() < 0.8 ? B.tall_grass : [B.flower_red, B.flower_yellow, B.flower_blue][Math.floor(Math.random() * 3)]);
      }
    } else return false;
    this.game.renderer.spawnBlockParticles(hit.x, hit.y, hit.z, TILE.grass_top, 1, 6);
    this.game.ambient.grow(hit.x, hit.y, hit.z);
    this.game.audio.play('grow');
    return true;
  }

  /** Compute meta for a block placed against a hit face; null = invalid placement. */
  placementMeta(blockId, hit, c) {
    const d = BLOCKS[blockId];
    const w = this.game.world;
    const pf = this.facingIndex();
    const n = hit.normal;
    if (d.axis) return n[0] ? 1 : n[2] ? 2 : 0;
    if (d.facing) return (pf + 2) % 4;
    switch (d.shape) {
      case 'slab':
        return n[1] === -1 || (n[1] === 0 && hit.point.y - Math.floor(hit.point.y) > 0.5) ? 1 : 0;
      case 'stairs':
        return pf | (n[1] === -1 || (n[1] === 0 && hit.point.y - Math.floor(hit.point.y) > 0.5) ? 4 : 0);
      case 'trapdoor':
        return pf | (n[1] === -1 || (n[1] === 0 && hit.point.y - Math.floor(hit.point.y) > 0.5) ? 8 : 0);
      case 'door':
        return pf;
      case 'bed':
        return pf;
      case 'torch': {
        if (n[1] === 1) return SOLID[w.getBlock(c.x, c.y - 1, c.z)] ? 0 : null;
        const side = WALL_SIDE(n);
        return side < 0 ? null : side + 1;
      }
      case 'ladder': {
        const side = WALL_SIDE(n);
        return side < 0 ? null : side;
      }
      default:
        return 0;
    }
  }

  placeBlock(hit, blockId, held, fresh) {
    const w = this.game.world;
    const p = this.player;
    const d = BLOCKS[blockId];
    // Clicking replaceable vegetation/water replaces it instead of building on top.
    const targetReplaceable = BLOCKS[hit.id].replaceable && hit.id !== blockId;
    const c = targetReplaceable ? { x: hit.x, y: hit.y, z: hit.z } : { ...hit.place };
    const deny = (msg) => {
      if (fresh) {
        if (msg) this.game.toast(msg, 'deny');
        this.game.audio.play('deny');
      }
    };
    if (!w.canModify(c.x, c.y, c.z)) return deny('Out of bounds');
    const cur = w.getBlock(c.x, c.y, c.z);
    if (cur !== B.air && !BLOCKS[cur].replaceable) return deny(null);
    // Seeds and carrots plant only on tilled soil.
    if (d.crop && w.getBlock(c.x, c.y - 1, c.z) !== B.farmland) return deny('Plant on tilled soil (use a hoe)');
    const meta = this.placementMeta(blockId, hit, c);
    if (meta === null) return deny('Needs a solid surface');
    if (d.needsSupport && d.shape !== 'torch') {
      const below = w.getBlock(c.x, c.y - 1, c.z);
      if (!SOLID[below] || (!d.crop && !w.isSupported(c.x, c.y, c.z, blockId))) return deny("That can't grow here");
    }
    if (d.shape === 'ladder' && !SOLID[w.getBlock(c.x + [0, 1, 0, -1][meta], c.y, c.z + [-1, 0, 1, 0][meta])]) return deny('Needs a wall');
    const cells = [[c.x, c.y, c.z, meta]];
    if (d.shape === 'door') {
      if (!SOLID[w.getBlock(c.x, c.y - 1, c.z)]) return deny('Needs a solid floor');
      cells.push([c.x, c.y + 1, c.z, meta | 8]);
    } else if (d.shape === 'bed') {
      const [fx, fz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][meta];
      cells.push([c.x + fx, c.y, c.z + fz, meta | 4]);
      for (const [x, y, z] of cells) if (!SOLID[w.getBlock(x, y - 1, z)]) return deny('Needs a solid floor');
    }
    for (const [x, y, z] of cells.slice(1)) {
      const id = w.getBlock(x, y, z);
      if (!w.canModify(x, y, z) || (id !== B.air && !BLOCKS[id].replaceable)) return deny('Not enough space');
    }
    if (d.solid) {
      for (const [x, y, z] of cells) {
        if (this.intersectsEntity(x, y, z)) return deny(null);
      }
    }
    for (const [x, y, z, m] of cells) {
      const prev = w.getBlock(x, y, z);
      if (prev !== B.air && prev !== B.water) w.breakBlock(x, y, z, 'replace');
      w.setBlock(x, y, z, blockId, m);
    }
    if (blockId === B.chest || blockId === B.furnace) this.game.world.blockData.delete(posKey(c.x, c.y, c.z));
    if (!this.creative) this.slot.inv.consume(this.slot.idx);
    this.game.renderer.triggerSwing();
    this.game.audio.play(`place_${d.sound}`, { pos: { x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 } });
    this.game.onBlockPlaced(blockId);
  }

  intersectsEntity(x, y, z) {
    const overlap = (a) => a.maxX > x + 0.001 && a.minX < x + 0.999 && a.maxY > y + 0.001 && a.minY < y + 0.999 && a.maxZ > z + 0.001 && a.minZ < z + 0.999;
    if (overlap(entityBox(this.player))) return true;
    return this.game.entities.mobs.some((m) => !m.dead && overlap(entityBox(m)));
  }

  dropHeld(all) {
    const p = this.player;
    const s = p.heldStack;
    if (!s) return;
    const n = all ? s.count : 1;
    const drop = { ...s, count: n };
    p.inventory.consume(p.selected, n);
    const dir = p.lookDir();
    this.game.entities.spawnItem(drop, { x: p.pos.x + dir.x * 0.4, y: p.pos.y + 1.3, z: p.pos.z + dir.z * 0.4 }, { x: dir.x * 5, y: dir.y * 5 + 2, z: dir.z * 5 }, 1.2);
  }
}
