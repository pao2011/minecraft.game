// Slot-based inventories with stacking, splitting and transfer. Stacks are plain objects
// { id, count, damage? } so they serialize directly.
import { maxStack, isValidItem } from './items.js';

export const cloneStack = (s) => (s ? { ...s } : null);
export const stackable = (a, b) => !!a && !!b && a.id === b.id && !a.damage && !b.damage && maxStack(a.id) > 1;

export class Inventory {
  constructor(size) {
    this.slots = new Array(size).fill(null);
    this.version = 0; // bumped on every change so UIs can refresh cheaply
  }

  get size() {
    return this.slots.length;
  }

  get(i) {
    return this.slots[i];
  }

  set(i, stack) {
    this.slots[i] = stack && stack.count > 0 ? stack : null;
    this.version++;
  }

  /**
   * Add a stack, merging into matching stacks first, then empty slots in `order`.
   * Returns the count that did not fit (0 = everything added). Never destroys items.
   */
  add(stack, order = null) {
    if (!stack || stack.count <= 0) return 0;
    let left = stack.count;
    const idx = order || this.slots.map((_, i) => i);
    const max = maxStack(stack.id);
    for (const i of idx) {
      const s = this.slots[i];
      if (left > 0 && stackable(s, stack) && s.count < max) {
        const n = Math.min(left, max - s.count);
        s.count += n;
        left -= n;
      }
    }
    for (const i of idx) {
      if (left <= 0) break;
      if (!this.slots[i]) {
        const n = Math.min(left, max);
        this.slots[i] = { ...stack, count: n };
        left -= n;
      }
    }
    if (left !== stack.count) this.version++;
    return left;
  }

  /** How many of this stack could be added. */
  spaceFor(stack) {
    const max = maxStack(stack.id);
    let space = 0;
    for (const s of this.slots) {
      if (!s) space += max;
      else if (stackable(s, stack)) space += max - s.count;
    }
    return space;
  }

  count(id) {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  /** Remove up to `count` items of an id. Returns the number removed. */
  remove(id, count) {
    let left = count;
    for (let i = this.slots.length - 1; i >= 0 && left > 0; i--) {
      const s = this.slots[i];
      if (!s || s.id !== id) continue;
      const n = Math.min(left, s.count);
      s.count -= n;
      left -= n;
      if (s.count <= 0) this.slots[i] = null;
    }
    if (left !== count) this.version++;
    return count - left;
  }

  /** Decrement the stack in slot i by n. */
  consume(i, n = 1) {
    const s = this.slots[i];
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.slots[i] = null;
    this.version++;
  }

  clear() {
    this.slots.fill(null);
    this.version++;
  }

  snapshot() {
    return this.slots.map(cloneStack);
  }

  restore(slots) {
    this.slots = slots.map(cloneStack);
    this.version++;
  }

  toJSON() {
    return this.slots.map((s) => (s ? { id: s.id, count: s.count, ...(s.damage ? { damage: s.damage } : {}) } : null));
  }

  /** Load from saved data, dropping invalid entries instead of failing. */
  static fromJSON(data, size) {
    const inv = new Inventory(size);
    if (!Array.isArray(data)) return inv;
    for (let i = 0; i < Math.min(size, data.length); i++) {
      const s = data[i];
      if (!s || !isValidItem(s.id)) continue;
      const count = Math.floor(Number(s.count));
      if (!(count > 0)) continue;
      inv.slots[i] = { id: s.id, count: Math.min(count, maxStack(s.id)) };
      const dmg = Math.floor(Number(s.damage));
      if (dmg > 0) inv.slots[i].damage = dmg;
    }
    return inv;
  }
}

/**
 * Tap/click interaction between a cursor stack and a slot.
 * mode: 'all' (primary tap), 'half' (pick half / place one), returns the new cursor.
 * `accepts(stack)` optionally restricts what the slot can hold (armor, furnace output...).
 */
export function clickSlot(inv, i, cursor, mode = 'all', accepts = null) {
  const s = inv.get(i);
  if (!cursor) {
    if (!s) return null;
    if (mode === 'half' && s.count > 1) {
      const take = Math.ceil(s.count / 2);
      const picked = { ...s, count: take };
      s.count -= take;
      inv.set(i, s);
      return picked;
    }
    inv.set(i, null);
    return s;
  }
  if (accepts && !accepts(cursor)) return cursor;
  if (!s) {
    if (mode === 'half') {
      inv.set(i, { ...cursor, count: 1 });
      cursor.count -= 1;
      return cursor.count > 0 ? cursor : null;
    }
    const max = maxStack(cursor.id);
    if (cursor.count <= max) {
      inv.set(i, cursor);
      return null;
    }
    inv.set(i, { ...cursor, count: max });
    cursor.count -= max;
    return cursor;
  }
  if (stackable(s, cursor)) {
    const max = maxStack(s.id);
    const n = Math.min(mode === 'half' ? 1 : cursor.count, max - s.count);
    s.count += n;
    cursor.count -= n;
    inv.set(i, s);
    return cursor.count > 0 ? cursor : null;
  }
  // Different items: swap.
  inv.set(i, cursor);
  return s;
}

/** Move the stack in `from[i]` into `to` (merge first). Leftovers stay in place. */
export function quickMove(from, i, to, order = null) {
  const s = from.get(i);
  if (!s) return false;
  const left = to.add({ ...s }, order);
  if (left === s.count) return false;
  if (left > 0) {
    s.count = left;
    from.set(i, s);
  } else from.set(i, null);
  return true;
}
