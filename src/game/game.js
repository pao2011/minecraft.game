// One playable world session: owns the World, player, creatures, timing, saving and the
// per-frame update order. UI and rendering are borrowed from the App.
import { World } from '../world/world.js';
import { ChunkStreamer } from '../world/streamer.js';
import { createPad, meshSection } from '../world/mesher.js';
import { Player } from '../entities/player.js';
import { EntityManager } from '../entities/entities.js';
import { Survival } from './survival.js';
import { Interaction } from './interaction.js';
import { Inventory } from '../items/inventory.js';
import { ITEMS, blockDrops, isValidItem } from '../items/items.js';
import { newFurnaceState, tickFurnace } from '../items/recipes.js';
import { rollLoot } from '../items/loot.js';
import { encodeChunk, decodeChunk, currentPalette } from '../save/serialize.js';
import { BLOCKS, B, SOLID } from '../world/blocks.js';
import { BIOMES } from '../world/biomes.js';
import { chunkKey, posKey, chunkKeyX, chunkKeyZ, toChunk } from '../world/coords.js';
import { CHUNK_SIZE, DAY_LENGTH_OPTIONS, WORLD_HEIGHT, SEA_LEVEL } from '../config/constants.js';
import { collidesAt } from '../entities/physics.js';
import { hash4 } from '../util/noise.js';
import { log } from '../util/log.js';

const AUTOSAVE_SECONDS = 45;

export class Game {
  constructor(app, record) {
    this.app = app;
    this.renderer = app.renderer;
    this.audio = app.audio;
    this.input = app.input;
    this.settings = app.settings;
    this.storage = app.storage;
    this.record = record;
    this.pad = createPad();
    this.meshQueue = new Set();
    this.saving = false;
    this.autosaveTimer = AUTOSAVE_SECONDS;
    this.lastSaveOk = true;
    this.playTimeAcc = 0;
    this.rain = record.weather.state === 'rain' ? 1 : 0;
    this.cameraShake = 0;
    this.renderDistance = this.settings.get('renderDistance');
    this.frameStats = { samples: [], window: 0, slowWindows: 0, fastWindows: 0, lastAdjust: 0 };
    this.heightCache = new Map();
    this.heightCacheTime = 0;
    this.lastBreakTool = null;
    this.stats = { chunkGenMs: 0, meshMs: 0, meshCount: 0, lastSaveMs: 0 };
    this.ready = false;
  }

  get creative() {
    return this.record.mode === 'creative';
  }

  // ---- Lifecycle ------------------------------------------------------------------------------

  async init() {
    const rec = this.record;
    this.world = new World(rec.seed);
    for (const [key, c] of Object.entries(rec.containers)) this.world.blockData.set(key, c);
    this.palette = rec.palette;
    this.savedKeys = await this.storage.savedChunkKeys(rec.id).catch((err) => {
      log.error('Could not list saved chunks', err);
      return new Set();
    });
    this.world.on('blockBroken', (...a) => this.onBlockBroken(...a));
    this.streamer = new ChunkStreamer(this.world, {
      loadSaved: (cx, cz) => this.loadSavedChunk(cx, cz),
      onUnload: (c) => this.renderer.removeChunk(c.cx, c.cz),
    });
    this.player = new Player();
    this.survival = new Survival(this);
    this.interaction = new Interaction(this);
    this.entities = new EntityManager(this);
    const p = this.player;
    const sp = rec.player;
    if (!rec.worldSpawn) rec.worldSpawn = this.world.generator.findSpawn();
    if (sp.pos) {
      Object.assign(p.pos, sp.pos);
      p.yaw = sp.yaw;
      p.pitch = sp.pitch;
      p.health = sp.health;
      p.hunger = sp.hunger;
      p.saturation = sp.saturation;
      p.exhaustion = sp.exhaustion;
      p.air = sp.air;
      p.inventory = Inventory.fromJSON(sp.inventory, 36);
      p.armor = Inventory.fromJSON(sp.armor, 4);
      p.selected = sp.selected;
      p.spawnPoint = sp.spawn;
      p.flying = this.creative && sp.flying;
      this.needsUnstick = true;
      if (sp.dead || p.health <= 0) this.pendingDeathScreen = true;
    } else {
      Object.assign(p.pos, rec.worldSpawn);
      this.needsUnstick = true;
      this.giveStartingItems();
    }
    this.pendingEntities = rec.entities;
    this.renderer.clearChunks();
    this.setupWarnings = rec.warnings || [];
  }

  giveStartingItems() {
    const inv = this.player.inventory;
    if (this.creative) {
      const kit = ['grass', 'dirt', 'stone', 'cobblestone', 'oak_planks', 'oak_log', 'glass', 'stone_bricks', 'torch'];
      kit.forEach((id, i) => inv.set(i, { id, count: 64 }));
    } else if (this.record.starterBonus) {
      for (const s of [{ id: 'wood_pickaxe', count: 1 }, { id: 'wood_axe', count: 1 }, { id: 'bread', count: 6 }, { id: 'torch', count: 12 }, { id: 'workbench', count: 1 }, { id: 'oak_planks', count: 16 }]) inv.add(s);
    }
  }

  loadSavedChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    const pendingUnload = this.world.unloadedModified.get(key);
    if (pendingUnload) return Promise.resolve({ blocks: pendingUnload.blocks, meta: pendingUnload.meta });
    if (!this.savedKeys.has(key)) return null;
    return this.storage.loadChunk(this.record.id, cx, cz).then((rec) => {
      if (!rec) return null;
      try {
        return decodeChunk(rec, this.palette);
      } catch (err) {
        // Keep the world playable: this one chunk falls back to generated terrain and is reported.
        log.error(`Saved chunk ${cx},${cz} is damaged; regenerating it`, err);
        this.app.ui.toast(`A damaged area (${cx * 16}, ${cz * 16}) was regenerated`, 'warn');
        return null;
      }
    });
  }

  /** Loading progress 0..1 (spawn area generated, lit and meshed). */
  loadProgress() {
    const r = Math.min(2, this.renderDistance);
    const gen = this.streamer.progress(r + 1);
    const pcx = toChunk(Math.floor(this.player.pos.x)), pcz = toChunk(Math.floor(this.player.pos.z));
    let meshed = 0, total = 0;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        total++;
        const c = this.world.getChunk(pcx + dx, pcz + dz);
        if (c && c.meshedOnce) meshed++;
      }
    }
    return gen * 0.6 + (meshed / total) * 0.4;
  }

  /** Called every frame while the loading screen is visible. */
  updateLoading(dt) {
    this.streamer.update(this.player.pos.x, this.player.pos.z, this.renderDistance, 40);
    this.processMeshes(30);
    this.updateEnvironment(0);
    const done = this.loadProgress() >= 0.999;
    if (done && !this.ready) this.finishLoading();
    return done;
  }

  finishLoading() {
    this.ready = true;
    const p = this.player;
    if (this.needsUnstick) {
      p.unstick(this.world);
      this.needsUnstick = false;
    }
    this.entities.restore(this.pendingEntities);
    this.pendingEntities = null;
    for (const w of this.setupWarnings) this.app.ui.toast(w, 'warn');
    if (this.pendingDeathScreen) {
      this.pendingDeathScreen = false;
      p.health = 0;
      this.onPlayerDeath({ type: 'generic' }, true);
    }
    this.syncHeld(true);
  }

  // ---- Frame update -----------------------------------------------------------------------

  update(dt, inp, { paused = false } = {}) {
    const p = this.player;
    const rec = this.record;
    this.stats.frameDt = dt;
    if (!paused) {
      this.playTimeAcc += dt;
      // Look.
      const lookScale = this.settings.get('reducedMotion') ? 0.85 : 1;
      p.yaw -= inp.lookDX * lookScale;
      p.pitch = Math.max(-1.55, Math.min(1.55, p.pitch - inp.lookDY * lookScale));
      // Hotbar.
      if (inp.hotbar !== null) this.selectSlot(inp.hotbar);
      if (inp.scroll) this.selectSlot((p.selected + inp.scroll + 9) % 9);
      if (inp.edges.has('flyToggle') && this.creative) {
        p.flying = !p.flying;
        if (p.flying) p.vel.y = 0;
      }
      this.input.setCreative(this.creative, p.flying);
      p.update(dt, inp, this.world, {
        creative: this.creative,
        autoJump: this.settings.get('autoJump'),
        hungerAllowsSprint: p.hunger > 6,
      });
      if (!p.sprinting && inp.moveZ <= 0.1 && Math.hypot(inp.moveX, inp.moveZ) < 0.1) this.input.clearSprint();
      this.interaction.update(dt, inp);
      this.survival.update(dt);
      this.entities.update(dt);
      this.world.time += dt;
      this.world.tickFluids(96);
      this.randomTickAcc = (this.randomTickAcc || 0) + dt;
      if (this.randomTickAcc > 0.25) {
        this.randomTickAcc = 0;
        this.world.randomTick(p.pos.x, p.pos.z, 3);
      }
      this.tickFurnaces(dt);
      this.advanceTime(dt);
      this.updateWeather(dt);
      rec.playtime += dt;
    }
    this.streamer.update(p.pos.x, p.pos.z, this.renderDistance, 5);
    this.processMeshes(6);
    this.updateEnvironment(dt);
    if (!paused) {
      this.autosaveTimer -= dt;
      if (this.autosaveTimer <= 0) {
        this.autosaveTimer = AUTOSAVE_SECONDS;
        this.save('autosave');
      }
    }
    this.syncHeld();
    this.adaptQuality(dt);
  }

  selectSlot(i) {
    if (i < 0 || i > 8 || i === this.player.selected) return;
    this.player.selected = i;
    this.interaction.resetMining();
    this.interaction.eating = null;
    this.audio.play('click', { volume: 0.5 });
    this.app.tutorial?.event('hotbar');
  }

  syncHeld(force = false) {
    const s = this.player.heldStack;
    const key = s ? s.id : null;
    if (!force && key === this.heldKey) return;
    this.heldKey = key;
    if (!key) return this.renderer.setHeld(null);
    const it = ITEMS[key];
    if (it.kind === 'block' && BLOCKS[it.block].shape === 'cube') this.renderer.setHeld(key, { blockFaces: BLOCKS[it.block].faces });
    else this.renderer.setHeld(key, { iconTexture: this.entities.iconTexture(key) });
  }

  // ---- Time and weather ---------------------------------------------------------------------

  get dayLength() {
    return DAY_LENGTH_OPTIONS[this.record.rules.dayLength] || DAY_LENGTH_OPTIONS.normal;
  }

  advanceTime(dt) {
    const t = this.record.time;
    if (!this.record.rules.daylightCycle) return;
    t.tod += dt / this.dayLength;
    if (t.tod >= 1) {
      t.tod -= 1;
      t.day += 1;
    }
  }

  get isDay() {
    return Math.sin(this.record.time.tod * Math.PI * 2) > 0.02;
  }

  get isNight() {
    return Math.sin(this.record.time.tod * Math.PI * 2) < -0.08;
  }

  /** 0 (darkest night) .. 1 (noon), used for spawn light checks. */
  get daylightLevel() {
    return Math.max(0, Math.min(1, ((this.renderer.daylight ?? 1) - 0.16) / 0.84));
  }

  updateWeather(dt) {
    const w = this.record.weather;
    w.timer -= dt;
    if (w.timer <= 0) {
      if (w.state === 'clear') {
        w.state = 'rain';
        w.timer = 120 + Math.random() * 240;
      } else {
        w.state = 'clear';
        w.timer = 500 + Math.random() * 900;
      }
    }
    const target = w.state === 'rain' ? 1 : 0;
    this.rain += (target - this.rain) * Math.min(1, dt * 0.25);
  }

  setWeather(state) {
    this.record.weather.state = state;
    this.record.weather.timer = state === 'rain' ? 300 : 900;
  }

  /** Top-most blocking height for a column (cached briefly) for rain occlusion. */
  precipitationFloor(x, z) {
    const key = `${x},${z}`;
    let h = this.heightCache.get(key);
    if (h === undefined) {
      h = -1;
      for (let y = WORLD_HEIGHT - 1; y > 0; y--) {
        const id = this.world.getBlock(x, y, z);
        if (id && (SOLID[id] || BLOCKS[id].fluid || BLOCKS[id].leaves)) {
          h = y + 1;
          break;
        }
      }
      this.heightCache.set(key, h);
    }
    return h;
  }

  updateEnvironment(dt) {
    const p = this.player;
    const eye = p.eye;
    const rec = this.record;
    const underwater = p.headInWater;
    const biome = BIOMES[this.world.generator.column(Math.floor(p.pos.x), Math.floor(p.pos.z)).biome];
    this.currentBiome = biome;
    const precip = biome.weather === 'none' ? null : biome.weather === 'snow' || (biome.key === 'mountains' && p.pos.y > 95) ? 'snow' : 'rain';
    const env = this.renderer.setEnvironment({
      timeOfDay: rec.time.tod,
      rain: precip ? this.rain : this.rain * 0.4,
      underwater,
      inLava: p.headInLava,
      renderDistance: this.renderDistance,
      brightness: this.settings.get('brightness'),
    });
    this.heightCacheTime += dt;
    if (this.heightCacheTime > 1) {
      this.heightCache.clear();
      this.heightCacheTime = 0;
    }
    if (dt > 0) {
      this.renderer.updateWeather(dt, eye, precip, this.rain, (x, z) => this.precipitationFloor(x, z));
      this.renderer.updateParticles(dt, this.world);
    }
    // Ambient audio: open sky gives wind, enclosed dark spaces underground give cave tone.
    const [sky] = this.world.getLight(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z));
    const underground = sky < 6 && eye.y < SEA_LEVEL + 10;
    this.audio.setListener(eye.x, eye.y, eye.z, p.yaw);
    this.audio.setAmbient({
      wind: underground ? 0 : Math.min(1, 0.3 + Math.max(0, eye.y - SEA_LEVEL) / 60) * (sky / 15),
      rain: precip === 'rain' && !underground ? this.rain * (sky / 15) : 0,
      cave: underground ? 1 : 0,
      water: underwater ? 1 : 0,
    }, dt);
    return env;
  }

  // ---- Meshing ------------------------------------------------------------------------------

  processMeshes(budgetMs) {
    for (const k of this.world.takeDirtySections()) this.meshQueue.add(k);
    if (!this.meshQueue.size) return;
    const p = this.player;
    const pcx = Math.floor(p.pos.x / CHUNK_SIZE), pcz = Math.floor(p.pos.z / CHUNK_SIZE), psy = Math.floor(p.pos.y / 16);
    const candidates = [];
    for (const key of this.meshQueue) {
      const ck = Math.floor(key / 16), sy = key % 16;
      const cx = chunkKeyX(ck), cz = chunkKeyZ(ck);
      const dist = Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz));
      if (!this.world.chunks.has(ck)) {
        this.meshQueue.delete(key);
        continue;
      }
      if (dist > this.renderDistance) continue;
      if (!this.world.neighborsReady(cx, cz)) continue;
      candidates.push([key, cx, sy, cz, (cx - pcx) ** 2 + (cz - pcz) ** 2 + ((sy - psy) * 0.5) ** 2]);
    }
    candidates.sort((a, b) => a[4] - b[4]);
    const t0 = performance.now();
    for (const [key, cx, sy, cz] of candidates) {
      if (performance.now() - t0 > budgetMs) break;
      this.meshQueue.delete(key);
      const t1 = performance.now();
      this.world.fillPad(cx, sy, cz, this.pad);
      const chunk = this.world.getChunk(cx, cz);
      const data = meshSection(this.pad, chunk.climate, { fancyLeaves: this.settings.get('fancyLeaves') });
      this.renderer.uploadSection(key, cx, sy, cz, data);
      chunk.meshedSections = (chunk.meshedSections || 0) | (1 << sy);
      if (chunk.meshedSections === 255) chunk.meshedOnce = true;
      this.stats.meshMs = this.stats.meshMs * 0.95 + (performance.now() - t1) * 0.05;
      this.stats.meshCount++;
    }
  }

  /** Rebuild every loaded section (after a graphics option such as leaf quality changes). */
  remeshAll() {
    for (const c of this.world.chunks.values()) for (let s = 0; s < 8; s++) this.world.markSection(c.cx, s, c.cz);
  }

  setRenderDistance(d) {
    this.renderDistance = d;
    // Sections that were out of range become meshable again.
    this.remeshAll();
  }

  /** Lower render distance when frames stay slow; recover slowly when they are fast again. */
  adaptQuality(dt) {
    const fs = this.frameStats;
    fs.samples.push(dt);
    fs.window += dt;
    if (fs.window < 4) return;
    const avg = fs.samples.reduce((a, b) => a + b, 0) / fs.samples.length;
    fs.samples = [];
    fs.window = 0;
    this.stats.avgFrameMs = avg * 1000;
    if (!this.settings.get('adaptiveQuality')) return;
    const now = performance.now();
    const target = this.settings.get('renderDistance');
    if (avg > 1 / 24) {
      fs.slowWindows++;
      fs.fastWindows = 0;
    } else if (avg < 1 / 50) {
      fs.fastWindows++;
      fs.slowWindows = 0;
    } else fs.slowWindows = fs.fastWindows = 0;
    if (now - fs.lastAdjust < 12000) return;
    if (fs.slowWindows >= 2 && this.renderDistance > 2) {
      this.setRenderDistance(this.renderDistance - 1);
      fs.lastAdjust = now;
      fs.slowWindows = 0;
      log.info(`Adaptive quality: render distance -> ${this.renderDistance}`);
    } else if (fs.fastWindows >= 3 && this.renderDistance < target) {
      this.setRenderDistance(this.renderDistance + 1);
      fs.lastAdjust = now;
      fs.fastWindows = 0;
    }
  }

  // ---- Rendering ----------------------------------------------------------------------------

  render(dt) {
    const p = this.player;
    const eye = p.eye;
    let yaw = p.yaw, pitch = p.pitch;
    if (this.cameraShake > 0) {
      this.cameraShake = Math.max(0, this.cameraShake - dt);
      if (!this.settings.get('reducedMotion')) pitch += Math.sin(this.cameraShake * 50) * this.cameraShake * 0.06;
    }
    const walking = p.onGround && !p.flying ? Math.min(1, Math.hypot(p.vel.x, p.vel.z) / 4.3) : 0;
    const bob = this.settings.get('reducedMotion') ? 0 : walking;
    const [sky, blk] = this.world.getLight(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z));
    this.renderer.setHandBrightness(this.renderer.lightLevelToBrightness(sky, blk));
    this.renderer.render({ x: eye.x, y: eye.y, z: eye.z, yaw, pitch }, dt, { showHand: !p.dead && this.app.ui.handVisible, walking: bob });
  }

  // ---- Events from subsystems ---------------------------------------------------------------

  blockBrightness(x, y, z) {
    const [sky, blk] = this.world.getLight(x, y, z);
    return this.renderer.lightLevelToBrightness(sky, blk);
  }

  onBlockBroken(x, y, z, id, meta, cause, data) {
    // Containers spill their contents; drops depend on the tool that broke the block.
    if (data?.slots) for (const s of data.slots) if (s) this.entities.spawnItem({ ...s }, { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
    if (cause === 'player' && this.creative) return;
    if (cause === 'replace') return;
    const tool = cause === 'player' ? this.lastBreakTool : null;
    const drops = cause === 'player' ? blockDrops(id, meta, tool) : blockDrops(id, meta, BLOCKS[id].toolLevel ? null : tool);
    for (const s of drops) this.entities.spawnItem(s, { x: x + 0.5, y: y + 0.4, z: z + 0.5 });
    if (id === B.bed && this.player.spawnPoint && Math.abs(this.player.spawnPoint.x - x) < 2 && Math.abs(this.player.spawnPoint.z - z) < 2) this.player.spawnPoint = null;
  }

  onBlockMined(id) {
    this.app.tutorial?.event('mine', id);
  }

  onBlockPlaced(id) {
    this.app.tutorial?.event('place', id);
  }

  onPickup(id, n) {
    this.app.tutorial?.event('pickup', id);
    this.app.ui.hud.flashPickup(id, n);
  }

  onAte(id) {
    this.audio.play('burp');
    this.app.ui.toast(`Ate ${ITEMS[id].name}`);
  }

  onTilled() {
    this.app.tutorial?.event('till');
  }

  onMobKilled(m) {
    this.app.tutorial?.event('kill', m.type);
  }

  onFootstep() {
    const p = this.player;
    const below = this.world.getBlock(Math.floor(p.pos.x), Math.floor(p.pos.y - 0.2), Math.floor(p.pos.z));
    if (below) this.audio.play(`step_${BLOCKS[below].sound}`, { volume: p.sneaking ? 0.4 : 0.8 });
  }

  onLand(dist) {
    if (dist > 1.2) this.audio.play('land', { volume: Math.min(1, dist / 6) });
  }

  onPlayerHurt(dmg, source) {
    this.audio.play('hurt');
    this.cameraShake = 0.35;
    this.app.ui.hud.flashDamage();
    this.input.vibrate(40);
    void source;
  }

  onItemBroken(id) {
    this.audio.play('toolbreak');
    this.app.ui.toast(`${ITEMS[id]?.name || 'Item'} broke!`, 'warn');
  }

  onPlayerDeath(source, restored = false) {
    const p = this.player;
    if (p.dead && !restored) return;
    p.dead = true;
    this.interaction.resetMining();
    if (!restored && !this.record.rules.keepInventory) {
      // Scatter everything at the death spot; nothing is deleted.
      for (const inv of [p.inventory, p.armor]) {
        for (let i = 0; i < inv.size; i++) {
          const s = inv.get(i);
          if (s) this.entities.spawnItem(s, { x: p.pos.x, y: p.pos.y + 0.8, z: p.pos.z }, { x: (Math.random() - 0.5) * 4, y: 2 + Math.random() * 3, z: (Math.random() - 0.5) * 4 }, 2);
          inv.set(i, null);
        }
      }
    }
    const causes = { fall: 'fell from a high place', lava: 'tried to swim in lava', drown: 'ran out of air', starve: 'starved', cactus: 'hugged a cactus', mob: 'was defeated by a creature', projectile: 'was struck by a bone shard', void: 'fell out of the world' };
    this.deathMessage = `You ${causes[source?.type] || 'died'}.`;
    this.app.showDeath(this.deathMessage, this.record.rules.keepInventory);
    this.save('death');
  }

  respawn() {
    const p = this.player;
    this.survival.resetForRespawn();
    let target = null;
    const sp = p.spawnPoint;
    if (sp && this.world.isLoaded(sp.x, sp.z) && this.world.getBlock(Math.floor(sp.x), Math.floor(sp.y), Math.floor(sp.z)) === B.bed) {
      target = this.findFreeSpotNear(Math.floor(sp.x), Math.floor(sp.y), Math.floor(sp.z));
      if (!target) this.app.ui.toast('Your bedroll was obstructed', 'warn');
    } else if (sp && this.world.isLoaded(sp.x, sp.z)) {
      p.spawnPoint = null;
      this.app.ui.toast('Your bedroll is missing; returning to world spawn', 'warn');
    } else if (sp) target = { x: sp.x + 0.5, y: sp.y + 0.6, z: sp.z + 0.5 };
    if (!target) target = { ...this.record.worldSpawn };
    Object.assign(p.pos, target);
    p.pitch = 0;
    this.needsUnstickAfterLoad = true;
    this.save('respawn');
  }

  /** Free 2-high spot next to a block, for bed respawns. */
  findFreeSpotNear(x, y, z) {
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      for (const dy of [0, 1, -1]) {
        const pos = { x: x + dx + 0.5, y: y + dy + (dx || dz ? 0 : 0.5625), z: z + dz + 0.5 };
        if (!collidesAt(this.world, this.player, pos) && SOLID[this.world.getBlock(x + dx, Math.floor(pos.y - 0.01) - (dx || dz ? 1 : 0), z + dz)]) return pos;
      }
    }
    return null;
  }

  /** Called each frame from the app to finish pending teleports once terrain is loaded. */
  postUpdate() {
    if (this.needsUnstickAfterLoad && this.world.isLoaded(this.player.pos.x, this.player.pos.z)) {
      this.needsUnstickAfterLoad = false;
      this.player.unstick(this.world);
    }
  }

  useBed(x, y, z) {
    const p = this.player;
    p.spawnPoint = { x, y, z };
    if (!this.isNight && this.record.weather.state !== 'rain') {
      this.app.ui.toast('Respawn point set. You can only sleep at night.');
      return;
    }
    const near = this.entities.mobs.some((m) => m.def.hostile && !m.dead && Math.hypot(m.pos.x - x, m.pos.y - y, m.pos.z - z) < 9);
    if (near && !this.creative) {
      this.app.ui.toast("You can't rest now: creatures are nearby", 'deny');
      return;
    }
    this.app.sleep(() => {
      const t = this.record.time;
      if (t.tod > 0.5) t.day += 1;
      t.tod = 0.01;
      this.record.weather.state = 'clear';
      this.record.weather.timer = 600;
      this.rain = 0;
      this.app.ui.toast('You feel rested. Respawn point set.');
      this.save('sleep');
    });
  }

  openCrafting(station) {
    this.app.openInventory(station === 'workbench' ? 'crafting' : 'inventory', { station });
    this.audio.play('open');
  }

  /** Container state for a chest/furnace; rolls loot for generated chests on first open. */
  containerAt(x, y, z, type) {
    const key = posKey(x, y, z);
    let st = this.world.blockData.get(key);
    if (!st || st.type !== type) {
      if (type === 'furnace') st = newFurnaceState();
      else {
        st = { type: 'chest', slots: new Array(27).fill(null) };
        const loot = (this.world.getMeta(x, y, z) >> 2) & 7;
        if (loot) {
          st.slots = rollLoot(loot, hash4(this.world.generator.seed, x, y, z), isValidItem);
          // Clear the loot marker so the chest is never re-rolled, even if the state is lost.
          this.world.setBlock(x, y, z, B.chest, this.world.getMeta(x, y, z) & 3, { silent: true });
        }
      }
      this.world.blockData.set(key, st);
      const c = this.world.chunkAtBlock(x, z);
      if (c) {
        c.modified = true;
        c.dirtySave = true;
      }
    }
    return st;
  }

  openContainer(x, y, z, type) {
    const st = this.containerAt(x, y, z, type);
    this.app.openContainer(type, st, { x, y, z });
    this.audio.play('open', { pos: { x, y, z } });
  }

  tickFurnaces(dt) {
    for (const [key, st] of this.world.blockData) {
      if (st.type !== 'furnace') continue;
      const [x, y, z] = key.split(',').map(Number);
      if (!this.world.isLoaded(x, z) || this.world.getBlock(x, y, z) !== B.furnace) continue;
      const wasLit = st.burn > 0;
      const lit = tickFurnace(st, dt);
      if (lit !== wasLit) {
        const meta = this.world.getMeta(x, y, z);
        this.world.setBlock(x, y, z, B.furnace, lit ? meta | 4 : meta & 3, { silent: true });
      }
      if (lit || wasLit) st.dirty = true;
    }
  }

  toast(msg, kind) {
    this.app.ui.toast(msg, kind);
    if (kind === 'deny') this.audio.play('deny');
  }

  // ---- Saving -------------------------------------------------------------------------------

  snapshotRecord() {
    const p = this.player;
    const rec = this.record;
    rec.lastPlayed = Date.now();
    rec.palette = currentPalette();
    rec.player = {
      pos: { ...p.pos },
      yaw: p.yaw,
      pitch: p.pitch,
      health: p.health,
      hunger: p.hunger,
      saturation: p.saturation,
      exhaustion: p.exhaustion,
      air: p.air,
      inventory: p.inventory.toJSON(),
      armor: p.armor.toJSON(),
      selected: p.selected,
      spawn: p.spawnPoint,
      flying: p.flying,
      dead: p.dead,
    };
    const containers = {};
    for (const [k, v] of this.world.blockData) {
      if (v.type === 'chest') containers[k] = { type: 'chest', slots: v.slots.map((s) => (s ? { ...s } : null)) };
      else if (v.type === 'furnace') containers[k] = { type: 'furnace', slots: v.slots.map((s) => (s ? { ...s } : null)), burn: v.burn, burnMax: v.burnMax, progress: v.progress };
    }
    rec.containers = containers;
    rec.entities = this.entities.serialize();
    const { warnings, ...clean } = rec;
    void warnings;
    return clean;
  }

  /** Save the world. Returns true on success; failures keep the previous save intact. */
  async save(reason = 'manual', { thumbnail = null } = {}) {
    if (this.saving || !this.ready) return false;
    this.saving = true;
    const t0 = performance.now();
    const chunks = [];
    const savedChunkObjs = [];
    try {
      for (const c of this.world.chunks.values()) {
        if (!c.dirtySave) continue;
        chunks.push({ cx: c.cx, cz: c.cz, data: encodeChunk(c.blocks, c.meta) });
        savedChunkObjs.push(c);
      }
      const unloaded = [...this.world.unloadedModified.entries()];
      for (const [, u] of unloaded) chunks.push({ cx: u.cx, cz: u.cz, data: encodeChunk(u.blocks, u.meta) });
      const record = this.snapshotRecord();
      if (thumbnail) record.thumbnail = thumbnail;
      this.app.ui.hud.setSaving(true);
      await this.storage.saveWorld(record, chunks);
      for (const c of savedChunkObjs) c.dirtySave = false;
      for (const [k] of unloaded) this.world.unloadedModified.delete(k);
      for (const ch of chunks) this.savedKeys.add(chunkKey(ch.cx, ch.cz));
      this.lastSaveOk = true;
      this.stats.lastSaveMs = performance.now() - t0;
      this.stats.lastSaveChunks = chunks.length;
      log.info(`Saved (${reason}): ${chunks.length} chunks in ${this.stats.lastSaveMs.toFixed(1)} ms`);
      return true;
    } catch (err) {
      this.lastSaveOk = false;
      log.error('Save failed', err);
      this.app.ui.toast('Saving failed. Your last save is kept; free some storage and try again.', 'warn');
      return false;
    } finally {
      this.saving = false;
      this.app.ui.hud.setSaving(false);
    }
  }

  dispose() {
    this.streamer.dispose();
    this.entities.dispose();
    this.renderer.clearChunks();
    this.renderer.setHeld(null);
    this.renderer.setSelection(null);
    this.renderer.setCrack(null);
  }
}

export { chunkKey };
