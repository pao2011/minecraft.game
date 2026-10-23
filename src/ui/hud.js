// In-game heads-up display: hotbar, vitals, crosshair, toasts, pickups, debug overlay.
import { h, clear } from './dom.js';
import { hudIcon } from './hudIcons.js';
import { iconURL } from '../rendering/icons.js';
import { ITEMS, maxDurability } from '../items/items.js';
import { BLOCKS } from '../world/blocks.js';
import { PLAYER } from '../config/constants.js';

/** Render a stack (icon, count, durability bar) into a slot element. */
export function renderStack(el, stack) {
  const key = stack ? `${stack.id}|${stack.count}|${stack.damage || 0}` : '';
  if (el._key === key) return;
  el._key = key;
  clear(el);
  if (!stack) return;
  el.appendChild(h('div.item-ico', { style: { backgroundImage: `url(${iconURL(stack.id)})` } }));
  if (stack.count > 1) el.appendChild(h('span.count', stack.count));
  const max = maxDurability(stack.id);
  if (max && stack.damage) {
    const f = Math.max(0, 1 - stack.damage / max);
    el.appendChild(h('div.dura', h('i', { style: { width: `${f * 100}%`, background: `hsl(${f * 110}, 80%, 50%)` } })));
  }
}

export class HUD {
  constructor(ui) {
    this.ui = ui;
    this.el = h('div.hud.hidden');
    this.crosshair = h('div.crosshair.plus');
    this.eatRing = h('div.eat-ring.hidden', { html: '<svg viewBox="0 0 46 46"><circle cx="23" cy="23" r="19" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="4"/><circle class="arc" cx="23" cy="23" r="19" fill="none" stroke="#f2b84b" stroke-width="4" stroke-dasharray="119.4" stroke-dashoffset="119.4" transform="rotate(-90 23 23)"/></svg>' });
    this.damage = h('div.damage-flash');
    this.water = h('div.water-tint');
    this.toasts = h('div.toasts');
    this.pickups = h('div.pickups');
    this.debug = h('div.debug.hidden');
    this.saving = h('div.saving', 'Saving…');
    this.heldName = h('div.held-name');
    this.healthBar = h('div.bar');
    this.foodBar = h('div.bar.right');
    this.armorBar = h('div.bar');
    this.airBar = h('div.bar.right');
    this.hotbar = h('div.hotbar');
    this.offSlot = h('div.hslot.off', { title: 'Offhand: tap to swap with the selected slot' });
    this.offSlot.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.ui.app.game?.swapHands();
    });
    this.hotbar.append(this.offSlot, h('div.off-sep'));
    this.coords = h('div.coords.hidden');
    this.bossBar = h('div.bossbar.hidden', h('div.name', 'Void Drake'), h('div.track', h('i')));
    this.portal = h('div.portal-tint');
    this.zone = h('div.zone-title');
    this.hslots = [];
    for (let i = 0; i < 9; i++) {
      const s = h('div.hslot', { 'data-slot': i });
      s.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.ui.app.game?.selectSlot(i);
      });
      this.hslots.push(s);
      this.hotbar.appendChild(s);
    }
    this.statsEl = h('div.stats', this.healthBar, this.foodBar);
    this.subEl = h('div.subbar', this.armorBar, this.airBar);
    this.el.append(
      this.water, this.damage, this.crosshair, this.eatRing, this.toasts, this.pickups, this.debug, this.saving, this.heldName, this.coords, this.bossBar, this.portal, this.zone,
      h('div.hotbar-wrap', this.subEl, this.statsEl, this.hotbar),
    );
    this.last = {};
    this.heldTimer = 0;
  }

  show(on) {
    this.el.classList.toggle('hidden', !on);
  }

  setCrosshair(style) {
    this.crosshair.className = `crosshair ${style}`;
  }

  bar(el, kind, value, max, cacheKey) {
    if (this.last[cacheKey] === value) return;
    this.last[cacheKey] = value;
    clear(el);
    const n = max / 2;
    for (let i = 0; i < n; i++) {
      const v = value - i * 2;
      el.appendChild(h('img', { src: hudIcon(kind, v >= 2 ? 'full' : v >= 1 ? 'half' : 'empty'), alt: '' }));
    }
  }

  update(game, dt) {
    const p = game.player;
    const creative = game.creative;
    this.statsEl.classList.toggle('hidden', creative);
    this.subEl.classList.toggle('hidden', creative);
    if (!creative) {
      this.bar(this.healthBar, 'heart', Math.ceil(p.health), PLAYER.maxHealth, 'hp');
      this.bar(this.foodBar, 'food', Math.ceil(p.hunger), PLAYER.maxHunger, 'food');
      const armor = p.armorPoints;
      if (armor > 0) this.bar(this.armorBar, 'armor', armor, 20, 'armor');
      else if (this.last.armor !== 0) {
        clear(this.armorBar);
        this.last.armor = 0;
      }
      const air = p.headInWater || p.air < 10 ? Math.ceil(p.air * 2) : -1;
      if (air >= 0) this.bar(this.airBar, 'air', air, 20, 'air');
      else if (this.last.air !== -1) {
        clear(this.airBar);
        this.last.air = -1;
      }
    }
    for (let i = 0; i < 9; i++) {
      renderStack(this.hslots[i], p.inventory.get(i));
      this.hslots[i].classList.toggle('sel', i === p.selected);
    }
    // Held item name fades in on change.
    const held = p.heldStack;
    const name = held ? ITEMS[held.id]?.name : '';
    if (name !== this.last.heldName) {
      this.last.heldName = name;
      this.heldName.textContent = name || '';
      this.heldTimer = name ? 1.6 : 0;
    }
    this.heldTimer -= dt;
    this.heldName.classList.toggle('show', this.heldTimer > 0);
    const eating = game.interaction.eating || (game.interaction.drawing && { t: (game.interaction.drawing.t * 1.2) / 0.9 });
    this.eatRing.classList.toggle('hidden', !eating);
    if (eating) this.eatRing.querySelector('.arc').setAttribute('stroke-dashoffset', String(119.4 * (1 - Math.min(1, eating.t / 1.2))));
    renderStack(this.offSlot, p.offhand.get(0));
    this.offSlot.classList.toggle('guard', !!(p.sneaking && p.offhand.get(0) && ITEMS[p.offhand.get(0).id]?.shield));
    const boss = game.entities.boss;
    this.bossBar.classList.toggle('hidden', !boss);
    if (boss) this.bossBar.querySelector('i').style.width = `${Math.max(0, (boss.health / boss.def.health) * 100)}%`;
    if (this.coordsOn) {
      this.coordsTimer = ((this.coordsTimer || 0) + 1) % 4;
      if (this.coordsTimer === 0) {
        const x = Math.floor(p.pos.x), y = Math.floor(p.pos.y), z = Math.floor(p.pos.z);
        const dir = ['N', 'E', 'S', 'W'][game.interaction.facingIndex()];
        const other = game.dim === 'nether' ? `  ·  Overworld ≈ ${x * 8}, ${z * 8}` : '';
        this.coords.textContent = `X ${x}   Y ${y}   Z ${z}   ${dir}${other}`;
      }
    }
    this.water.classList.toggle('on', p.headInWater);
    if (!this.debug.classList.contains('hidden')) this.updateDebug(game);
  }

  updateDebug(game) {
    this.debugTimer = (this.debugTimer || 0) - 1;
    if (this.debugTimer > 0) return;
    this.debugTimer = 10;
    const p = game.player;
    const x = Math.floor(p.pos.x), y = Math.floor(p.pos.y), z = Math.floor(p.pos.z);
    const [sky, blk] = game.world.getLight(x, y, z);
    const t = game.interaction.target;
    const targetText = t?.kind === 'block' ? `${BLOCKS[t.hit.id].key} @ ${t.hit.x},${t.hit.y},${t.hit.z}` : t?.kind === 'mob' ? `${t.mob.type} (${t.mob.health.toFixed(1)} hp, ${t.mob.state})` : '-';
    const fps = this.ui.app.fps;
    const facing = ['north (-Z)', 'east (+X)', 'south (+Z)', 'west (-X)'][game.interaction.facingIndex()];
    const tod = game.record.time.tod;
    const hours = Math.floor(((tod * 24 + 6) % 24));
    const mem = performance.memory ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} MB` : 'n/a';
    this.debug.textContent = [
      `Blockwild  ${fps.toFixed(0)} fps  (${(game.stats.avgFrameMs ?? 0).toFixed(1)} ms avg)  cpu update ${(game.stats.updateMs ?? 0).toFixed(1)} ms, render ${(game.stats.renderMs ?? 0).toFixed(1)} ms`,
      `XYZ ${p.pos.x.toFixed(2)} ${p.pos.y.toFixed(2)} ${p.pos.z.toFixed(2)}`,
      `Chunk ${Math.floor(x / 16)}, ${Math.floor(z / 16)}  local ${((x % 16) + 16) % 16} ${y} ${((z % 16) + 16) % 16}`,
      `Facing ${facing}`,
      `Biome ${game.currentBiome?.name ?? '?'}`,
      `Light sky ${sky} block ${blk}`,
      `Target ${targetText}`,
      `Chunks ${game.world.chunks.size}  mesh queue ${game.meshQueue.size}  mesh ${game.stats.meshMs.toFixed(2)} ms`,
      `Render distance ${game.renderDistance} (setting ${game.settings.get('renderDistance')})`,
      `Entities ${game.entities.mobs.length} mobs, ${game.entities.items.length} items`,
      `Day ${game.record.time.day}  ${String(hours).padStart(2, '0')}:00  weather ${game.record.weather.state}`,
      `Seed ${game.record.seed}  JS heap ${mem}`,
      `Last save ${game.lastSaveOk ? 'ok' : 'FAILED'} ${(game.stats.lastSaveMs ?? 0).toFixed(1)} ms`,
    ].join('\n');
  }

  /** Big fading place name (biome or realm) near the top of the screen. */
  showZone(name, sub = '') {
    this.zone.replaceChildren(h('div.zname', name), sub ? h('div.zsub', sub) : '');
    this.zone.classList.remove('on');
    void this.zone.offsetWidth; // restart the animation
    this.zone.classList.add('on');
  }

  toggleCoords(on) {
    this.coordsOn = !!on;
    this.coords.classList.toggle('hidden', !on);
  }

  /** Purple vignette that grows while standing in a portal (0..1). */
  setPortal(f) {
    this.portal.style.opacity = String(f * 0.85);
  }

  toggleDebug(on) {
    this.debug.classList.toggle('hidden', on === undefined ? !this.debug.classList.contains('hidden') : !on);
  }

  flashDamage() {
    this.damage.classList.add('on');
    requestAnimationFrame(() => requestAnimationFrame(() => this.damage.classList.remove('on')));
  }

  flashPickup(id, n) {
    const last = this.pickups.lastElementChild;
    if (last && last.dataset.id === id && performance.now() - Number(last.dataset.t) < 1200) {
      last.dataset.n = String(Number(last.dataset.n) + n);
      last.querySelector('span').textContent = `+${last.dataset.n} ${ITEMS[id].name}`;
      last.dataset.t = String(performance.now());
      return;
    }
    const el = h('div.pickup', { 'data-id': id, 'data-n': String(n), 'data-t': String(performance.now()) }, h('div.item-ico', { style: { backgroundImage: `url(${iconURL(id)})` } }), h('span', `+${n} ${ITEMS[id].name}`));
    this.pickups.appendChild(el);
    while (this.pickups.children.length > 4) this.pickups.firstElementChild.remove();
    setTimeout(() => el.remove(), 2200);
  }

  toast(msg, kind = '') {
    for (const t of this.toasts.children) {
      if (t.textContent === msg) return; // no duplicate spam
    }
    const el = h(`div.toast${kind ? `.${kind}` : ''}`, msg);
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild.remove();
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3100);
  }

  setSaving(on) {
    this.saving.classList.toggle('on', on);
  }
}
