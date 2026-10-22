// Menu screens. Each builder returns a .screen element; UIManager swaps them in and out.
import { h, clear, fmtDuration, fmtDate } from './dom.js';
import { ICONS } from './svg.js';
import { iconURL } from '../rendering/icons.js';
import { GAME_TITLE, GAME_VERSION, SAVE_VERSION, DIFFICULTY } from '../config/constants.js';
import { SCHEMA } from '../game/settings.js';
import { DIM_LABEL } from '../world/dimensions.js';

const icon = (name) => h('span.ico', { html: ICONS[name] });

export function mainMenu(app, { hasWorlds, lastWorld }) {
  const play = h('button.btn.primary.wide', { on: { click: () => (lastWorld ? app.playWorld(lastWorld.id) : app.showCreateWorld()) } }, icon('play'), lastWorld ? `Continue “${lastWorld.name}”` : 'Play');
  const buttons = h('div.menu-buttons',
    play,
    h('button.btn', { on: { click: () => app.showWorlds() } }, 'Worlds'),
    h('button.btn', { on: { click: () => app.showCreateWorld() } }, icon('plus'), 'New World'),
    h('button.btn', { on: { click: () => app.showSettings('menu') } }, icon('gear'), 'Settings'),
    h('button.btn', { on: { click: () => app.showCredits() } }, 'Credits'),
    app.canExit ? h('button.btn.ghost.wide', { on: { click: () => app.exitApp() } }, 'Exit') : null,
  );
  void hasWorlds;
  return h('div.screen.menu-main',
    h('div.logo', h('img', { src: iconURL('grass'), alt: '' }), h('h1', GAME_TITLE.toUpperCase())),
    h('div.tagline', 'Explore · Gather · Build · Survive'),
    buttons,
    h('div.version-tag', `v${GAME_VERSION} · offline`),
  );
}

export function worldsScreen(app, worlds, broken) {
  const list = h('div.world-grid');
  const sorted = [...worlds].sort((a, b) => b.lastPlayed - a.lastPlayed);
  for (const w of sorted) {
    const thumb = h('div.world-thumb', w.thumbnail ? { style: { backgroundImage: `url(${w.thumbnail})` } } : {},
      h('div.badges', h(`span.badge.${w.mode}`, w.mode), h('span.badge', DIFFICULTY[w.difficulty].label)));
    list.appendChild(h('div.world-card',
      thumb,
      h('div.world-info',
        h('div.name', w.name),
        h('div.meta', `Seed ${w.seed}`, h('br'), `Played ${fmtDuration(w.playtime)} · last ${fmtDate(w.lastPlayed)} · save v${w.saveVersion}`)),
      h('div.world-actions',
        h('button.btn.primary', { on: { click: () => app.playWorld(w.id) } }, icon('play'), 'Play'),
        h('button.btn', { on: { click: () => app.renameWorldDialog(w) } }, 'Rename'),
        h('button.btn', { on: { click: () => app.duplicateWorld(w) } }, 'Copy'),
        h('button.btn.danger', { on: { click: () => app.deleteWorldDialog(w) } }, 'Delete')),
    ));
  }
  for (const b of broken) {
    list.appendChild(h('div.world-card',
      h('div.world-thumb', h('div.badges', h('span.badge.bad', 'Damaged'))),
      h('div.world-info', h('div.name', b.name || b.id), h('div.meta', `This save could not be read: ${b.error}`)),
      h('div.world-actions', h('button.btn.danger', { on: { click: () => app.deleteWorldDialog(b) } }, 'Delete'))));
  }
  const empty = !worlds.length && !broken.length
    ? h('div.empty', h('div.big', 'No worlds yet'), h('div', 'Create your first world to start exploring.'), h('div', { style: { marginTop: '14px' } }, h('button.btn.primary', { on: { click: () => app.showCreateWorld() } }, icon('plus'), 'Create World')))
    : null;
  return h('div.screen.solid',
    h('div.panel.worlds',
      h('div.panel-head', h('button.btn.icon-btn.ghost', { 'aria-label': 'Back', html: ICONS.back, on: { click: () => app.showMainMenu() } }), h('h2', 'Worlds'),
        h('button.btn.primary', { on: { click: () => app.showCreateWorld() } }, icon('plus'), 'New')),
      h('div.panel-body.scroll', empty || list)));
}

export function createWorldScreen(app) {
  const state = { name: `World ${Math.floor(Math.random() * 900 + 100)}`, seed: '', mode: 'survival', difficulty: 'normal', starterBonus: false, dayLength: 'normal', keepInventory: false, mobSpawning: true, daylightCycle: true };
  const seg = (key, options) => {
    const el = h('div.seg');
    const render = () => {
      clear(el);
      for (const [v, label] of options) el.appendChild(h(`button${state[key] === v ? '.on' : ''}`, { on: { click: () => { state[key] = v; render(); app.audio.play('click'); } } }, label));
    };
    render();
    return el;
  };
  const toggle = (key) => {
    const el = h(`button.toggle${state[key] ? '.on' : ''}`, { 'aria-label': key, on: { click: () => { state[key] = !state[key]; el.classList.toggle('on', state[key]); } } });
    return el;
  };
  const name = h('input.text-input', { value: state.name, maxLength: 40, on: { input: (e) => (state.name = e.target.value) } });
  const seed = h('input.text-input', { placeholder: 'Leave empty for a random seed', maxLength: 32, on: { input: (e) => (state.seed = e.target.value.trim()) } });
  const dice = h('button.btn', { on: { click: () => { state.seed = String(Math.floor(Math.random() * 2 ** 31)); seed.value = state.seed; } } }, 'Random');
  const create = () => {
    const finalSeed = state.seed || String(Math.floor(Math.random() * 2 ** 31));
    app.createWorld({ ...state, name: state.name.trim() || 'New World', seed: finalSeed });
  };
  return h('div.screen.solid',
    h('div.panel.form',
      h('div.panel-head', h('button.btn.icon-btn.ghost', { 'aria-label': 'Back', html: ICONS.back, on: { click: () => app.showMainMenu() } }), h('h2', 'Create World')),
      h('div.panel-body.scroll',
        h('label.field', h('span', 'World name'), name),
        h('label.field', h('span', 'Seed'), h('div.inline', seed, dice)),
        h('div.row', h('div.label', 'Game mode', h('span.hint', 'Creative: unlimited blocks, flight, no damage')), h('div.ctl', seg('mode', [['survival', 'Survival'], ['creative', 'Creative']]))),
        h('div.row', h('div.label', 'Difficulty', h('span.hint', 'Peaceful has no hostile creatures')), h('div.ctl', seg('difficulty', [['peaceful', 'Peaceful'], ['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']]))),
        h('div.row', h('div.label', 'Starter kit', h('span.hint', 'Begin with wooden tools, food and torches')), h('div.ctl', toggle('starterBonus'))),
        h('details.adv', h('summary', 'Advanced options'),
          h('div.row', h('div.label', 'Day length'), h('div.ctl', seg('dayLength', [['short', '10 min'], ['normal', '20 min'], ['long', '40 min']]))),
          h('div.row', h('div.label', 'Keep inventory on death'), h('div.ctl', toggle('keepInventory'))),
          h('div.row', h('div.label', 'Creature spawning'), h('div.ctl', toggle('mobSpawning'))),
          h('div.row', h('div.label', 'Day/night cycle'), h('div.ctl', toggle('daylightCycle'))))),
      h('div.panel-foot', h('button.btn', { on: { click: () => app.showMainMenu() } }, 'Cancel'), h('button.btn.primary', { on: { click: create } }, icon('play'), 'Create & Play'))));
}

/** Settings screen; `context` is 'menu' or 'pause' (only affects the back action). */
export function settingsScreen(app, context, tabName = 'graphics') {
  const s = app.settings;
  let tab = tabName;
  const body = h('div.panel-body.scroll');
  const slider = (key, label, hint, fmt = (v) => v, step = 0.05) => {
    const sc = SCHEMA[key];
    const val = h('span.val', fmt(s.get(key)));
    const input = h('input', { type: 'range', min: sc.min, max: sc.max, step, value: s.get(key), on: { input: (e) => { s.set(key, Number(e.target.value)); val.textContent = fmt(s.get(key)); } } });
    return h('div.row', h('div.label', label, hint ? h('span.hint', hint) : null), h('div.ctl', input, val));
  };
  const toggle = (key, label, hint) => {
    const el = h(`button.toggle${s.get(key) ? '.on' : ''}`, { 'aria-label': label, on: { click: () => { s.set(key, !s.get(key)); el.classList.toggle('on', s.get(key)); app.audio.play('click'); } } });
    return h('div.row', h('div.label', label, hint ? h('span.hint', hint) : null), h('div.ctl', el));
  };
  const seg = (key, label, options, hint, onPick) => {
    const el = h('div.seg');
    const render = () => {
      clear(el);
      for (const [v, l] of options) el.appendChild(h(`button${String(s.get(key)) === v ? '.on' : ''}`, { on: { click: () => { (onPick || ((x) => s.set(key, x)))(v); render(); app.audio.play('click'); } } }, l));
    };
    render();
    return h('div.row', h('div.label', label, hint ? h('span.hint', hint) : null), h('div.ctl', el));
  };
  const pct = (v) => `${Math.round(v * 100)}%`;
  const render = () => {
    clear(body);
    if (tab === 'graphics') {
      body.append(
        seg('quality', 'Quality preset', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], 'Sets the options below', (v) => { s.applyPreset(v); render(); }),
        slider('renderDistance', 'Render distance', 'Chunks of 16 blocks', (v) => `${v}`, 1),
        slider('resolution', 'Resolution scale', 'Lower is faster on older phones', pct, 0.05),
        slider('particles', 'Particles', null, pct),
        toggle('clouds', 'Clouds'),
        toggle('fancyLeaves', 'Detailed leaves', 'See-through foliage'),
        toggle('waterAnimation', 'Animated water & plants'),
        seg('fpsCap', 'Frame rate limit', [['30', '30'], ['60', '60'], ['unlimited', 'Max']], 'Lower saves battery and heat'),
        toggle('adaptiveQuality', 'Adaptive quality', 'Lowers render distance when frames get slow'),
        slider('fov', 'Field of view', null, (v) => `${Math.round(v)}°`, 1),
        slider('brightness', 'Brightness', 'Makes dark areas easier to see', pct),
      );
    } else if (tab === 'controls') {
      body.append(
        seg('controlsMode', 'Control scheme', [['auto', 'Auto'], ['touch', 'Touch'], ['keyboard', 'Keyboard']]),
        slider('lookSensitivity', 'Look sensitivity', null, (v) => v.toFixed(2)),
        toggle('invertY', 'Invert vertical look'),
        seg('sprintMode', 'Sprint button', [['toggle', 'Toggle'], ['hold', 'Hold']]),
        toggle('autoJump', 'Auto-jump', 'Hop up single blocks while walking'),
        slider('buttonSize', 'Button size', null, pct),
        slider('joystickSize', 'Joystick size', null, pct),
        slider('buttonOpacity', 'Button opacity', null, pct),
        toggle('leftHanded', 'Left-handed layout', 'Swap joystick and buttons'),
        toggle('vibration', 'Vibration'),
        h('div.row', h('div.label', 'Reset controls to default'), h('div.ctl', h('button.btn', { on: { click: () => { s.resetControls(); render(); } } }, 'Reset'))),
        h('div.row', h('div.label', 'Keyboard', h('span.hint', 'WASD move · Mouse look · Space jump · Shift sneak · Ctrl sprint · LMB mine · RMB use · E inventory · Q drop · 1-9 hotbar · F fly (creative) · F3 debug'))),
      );
    } else if (tab === 'audio') {
      body.append(
        toggle('muted', 'Mute all sound'),
        slider('masterVolume', 'Master volume', null, pct),
        slider('sfxVolume', 'Effects', null, pct),
        slider('ambientVolume', 'Ambience', 'Wind, rain, caves', pct),
        slider('musicVolume', 'Music', 'Occasional generative melodies', pct),
      );
    } else if (tab === 'interface') {
      body.append(
        slider('hudScale', 'HUD scale', null, pct),
        slider('textScale', 'Text size', null, pct),
        seg('crosshair', 'Crosshair', [['plus', 'Plus'], ['dot', 'Dot'], ['circle', 'Circle']]),
        toggle('reducedMotion', 'Reduced motion', 'No view bobbing, camera shake or swaying plants'),
        toggle('showCoords', 'Show coordinates', 'X Y Z and facing direction on screen (C key)'),
        toggle('showDebug', 'Show debug info', 'FPS, coordinates, biome, chunk stats'),
        h('div.row', h('div.label', 'Tutorial', h('span.hint', 'Show the step-by-step guide again')), h('div.ctl', h('button.btn', { on: { click: () => { app.tutorial.restart(); app.ui.toast('Tutorial will show in your next game'); } } }, 'Restart tutorial'))),
      );
    }
  };
  const tabs = h('div.tabs');
  const renderTabs = () => {
    clear(tabs);
    for (const [k, l] of [['graphics', 'Graphics'], ['controls', 'Controls'], ['audio', 'Audio'], ['interface', 'Interface']]) {
      tabs.appendChild(h(`button${tab === k ? '.on' : ''}`, { on: { click: () => { tab = k; renderTabs(); render(); } } }, l));
    }
  };
  renderTabs();
  render();
  const back = () => (context === 'pause' ? app.showPause() : app.showMainMenu());
  return h('div.screen.dim',
    h('div.panel.form',
      h('div.panel-head', h('button.btn.icon-btn.ghost', { 'aria-label': 'Back', html: ICONS.back, on: { click: back } }), h('h2', 'Settings'), tabs),
      body));
}

export function creditsScreen(app) {
  return h('div.screen.solid',
    h('div.panel.form.credits',
      h('div.panel-head', h('button.btn.icon-btn.ghost', { 'aria-label': 'Back', html: ICONS.back, on: { click: () => app.showMainMenu() } }), h('h2', 'Credits')),
      h('div.panel-body.scroll',
        h('p', `${GAME_TITLE} is an original voxel sandbox: every texture, creature, icon and sound is generated by the game's own code at startup.`),
        h('h3', 'Built with'),
        h('p', 'three.js (MIT license) for WebGL rendering. Simplex noise follows Stefan Gustavson\'s public-domain reference algorithm.'),
        h('h3', 'Privacy'),
        h('p', 'No accounts, ads, analytics or network access. Worlds and settings stay on this device.'),
        h('p', `Version ${GAME_VERSION} · save format v${SAVE_VERSION}`))));
}

export function pauseScreen(app, game) {
  const p = game.player;
  const creativeTools = game.creative
    ? h('div.inv-col',
      h('div.section-title', 'Creative tools'),
      h('div.inline', { style: { flexWrap: 'wrap' } },
        ...[['Dawn', 0.01], ['Noon', 0.25], ['Dusk', 0.47], ['Night', 0.75]].map(([l, t]) => h('button.btn', { on: { click: () => { game.record.time.tod = t; app.ui.toast(`Time set to ${l.toLowerCase()}`); } } }, l)),
        h('button.btn', { on: { click: () => { game.setWeather(game.record.weather.state === 'rain' ? 'clear' : 'rain'); app.ui.toast(`Weather: ${game.record.weather.state}`); } } }, h('span.ico', { html: ICONS.rain }), 'Toggle rain'),
        h('button.btn', { on: { click: () => { game.record.rules.daylightCycle = !game.record.rules.daylightCycle; app.ui.toast(game.record.rules.daylightCycle ? 'Time flows' : 'Time frozen'); } } }, 'Freeze time')))
    : null;
  return h('div.screen.dim',
    h('div.panel.dialog',
      h('div.panel-head', h('h2', 'Paused')),
      h('div.panel-body',
        h('div.pause-grid',
          h('button.btn.primary.wide', { on: { click: () => app.resume() } }, icon('play'), 'Resume'),
          h('button.btn', { on: { click: () => app.showSettings('pause') } }, icon('gear'), 'Settings'),
          h('button.btn', { on: { click: () => app.saveNow() } }, 'Save now'),
          h('button.btn.wide', { on: { click: (e) => { const on = !app.settings.get('showCoords'); app.settings.set('showCoords', on); e.currentTarget.textContent = `Coordinates: ${on ? 'on' : 'off'}`; } } }, `Coordinates: ${app.settings.get('showCoords') ? 'on' : 'off'}`),
          h('button.btn.wide', { on: { click: () => app.quitToMenu() } }, 'Save & quit to menu')),
        creativeTools ? h('div', { style: { marginTop: '12px' } }, creativeTools) : null,
        h('div.kv', { style: { marginTop: '12px' } },
          'World', h('b', game.record.name),
          'Realm', h('b', DIM_LABEL[game.dim]),
          'Mode', h('b', `${game.record.mode} · ${DIFFICULTY[game.record.difficulty].label}`),
          'Seed', h('b', game.record.seed),
          'Position', h('b', `${Math.floor(p.pos.x)}, ${Math.floor(p.pos.y)}, ${Math.floor(p.pos.z)}`),
          'Day', h('b', String(game.record.time.day + 1)),
          'Biome', h('b', game.currentBiome?.name ?? '')))));
}

export function deathScreen(app, message, keepInventory) {
  return h('div.screen.death',
    h('h1', 'You were defeated'),
    h('div.tip', message, h('br'), keepInventory ? 'Your items are safe (keep inventory).' : 'Your items were dropped where you fell; hurry back for them.'),
    h('div.inline', h('button.btn.primary', { on: { click: () => app.respawn() } }, 'Respawn'), h('button.btn', { on: { click: () => app.quitToMenu() } }, 'Quit to menu')));
}

const TIPS = [
  'Punch a tree to collect logs, then turn them into planks.',
  'A Workbench unlocks tools, chests, furnaces and more.',
  'Creatures that dislike light will not spawn near torches.',
  'Stone tools can mine copper and iron; you need iron for gold and gems.',
  'Sleep in a bedroll at night to skip to morning and set your respawn point.',
  'Hold Use with food selected to eat.',
  'Sneak at ledges to avoid falling while you build.',
  'Bone meal makes crops and saplings grow faster.',
  'Shimmering crystal geodes hide deep underground.',
];

export function loadingScreen(title) {
  const bar = h('i');
  const el = h('div.screen.solid.loading', h('h2', { style: { margin: 0 } }, title), h('div.progress', bar), h('div.tip', TIPS[Math.floor(Math.random() * TIPS.length)]));
  el.setProgress = (f) => (bar.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`);
  return el;
}

/** Generic confirm / prompt dialog. Resolves to true/false or the entered text (null = cancel). */
export function dialog({ title, message, confirm = 'OK', cancel = 'Cancel', danger = false, input = null }) {
  return new Promise((resolve) => {
    let field = null;
    if (input !== null) field = h('input.text-input', { value: input, maxLength: 40 });
    const done = (v) => {
      el.remove();
      resolve(v);
    };
    const el = h('div.screen.dim', { style: { zIndex: 20 } },
      h('div.panel.dialog',
        h('div.panel-head', h('h2', title)),
        h('div.panel-body', message ? h('p', { style: { margin: '0 0 10px', color: 'var(--muted)' } }, message) : null, field),
        h('div.panel-foot',
          h('button.btn', { on: { click: () => done(input !== null ? null : false) } }, cancel),
          h(`button.btn.${danger ? 'danger' : 'primary'}`, { on: { click: () => done(input !== null ? field.value.trim() : true) } }, confirm))));
    document.getElementById('ui').appendChild(el);
    field?.focus();
  });
}
