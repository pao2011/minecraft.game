// Inline SVG icons for touch buttons and menus (original, stroke-based).
const wrap = (body) => `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  jump: wrap('<path d="M12 19V6"/><path d="M6 11l6-6 6 6"/>'),
  sneak: wrap('<path d="M6 9l6 6 6-6"/><path d="M5 19h14"/>'),
  sprint: wrap('<path d="M5 7l5 5-5 5"/><path d="M12 7l5 5-5 5"/>'),
  mine: wrap('<path d="M4 9c4-5 12-5 16 0"/><path d="M12 6v14"/>'),
  use: wrap('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5"/><path d="M12 12v9"/><path d="M12 12L4 7.5"/>'),
  swap: wrap('<path d="M5 8h13M14 4l4 4-4 4"/><path d="M19 16H6M10 12l-4 4 4 4"/>'),
  inventory: wrap('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>'),
  pause: wrap('<path d="M9 5v14"/><path d="M15 5v14"/>'),
  fly: wrap('<path d="M12 4c-4 3-6 7-6 12 3-1 5-3 6-6 1 3 3 5 6 6 0-5-2-9-6-12z"/>'),
  down: wrap('<path d="M12 5v13"/><path d="M6 13l6 6 6-6"/>'),
  close: wrap('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
  back: wrap('<path d="M15 6l-6 6 6 6"/>'),
  craft: wrap('<path d="M14 4l6 6-8 8H6v-6z"/><path d="M11 7l6 6"/>'),
  trash: wrap('<path d="M5 7h14"/><path d="M9 7V4h6v3"/><path d="M7 7l1 13h8l1-13"/>'),
  sun: wrap('<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>'),
  moon: wrap('<path d="M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z"/>'),
  rain: wrap('<path d="M7 15a4 4 0 0 1 0-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 17 15z"/><path d="M8 18l-1 2M12 18l-1 2M16 18l-1 2"/>'),
  gear: wrap('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
  play: wrap('<path d="M7 4l13 8-13 8z"/>'),
  plus: wrap('<path d="M12 5v14M5 12h14"/>'),
  drop: wrap('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
};
