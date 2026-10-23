// Application controller: screen state machine, main loop, world management and platform
// lifecycle (pause on background, Android back button, autosave on exit).
import { Renderer } from '../rendering/renderer.js';
import { AudioManager } from '../audio/audio.js';
import { InputManager } from '../input/input.js';
import { Settings } from './settings.js';
import { Storage } from '../save/storage.js';
import { normalizeWorld, newWorldRecord } from '../save/serialize.js';
import { Game } from './game.js';
import { Tutorial } from './tutorial.js';
import { UIManager } from '../ui/ui.js';
import { mainMenu, worldsScreen, createWorldScreen, settingsScreen, creditsScreen, pauseScreen, deathScreen, loadingScreen, dialog } from '../ui/menus.js';
import { World } from '../world/world.js';
import { ChunkStreamer } from '../world/streamer.js';
import { createPad, meshSection } from '../world/mesher.js';
import { chunkKeyX, chunkKeyZ } from '../world/coords.js';
import { log } from '../util/log.js';
import { BLOCKS, B } from '../world/blocks.js';
import { ITEMS } from '../items/items.js';
import { collidesAt } from '../entities/physics.js';
import { DIFFICULTY } from '../config/constants.js';
import { structuresIn } from '../world/structures.js';

const uid = () => `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Slowly orbiting live voxel landscape behind the main menu. */
class MenuBackground {
  constructor(renderer) {
    this.renderer = renderer;
    this.world = new World('blockwild-vista-7');
    this.streamer = new ChunkStreamer(this.world, {});
    this.pad = createPad();
    const s = this.world.generator.findSpawn();
    this.center = { x: s.x, y: s.y + 14, z: s.z };
    this.angle = 0.6;
    renderer.clearChunks();
  }

  update(dt) {
    this.angle += dt * 0.03;
    const r = 10;
    const pos = { x: this.center.x + Math.cos(this.angle) * r, y: this.center.y, z: this.center.z + Math.sin(this.angle) * r };
    this.streamer.update(this.center.x, this.center.z, 3, 6);
    const t0 = performance.now();
    for (const key of this.world.takeDirtySections()) {
      const ck = Math.floor(key / 16), sy = key % 16;
      const cx = chunkKeyX(ck), cz = chunkKeyZ(ck);
      if (!this.world.chunks.has(ck)) continue;
      if (!this.world.neighborsReady(cx, cz) || performance.now() - t0 > 8) {
        this.world.dirtySections.add(key);
        continue;
      }
      this.world.fillPad(cx, sy, cz, this.pad);
      this.renderer.uploadSection(key, cx, sy, cz, meshSection(this.pad, this.world.getChunk(cx, cz).climate));
    }
    this.renderer.setEnvironment({ timeOfDay: 0.455, renderDistance: 3 });
    this.renderer.updateParticles(dt, null);
    this.renderer.render({ x: pos.x, y: pos.y, z: pos.z, yaw: Math.PI / 2 - this.angle + Math.PI, pitch: -0.32 }, dt, { showHand: false });
  }

  dispose() {
    this.streamer.dispose();
    this.renderer.clearChunks();
  }
}

export class App {
  async start() {
    this.settings = new Settings();
    this.storage = await new Storage().open();
    this.canvas = document.getElementById('game-canvas');
    this.renderer = new Renderer(this.canvas);
    this.audio = new AudioManager(this.settings);
    this.ui = new UIManager(this);
    this.input = new InputManager(document.getElementById('ui'), this.settings);
    this.tutorial = new Tutorial(this);
    this.state = 'menu';
    this.game = null;
    this.fps = 60;
    this.canExit = !!window.AndroidHost?.exit;
    this.applySettings();
    this.settings.onChange((k) => this.onSettingChanged(k));
    window.addEventListener('resize', () => this.renderer.resize());
    // Audio may only start from a user gesture on mobile browsers.
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this.installLifecycle();
    // Desktop: the mouse must be captured to look around; offer a click target when it is not.
    this.clickToPlay = document.createElement('div');
    this.clickToPlay.className = 'screen dim hidden';
    this.clickToPlay.innerHTML = '<div class="panel dialog"><div class="panel-body" style="text-align:center;font-weight:700">Click to play<div class="tip" style="font-weight:400;margin-top:6px">Esc releases the mouse and pauses</div></div></div>';
    this.clickToPlay.addEventListener('click', () => this.input.requestPointerLock(this.canvas));
    document.getElementById('ui').appendChild(this.clickToPlay);
    if (!this.storage.persistent) this.ui.toast('This browser blocks storage: worlds will not be saved after closing.', 'warn');
    await this.showMainMenu();
    this.last = performance.now();
    this.acc = 0;
    requestAnimationFrame((t) => this.loop(t));
    // Read-only handles for automated tests and debugging; nothing here is shown to players.
    window.__blockwild = this;
    window.__bw = { BLOCKS, B, ITEMS, collidesAt, DIFFICULTY, structuresIn };
    log.info('Blockwild started');
  }

  applySettings() {
    const s = this.settings;
    this.ui.applySettings(s);
    this.renderer.setQuality({ pixelRatio: s.get('resolution'), clouds: s.get('clouds'), waterAnimation: s.get('waterAnimation') && !s.get('reducedMotion'), particles: s.get('particles'), effects: s.get('effects') });
    this.renderer.setFov(s.get('fov'));
    const mode = s.get('controlsMode');
    const touchCapable = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    this.input.setTouchMode(mode === 'touch' || (mode === 'auto' && touchCapable && coarse !== false));
  }

  onSettingChanged(k) {
    this.applySettings();
    if (!this.game) return;
    if (k === 'renderDistance' || k === 'quality') this.game.setRenderDistance(this.settings.get('renderDistance'));
    if (k === 'fancyLeaves' || k === 'quality') this.game.remeshAll();
  }

  // ---- Main loop ----------------------------------------------------------------------------

  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    let dt = (now - this.last) / 1000;
    const cap = this.settings.get('fpsCap');
    const minFrame = cap === '30' ? 1 / 31 : cap === '60' ? 1 / 61 : 0;
    if (dt < minFrame) return;
    this.last = now;
    dt = Math.min(dt, 0.1);
    this.fps = this.fps * 0.9 + (1 / Math.max(dt, 1e-3)) * 0.1;
    try {
      this.frame(dt);
    } catch (err) {
      log.error('Frame error', err);
      if (!this.reportedFrameError) {
        this.reportedFrameError = true;
        this.ui.toast(`Something went wrong: ${err.message}`, 'warn');
      }
    }
  }

  frame(dt) {
    const s = this.state;
    this.input.touchEl.classList.toggle('hidden', !(this.input.touchMode && s === 'playing'));
    if (s === 'menu') {
      this.menuBg?.update(dt);
      return;
    }
    if (!this.game) return;
    const g = this.game;
    if (s === 'loading') {
      if (!g.streamer) return; // init() still reading the save
      const done = g.updateLoading(dt);
      this.loadingEl?.setProgress(g.loadProgress());
      g.render(dt);
      if (done) this.enterPlaying();
      return;
    }
    const inp = this.input.frame();
    this.handleGlobalInput(inp);
    const paused = this.state === 'paused' || (this.state === 'sleeping');
    const blockGameplay = this.state !== 'playing';
    // While a menu is open the world keeps simulating (except when paused), but player input is ignored.
    const gameInput = blockGameplay ? { ...inp, moveX: 0, moveZ: 0, lookDX: 0, lookDY: 0, jump: false, jumpPressed: false, sneak: inp.sneak, mine: false, use: false, edges: new Set(), hotbar: null, scroll: 0 } : inp;
    const t0 = performance.now();
    g.update(dt, gameInput, { paused });
    g.postUpdate();
    this.ui.hud.update(g, dt);
    const t1 = performance.now();
    if (this.state === 'playing') this.tutorial.update(dt, inp, g);
    if (this.ui.inventory.isOpen) {
      this.ui.inventory.update();
      const v = g.player.inventory.version;
      if (v !== this.lastInvVersion) {
        this.lastInvVersion = v;
        this.ui.inventory.refresh();
      }
    }
    g.render(dt);
    // CPU cost split: simulation+UI vs. render submission (GPU work is not included).
    const t2 = performance.now();
    g.stats.updateMs = (g.stats.updateMs ?? 0) * 0.95 + (t1 - t0) * 0.05;
    g.stats.renderMs = (g.stats.renderMs ?? 0) * 0.95 + (t2 - t1) * 0.05;
    const needClick = this.state === 'playing' && !this.input.touchMode && !this.input.pointerLocked;
    this.clickToPlay.classList.toggle('hidden', !needClick);
  }

  handleGlobalInput(inp) {
    const e = inp.edges;
    if (e.has('debug')) this.settings.set('showDebug', !this.settings.get('showDebug'));
    if (this.state === 'playing') {
      if (e.has('inventory')) this.openInventory(this.game.creative ? 'creative' : 'inventory');
      else if (e.has('pause') || e.has('escape') || e.has('lockLost')) this.pause();
    } else if (this.state === 'inventory') {
      if (e.has('inventory') || e.has('escape')) this.closeInventory();
    } else if (this.state === 'paused' && e.has('escape')) this.resume();
  }

  // ---- Menus --------------------------------------------------------------------------------

  async listWorlds() {
    const raw = await this.storage.listWorlds().catch((err) => {
      log.error('Could not read worlds', err);
      return [];
    });
    const worlds = [], broken = [];
    for (const r of raw) {
      try {
        worlds.push(normalizeWorld(r));
      } catch (err) {
        broken.push({ id: r?.id, name: r?.name, error: err.message });
      }
    }
    return { worlds, broken };
  }

  async showMainMenu() {
    this.state = 'menu';
    this.ui.inGame = false;
    this.ui.hud.show(false);
    this.input.enabled = false;
    this.input.exitPointerLock();
    this.tutorial.hide();
    if (!this.menuBg) this.menuBg = new MenuBackground(this.renderer);
    const { worlds } = await this.listWorlds();
    const lastWorld = [...worlds].sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
    if (this.state === 'menu') this.ui.setScreen(mainMenu(this, { hasWorlds: worlds.length > 0, lastWorld }));
  }

  async showWorlds() {
    const { worlds, broken } = await this.listWorlds();
    this.ui.setScreen(worldsScreen(this, worlds, broken));
  }

  showCreateWorld() {
    this.ui.setScreen(createWorldScreen(this));
  }

  showSettings(context) {
    this.settingsContext = context;
    this.ui.setScreen(settingsScreen(this, context));
  }

  showCredits() {
    this.ui.setScreen(creditsScreen(this));
  }

  async createWorld(opts) {
    const rec = newWorldRecord({
      id: uid(), name: opts.name, seed: opts.seed, mode: opts.mode, difficulty: opts.difficulty, starterBonus: opts.starterBonus,
      rules: { dayLength: opts.dayLength, keepInventory: opts.keepInventory, mobSpawning: opts.mobSpawning, daylightCycle: opts.daylightCycle },
    });
    try {
      const { warnings, ...clean } = rec;
      void warnings;
      await this.storage.saveWorld(clean);
    } catch (err) {
      log.error('Could not create world', err);
      this.ui.toast('Could not create the world: storage is full or unavailable.', 'warn');
      return;
    }
    await this.playWorld(rec.id, rec);
  }

  async renameWorldDialog(w) {
    const name = await dialog({ title: 'Rename world', input: w.name, confirm: 'Rename' });
    if (!name) return;
    await this.storage.renameWorld(w.id, name).catch((err) => this.ui.toast(`Rename failed: ${err.message}`, 'warn'));
    this.showWorlds();
  }

  async duplicateWorld(w) {
    try {
      await this.storage.duplicateWorld(w.id, uid(), `${w.name} (copy)`.slice(0, 40));
      this.ui.toast('World copied');
    } catch (err) {
      this.ui.toast(`Copy failed: ${err.message}`, 'warn');
    }
    this.showWorlds();
  }

  async deleteWorldDialog(w) {
    const ok = await dialog({ title: 'Delete world?', message: `“${w.name || w.id}” will be permanently deleted. This cannot be undone.`, confirm: 'Delete', danger: true });
    if (!ok) return;
    await this.storage.deleteWorld(w.id).catch((err) => this.ui.toast(`Delete failed: ${err.message}`, 'warn'));
    this.showWorlds();
  }

  // ---- Playing ------------------------------------------------------------------------------

  async playWorld(id, recordHint = null) {
    let rec;
    try {
      rec = normalizeWorld(recordHint || (await this.storage.getWorld(id)));
    } catch (err) {
      log.error('World failed to load', err);
      await dialog({ title: 'World could not be loaded', message: err.message, confirm: 'OK', cancel: 'Back' });
      return this.showWorlds();
    }
    this.audio.unlock();
    this.menuBg?.dispose();
    this.menuBg = null;
    this.loadingEl = loadingScreen(`Loading ${rec.name}`);
    this.ui.setScreen(this.loadingEl);
    this.state = 'loading';
    const g = new Game(this, rec);
    this.game = g;
    try {
      await g.init();
    } catch (err) {
      log.error('World init failed', err);
      this.game = null;
      await dialog({ title: 'World could not be loaded', message: err.message, confirm: 'OK', cancel: 'Back' });
      return this.showMainMenu();
    }
  }

  /** Loading screen while moving between realms; the game flips to 'playing' when the arrival is ready. */
  beginTravel(title) {
    this.state = 'loading';
    this.input.releaseAll();
    this.input.enabled = false;
    this.input.exitPointerLock();
    this.ui.inventory.close();
    this.loadingEl = loadingScreen(title);
    this.ui.setScreen(this.loadingEl);
  }

  /** Travel aborted (save failed): back to the game where we were. */
  cancelTravel() {
    this.ui.clearScreen();
    this.loadingEl = null;
    this.state = 'playing';
    this.input.enabled = true;
    this.input.requestPointerLock(this.canvas);
  }

  enterPlaying() {
    this.ui.clearScreen();
    this.loadingEl = null;
    this.ui.inGame = true;
    this.ui.hud.show(true);
    this.state = this.game.player.dead ? 'dead' : 'playing';
    if (this.state === 'dead') {
      this.showDeath(this.game.deathMessage || 'You were defeated.', this.game.record.rules.keepInventory);
      return;
    }
    this.input.enabled = true;
    this.input.requestPointerLock(this.canvas);
    this.tutorial.render();
  }

  openInventory(mode, opts = {}) {
    if (!this.game || (this.state !== 'playing' && this.state !== 'inventory')) return;
    this.state = 'inventory';
    this.input.releaseAll();
    this.input.exitPointerLock();
    this.game.interaction.resetMining();
    this.ui.inventory.open(this.game.creative && mode === 'inventory' ? 'creative' : mode, opts);
    this.tutorial.event('inventory');
  }

  openContainer(type, st, pos) {
    this.openInventory(type, { container: st, pos });
  }

  closeInventory() {
    this.ui.inventory.close();
    if (this.state !== 'inventory') return;
    this.state = 'playing';
    this.input.releaseAll();
    this.input.requestPointerLock(this.canvas);
    this.audio.play('click');
  }

  pause() {
    if (!this.game || this.state === 'paused' || this.state === 'loading' || this.state === 'dead') return;
    if (this.state === 'inventory') this.ui.inventory.close();
    this.state = 'paused';
    this.input.releaseAll();
    this.input.exitPointerLock();
    this.tutorial.event('save');
    this.showPause();
  }

  showPause() {
    this.ui.setScreen(pauseScreen(this, this.game));
  }

  resume() {
    if (!this.game || this.state !== 'paused') return;
    this.ui.clearScreen();
    this.state = 'playing';
    this.input.releaseAll();
    this.input.requestPointerLock(this.canvas);
  }

  async saveNow() {
    const ok = await this.game?.save('manual');
    this.ui.toast(ok ? 'World saved' : 'Save failed', ok ? '' : 'warn');
  }

  captureThumbnail() {
    try {
      this.game.render(0);
      const c = document.createElement('canvas');
      c.width = 192;
      c.height = 108;
      c.getContext('2d').drawImage(this.canvas, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.72);
    } catch {
      return null;
    }
  }

  async quitToMenu() {
    const g = this.game;
    if (!g) return this.showMainMenu();
    this.ui.setScreen(loadingScreen('Saving…'));
    const thumb = g.ready ? this.captureThumbnail() : null;
    const ok = await g.save('quit', { thumbnail: thumb });
    if (!ok && g.ready) {
      const leave = await dialog({ title: 'Save failed', message: 'Your latest changes could not be saved. Leave anyway? (Your previous save is kept.)', confirm: 'Leave', cancel: 'Stay', danger: true });
      if (!leave) return this.showPause();
    }
    g.dispose();
    this.game = null;
    this.ui.inventory.close();
    await this.showMainMenu();
  }

  showDeath(message, keepInventory) {
    this.state = 'dead';
    this.input.releaseAll();
    this.input.enabled = false;
    this.input.exitPointerLock();
    this.ui.inventory.close();
    this.ui.setScreen(deathScreen(this, message, keepInventory));
  }

  respawn() {
    if (!this.game) return;
    if (this.game.respawn()) return; // changing realm: the travel loading screen takes over
    this.ui.clearScreen();
    this.state = 'playing';
    this.input.enabled = true;
    this.input.releaseAll();
    this.input.requestPointerLock(this.canvas);
  }

  sleep(done) {
    this.state = 'sleeping';
    this.input.releaseAll();
    this.ui.fade(true);
    setTimeout(() => {
      done();
      this.ui.fade(false);
      if (this.state === 'sleeping') this.state = 'playing';
    }, 1500);
  }

  exitApp() {
    window.AndroidHost?.exit?.();
  }

  /** Android back button. Returns true when handled inside the app. */
  onBack() {
    if (this.state === 'inventory') this.closeInventory();
    else if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
    else if (this.state === 'menu') {
      if (this.ui.screenEl?.classList.contains('menu-main')) {
        dialog({ title: 'Exit Blockwild?', confirm: 'Exit', cancel: 'Stay' }).then((ok) => ok && this.exitApp());
      } else this.showMainMenu();
    }
    return true;
  }

  installLifecycle() {
    const background = () => {
      if (this.game && (this.state === 'playing' || this.state === 'inventory')) this.pause();
      if (this.game) this.game.save('background');
      this.audio.suspend();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) background();
      else this.audio.resume();
    });
    window.addEventListener('pagehide', () => this.game?.save('pagehide'));
    window.__blockwildBack = () => this.onBack();
    window.__blockwildPause = background;
    window.addEventListener('error', (e) => log.error('Uncaught error', e.message));
    window.addEventListener('unhandledrejection', (e) => log.error('Unhandled rejection', e.reason?.message || String(e.reason)));
  }
}
