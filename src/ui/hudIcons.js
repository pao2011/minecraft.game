// Pixel-art HUD icons (hearts, food, armor, air), drawn once into data URLs.
const SPRITES = {
  heart: ['.OO.OO.', 'OhhOhhO', 'OhwhhhO', 'OhhhhhO', '.OhhhO.', '..OhO..', '...O...'],
  food: ['....OO.', '...OhhO', '..OhwhO', '.OhhhO.', 'OhhhO..', 'OSO....', '.O.....'],
  armor: ['OO...OO', 'OhOOOhO', 'OhhhhhO', 'OhwhhhO', '.OhhhO.', '.OhhhO.', '..OOO..'],
  air: ['..OOO..', '.OwhhO.', 'OwhhhhO', 'OhhhhhO', 'OhhhhhO', '.OhhhO.', '..OOO..'],
};
const COLORS = {
  heart: { O: '#2a0a0a', h: '#e03c3c', w: '#ff9c8c' },
  food: { O: '#2a1606', h: '#c27a3a', w: '#efb07a', S: '#e8e0d0' },
  armor: { O: '#1c1f24', h: '#b9c1cc', w: '#eef2f6' },
  air: { O: '#0a1a33', h: '#5aa6ef', w: '#d6ecff' },
};
const EMPTY = { O: '#1b1d22', h: '#3a3d45', w: '#4a4e57', S: '#3a3d45' };

function draw(name, mode) {
  const c = document.createElement('canvas');
  c.width = c.height = 7;
  const g = c.getContext('2d');
  const rows = SPRITES[name];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      const full = mode === 'full' || (mode === 'half' && x < 4);
      g.fillStyle = (full ? COLORS[name] : EMPTY)[ch] || COLORS[name][ch];
      g.fillRect(x, y, 1, 1);
    }
  });
  return c.toDataURL();
}

const cache = {};
export function hudIcon(name, mode) {
  const k = `${name}:${mode}`;
  return (cache[k] ??= draw(name, mode));
}
