// Tiny DOM builder: h('div.class#id', {attrs, on: {click}}, ...children)
export function h(sel, props = {}, ...children) {
  if (props === null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  const [tag, ...rest] = sel.split(/(?=[.#])/);
  const el = document.createElement(tag || 'div');
  for (const part of rest) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else if (part[0] === '#') el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

/** Pointer handler distinguishing tap, long-press and double-tap (touch and mouse). */
export function bindTap(el, { tap, long, double, right }) {
  let timer = null, longFired = false, lastTap = 0, startX = 0, startY = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    longFired = false;
    startX = e.clientX;
    startY = e.clientY;
    if (long) {
      timer = setTimeout(() => {
        longFired = true;
        long(e);
      }, 420);
    }
  });
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  el.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 12) cancel();
  });
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerup', (e) => {
    if (e.button === 2) return;
    const wasLong = longFired;
    cancel();
    if (wasLong) return;
    const now = performance.now();
    if (double && now - lastTap < 320) {
      lastTap = 0;
      double(e);
      return;
    }
    lastTap = now;
    tap?.(e);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    (right || long)?.(e);
  });
}

export function fmtDuration(sec) {
  const s = Math.floor(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtDate(ms) {
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}
