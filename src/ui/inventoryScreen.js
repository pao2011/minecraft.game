// Inventory, crafting, creative catalog, chest and furnace screens.
// Touch model: tap = pick up / put down whole stack, long-press (or right-click) = split /
// place one, double-tap = quick transfer. A held "cursor" stack is shown in the info bar.
import { h, clear, bindTap } from './dom.js';
import { renderStack } from './hud.js';
import { ICONS } from './svg.js';
import { iconURL } from '../rendering/icons.js';
import { clickSlot, quickMove, Inventory } from '../items/inventory.js';
import { ITEMS, maxStack, ARMOR_SLOTS } from '../items/items.js';
import { RECIPES, recipesFor, ingredientStatus, maxCraftable, craft, SMELTING, SMELT_TIME, fuelValue } from '../items/recipes.js';

const CATEGORIES = [['all', 'All'], ['basics', 'Basics'], ['tools', 'Tools'], ['building', 'Building'], ['functional', 'Utility'], ['armor', 'Armor'], ['food', 'Food']];
const CREATIVE_TABS = [
  ['building', 'Build', (it) => it.kind === 'block' && ['building', 'decoration'].includes(it.category)],
  ['natural', 'Nature', (it) => it.kind === 'block' && ['natural', 'plants', 'wood'].includes(it.category)],
  ['ores', 'Ores', (it) => it.kind === 'block' && it.category === 'ores'],
  ['functional', 'Utility', (it) => it.kind === 'block' && it.category === 'functional'],
  ['tools', 'Tools', (it) => it.kind === 'tool' || it.kind === 'armor'],
  ['items', 'Items', (it) => it.kind === 'material' || it.kind === 'seed' || it.kind === 'food'],
];

function describe(id) {
  const it = ITEMS[id];
  if (!it) return '';
  const bits = [it.name];
  if (it.tool?.type && it.tool.tier) bits.push(`${it.tool.durability} uses`, `damage ${it.tool.damage}`);
  if (it.armor) bits.push(`+${it.armor.points} armor`);
  if (it.food) bits.push(`restores ${it.food.hunger} hunger`);
  if (it.fuel) bits.push(`fuel ${it.fuel}s`);
  if (SMELTING[id]) bits.push(`smelts into ${ITEMS[SMELTING[id]].name}`);
  if (it.plants !== undefined) bits.push('plant on tilled soil');
  return bits.join(' · ');
}

export class InventoryScreen {
  constructor(ui) {
    this.ui = ui;
    this.el = h('div.screen.dim.inv-screen.hidden');
    this.cursor = null;
    this.tab = 'inventory';
    this.category = 'all';
    this.creativeTab = 'building';
    this.selectedRecipe = null;
    this.lastCraft = 0;
    this.info = '';
  }

  get game() {
    return this.ui.app.game;
  }

  /** mode: 'inventory' | 'crafting' | 'creative' | 'chest' | 'furnace' */
  open(mode, opts = {}) {
    this.mode = mode;
    this.station = opts.station || (mode === 'crafting' ? 'workbench' : 'hand');
    this.container = opts.container || null;
    this.containerPos = opts.pos || null;
    this.tab = mode === 'chest' || mode === 'furnace' ? mode : mode === 'creative' ? 'creative' : mode === 'crafting' ? 'crafting' : 'inventory';
    if (this.container) this.containerInv = this.wrapContainer(this.container);
    this.info = '';
    this.build();
    this.el.classList.remove('hidden');
  }

  /** Expose container slots through an Inventory so the same click logic applies. */
  wrapContainer(st) {
    const inv = new Inventory(st.slots.length);
    inv.slots = st.slots;
    return inv;
  }

  close() {
    const g = this.game;
    if (this.cursor && g) {
      const left = g.player.inventory.add(this.cursor);
      if (left > 0) g.entities.spawnItem({ ...this.cursor, count: left }, { ...g.player.eye });
      this.cursor = null;
    }
    if (this.containerPos && g) {
      const c = g.world.chunkAtBlock(this.containerPos.x, this.containerPos.z);
      if (c) {
        c.modified = true;
        c.dirtySave = true;
      }
    }
    this.el.classList.add('hidden');
    clear(this.el);
    this.container = null;
    this.containerPos = null;
  }

  get isOpen() {
    return !this.el.classList.contains('hidden');
  }

  // ---- Building ------------------------------------------------------------------------------

  build() {
    clear(this.el);
    const g = this.game;
    const creative = g.creative;
    const titles = { chest: 'Chest', furnace: 'Furnace', crafting: 'Workbench' };
    const head = h('div.panel-head');
    if (titles[this.tab]) head.appendChild(h('h2', titles[this.tab]));
    else {
      const tabs = h('div.tabs');
      const tabList = [['inventory', 'Inventory']];
      if (creative) tabList.push(['creative', 'Creative']);
      for (const [k, label] of tabList) {
        tabs.appendChild(h(`button${this.tab === k ? '.on' : ''}`, { on: { click: () => { this.tab = k; this.ui.app.audio.play('click'); this.build(); } } }, label));
      }
      head.append(tabs, h('div', { style: { flex: '1' } }));
    }
    head.appendChild(h('button.btn.icon-btn.ghost', { 'aria-label': 'Close', html: ICONS.close, on: { click: () => this.ui.app.closeInventory() } }));
    const body = h('div.panel-body');
    const left = h('div.inv-col');
    const right = h('div.inv-col.grow');
    left.appendChild(this.buildPlayerInventory());
    left.appendChild(this.buildCursorBar());
    if (this.tab === 'chest') right.appendChild(this.buildContainerGrid());
    else if (this.tab === 'furnace') right.appendChild(this.buildFurnace());
    else if (this.tab === 'inventory' || this.tab === 'crafting') right.appendChild(this.buildCrafting());
    else if (this.tab === 'creative') right.appendChild(this.buildCreative());
    body.append(left);
    if (right.childElementCount) body.append(right);
    this.el.appendChild(h('div.panel.inv', head, body));
    this.refresh();
  }

  slot(inv, i, { extraClass = '', accepts = null, onDouble = null, readOnly = false, ghost = null } = {}) {
    const el = h(`div.slot${extraClass}`, ghost ? { 'data-ghost': ghost } : {});
    const act = (mode) => {
      if (readOnly && this.cursor) return;
      const before = this.cursor;
      this.cursor = clickSlot(inv, i, this.cursor, mode, accepts);
      if (before !== this.cursor || mode) this.ui.app.audio.play('click', { volume: 0.4 });
      const s = inv.get(i) || this.cursor;
      this.info = s ? describe(s.id) : '';
      this.refresh();
    };
    bindTap(el, {
      tap: () => act('all'),
      long: () => act('half'),
      double: onDouble ? () => {
        // The first tap of a double-tap already picked the stack up; put it back first.
        if (this.cursor && !inv.get(i)) {
          inv.set(i, this.cursor);
          this.cursor = null;
        }
        onDouble();
        this.refresh();
      } : null,
    });
    el._inv = inv;
    el._i = i;
    return el;
  }

  buildPlayerInventory() {
    const g = this.game;
    const p = g.player;
    const inv = p.inventory;
    const wrap = h('div.inv-col');
    const otherTarget = () => (this.containerInv && this.tab === 'chest' ? this.containerInv : null);
    const moveFrom = (i) => () => {
      if (this.tab === 'furnace') return this.quickToFurnace(i);
      const target = otherTarget();
      if (target) quickMove(inv, i, target);
      else {
        // Hotbar <-> backpack.
        const order = i < 9 ? [...Array(27).keys()].map((k) => k + 9) : [...Array(9).keys()];
        const it = ITEMS[inv.get(i)?.id];
        if (it?.armor && !p.armor.get(it.armor.slotIndex)) {
          p.armor.set(it.armor.slotIndex, inv.get(i));
          inv.set(i, null);
        } else quickMove(inv, i, inv, order);
      }
    };
    const row = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } });
    if (this.tab === 'inventory' && !g.creative) {
      const armorCol = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } });
      ARMOR_SLOTS.forEach((_, idx) => {
        armorCol.appendChild(this.slot(p.armor, idx, {
          extraClass: '.armor-slot', ghost: ['Head', 'Body', 'Legs', 'Feet'][idx],
          accepts: (s) => ITEMS[s.id]?.armor?.slotIndex === idx,
          onDouble: () => quickMove(p.armor, idx, inv),
        }));
      });
      row.appendChild(armorCol);
    }
    const grids = h('div.inv-col');
    grids.appendChild(h('div.section-title', 'Backpack'));
    const back = h('div.grid');
    for (let i = 9; i < 36; i++) back.appendChild(this.slot(inv, i, { onDouble: moveFrom(i) }));
    const hot = h('div.grid');
    for (let i = 0; i < 9; i++) hot.appendChild(this.slot(inv, i, { extraClass: `.hotbar-row${i === p.selected ? '.selected-slot' : ''}`, onDouble: moveFrom(i) }));
    grids.append(back, h('div.section-title', 'Hotbar'), hot);
    row.appendChild(grids);
    wrap.appendChild(row);
    return wrap;
  }

  buildContainerGrid() {
    const g = this.game;
    const wrap = h('div.inv-col', h('div.section-title', 'Chest'));
    const grid = h('div.grid');
    for (let i = 0; i < this.containerInv.size; i++) {
      grid.appendChild(this.slot(this.containerInv, i, { onDouble: () => quickMove(this.containerInv, i, g.player.inventory) }));
    }
    wrap.appendChild(grid);
    return wrap;
  }

  quickToFurnace(i) {
    const inv = this.game.player.inventory;
    const s = inv.get(i);
    if (!s) return;
    const target = SMELTING[s.id] ? 0 : fuelValue(s.id) ? 1 : -1;
    if (target < 0) return;
    const fInv = this.containerInv;
    const cur = fInv.get(target);
    if (!cur) {
      fInv.set(target, s);
      inv.set(i, null);
    } else if (cur.id === s.id) {
      const n = Math.min(s.count, maxStack(s.id) - cur.count);
      cur.count += n;
      s.count -= n;
      inv.set(i, s.count > 0 ? s : null);
    }
  }

  buildFurnace() {
    const fInv = this.containerInv;
    const g = this.game;
    this.flame = h('div.flame', h('i'));
    this.arrow = h('div.arrow', h('i'));
    const inSlot = this.slot(fInv, 0, { accepts: (s) => !!SMELTING[s.id], onDouble: () => quickMove(fInv, 0, g.player.inventory) });
    const fuelSlot = this.slot(fInv, 1, { accepts: (s) => fuelValue(s.id) > 0, onDouble: () => quickMove(fInv, 1, g.player.inventory) });
    const outSlot = this.slot(fInv, 2, { accepts: () => false, readOnly: true, onDouble: () => quickMove(fInv, 2, g.player.inventory) });
    return h('div.inv-col',
      h('div.section-title', 'Smelting'),
      h('div.furnace-ui', h('div.stack', inSlot, this.flame, fuelSlot), this.arrow, outSlot,
        h('div.info-line', { style: { maxWidth: '220px' } }, 'Put ore, sand or raw food on top and fuel (coal, wood) below.')),
    );
  }

  buildCursorBar() {
    const g = this.game;
    this.cursorEl = h('div.cursor-stack.hidden', h('div.slot'), h('span'));
    this.infoEl = h('div.info-line');
    const dropBtn = h('button.btn', { on: { click: () => this.dropCursor() } }, h('span.ico', { html: g.creative ? ICONS.trash : ICONS.drop }), g.creative ? 'Trash' : 'Drop');
    this.dropBtn = dropBtn;
    return h('div.inv-col', h('div.cursor-bar', this.cursorEl, dropBtn), this.infoEl);
  }

  dropCursor() {
    const g = this.game;
    if (!this.cursor) {
      this.info = g.creative ? 'Pick up a stack, then tap Trash to delete it.' : 'Pick up a stack, then tap Drop to throw it.';
      this.refresh();
      return;
    }
    if (!g.creative) {
      const p = g.player;
      const dir = p.lookDir();
      g.entities.spawnItem(this.cursor, { x: p.pos.x + dir.x, y: p.pos.y + 1.3, z: p.pos.z + dir.z }, { x: dir.x * 4, y: 2, z: dir.z * 4 }, 1.5);
    }
    this.cursor = null;
    this.ui.app.audio.play('click');
    this.refresh();
  }

  // ---- Crafting ----------------------------------------------------------------------------

  buildCrafting() {
    const wrap = h('div.recipes');
    const chips = h('div.chips');
    for (const [k, label] of CATEGORIES) {
      chips.appendChild(h(`button.chip${this.category === k ? '.on' : ''}`, { on: { click: () => { this.category = k; this.build(); } } }, label));
    }
    this.recipeList = h('div.recipe-list');
    this.recipeDetail = h('div.recipe-detail');
    wrap.append(h('div.section-title', this.station === 'workbench' ? 'Workbench recipes' : 'Hand crafting · a Workbench unlocks more'), chips, this.recipeList, this.recipeDetail);
    this.renderRecipes();
    return wrap;
  }

  renderRecipes() {
    if (!this.recipeList) return;
    const inv = this.game.player.inventory;
    const usable = new Set(recipesFor(this.station));
    const list = RECIPES.filter((r) => this.category === 'all' || r.category === this.category);
    // Craftable first, then usable at this station, then locked.
    const score = (r) => (usable.has(r) ? (maxCraftable(inv, r) > 0 ? 0 : 1) : 2);
    list.sort((a, b) => score(a) - score(b));
    clear(this.recipeList);
    for (const r of list) {
      const can = usable.has(r) && maxCraftable(inv, r) > 0;
      const el = h(`div.recipe${can ? '.can' : ''}${usable.has(r) ? '' : '.locked'}${this.selectedRecipe === r ? '.sel' : ''}`, { title: ITEMS[r.out.id].name },
        h('div.item-ico', { style: { backgroundImage: `url(${iconURL(r.out.id)})` } }),
        r.out.count > 1 ? h('span.count', r.out.count) : null);
      el.addEventListener('click', () => {
        this.selectedRecipe = r;
        this.ui.app.audio.play('click', { volume: 0.4 });
        this.renderRecipes();
      });
      this.recipeList.appendChild(el);
    }
    if (!this.selectedRecipe || !list.includes(this.selectedRecipe)) this.selectedRecipe = list.find((r) => usable.has(r) && maxCraftable(inv, r) > 0) || list[0] || null;
    this.renderRecipeDetail(usable);
  }

  renderRecipeDetail(usable) {
    const d = clear(this.recipeDetail);
    const r = this.selectedRecipe;
    if (!r) return;
    const inv = this.game.player.inventory;
    const status = ingredientStatus(inv, r);
    const n = maxCraftable(inv, r);
    const stationOk = usable.has(r);
    d.appendChild(h('div.title', h('div.item-ico', { style: { backgroundImage: `url(${iconURL(r.out.id)})`, width: '28px', height: '28px' } }), `${ITEMS[r.out.id].name}${r.out.count > 1 ? ` ×${r.out.count}` : ''}`));
    const ings = h('div.ings');
    for (const s of status) {
      const showId = s.ids.find((id) => inv.count(id) > 0) || s.ids[0];
      const label = s.tag ? `any ${s.tag.replace('_', ' ')}` : ITEMS[s.id].name;
      ings.appendChild(h(`div.ing${s.ok ? '' : '.miss'}`, h('div.item-ico', { style: { backgroundImage: `url(${iconURL(showId)})` } }), `${Math.min(s.have, s.need)}/${s.need} ${label}`));
    }
    d.appendChild(ings);
    const reason = !stationOk ? 'Requires a Workbench' : n === 0 ? `Missing: ${status.filter((s) => !s.ok).map((s) => `${s.need - s.have}× ${s.tag ? s.tag : ITEMS[s.id].name}`).join(', ')}` : '';
    const craftBtn = h('button.btn.primary', { disabled: !stationOk || n === 0, on: { click: () => this.doCraft(r, 1) } }, h('span.ico', { html: ICONS.craft }), 'Craft');
    const allBtn = h('button.btn', { disabled: !stationOk || n < 2, on: { click: () => this.doCraft(r, n) } }, `Craft ×${Math.max(1, n)}`);
    d.appendChild(h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, craftBtn, allBtn, reason ? h('span.info-line', reason) : null));
  }

  doCraft(r, times) {
    // Ignore bursts of repeated taps; crafting itself is transactional anyway.
    const now = performance.now();
    if (now - this.lastCraft < 150) return;
    this.lastCraft = now;
    const inv = this.game.player.inventory;
    const res = craft(inv, r, times);
    if (res.ok) {
      this.ui.app.audio.play('craft');
      this.info = `Crafted ${r.out.count * times}× ${ITEMS[r.out.id].name}`;
      this.ui.app.tutorial?.event('craft', r.out.id);
    } else {
      this.ui.app.audio.play('deny');
      this.info = res.reason;
    }
    this.refresh();
  }

  // ---- Creative catalog --------------------------------------------------------------------

  buildCreative() {
    const wrap = h('div.recipes');
    const chips = h('div.chips');
    for (const [k, label] of CREATIVE_TABS) {
      chips.appendChild(h(`button.chip${this.creativeTab === k ? '.on' : ''}`, { on: { click: () => { this.creativeTab = k; this.build(); } } }, label));
    }
    const list = h('div.recipe-list');
    const filter = CREATIVE_TABS.find((t) => t[0] === this.creativeTab)[2];
    for (const [key, it] of Object.entries(ITEMS)) {
      if (!filter(it)) continue;
      if (it.kind === 'block' && it.block !== undefined && key === 'totem') continue;
      const el = h('div.recipe.can', { title: it.name }, h('div.item-ico', { style: { backgroundImage: `url(${iconURL(key)})` } }));
      bindTap(el, {
        tap: () => {
          this.cursor = { id: key, count: maxStack(key) };
          this.info = `${it.name} · unlimited in Creative`;
          this.refresh();
        },
        long: () => {
          // Long-press sends a full stack straight to the hotbar slot that is selected.
          const p = this.game.player;
          p.inventory.set(p.selected, { id: key, count: maxStack(key) });
          this.info = `${it.name} → hotbar slot ${p.selected + 1}`;
          this.refresh();
        },
      });
      list.appendChild(el);
    }
    wrap.append(h('div.creative-note', 'Creative: tap to pick up a full stack, long-press to put it in your selected hotbar slot. Blocks are never used up.'), chips, list);
    return wrap;
  }

  // ---- Refresh ------------------------------------------------------------------------------

  refresh() {
    if (!this.isOpen && !this.el.childElementCount) return;
    for (const el of this.el.querySelectorAll('.slot')) if (el._inv) renderStack(el, el._inv.get(el._i));
    if (this.cursorEl) {
      this.cursorEl.classList.toggle('hidden', !this.cursor);
      if (this.cursor) {
        renderStack(this.cursorEl.firstChild, this.cursor);
        this.cursorEl.lastChild.textContent = `Holding ${this.cursor.count}× ${ITEMS[this.cursor.id].name} — tap a slot to place`;
      }
    }
    if (this.infoEl) this.infoEl.textContent = this.info || (this.cursor ? '' : 'Tap: move stack · Hold: split / place one · Double-tap: quick move');
    if (this.recipeList) this.renderRecipes();
  }

  /** Per-frame update while open (furnace progress, live container changes). */
  update() {
    if (this.tab === 'furnace' && this.container) {
      const st = this.container;
      const burn = st.burnMax ? st.burn / st.burnMax : 0;
      this.flame.firstChild.style.height = `${burn * 100}%`;
      this.arrow.firstChild.style.width = `${(st.progress / SMELT_TIME) * 100}%`;
      for (const el of this.el.querySelectorAll('.slot')) if (el._inv) renderStack(el, el._inv.get(el._i));
    }
  }
}
