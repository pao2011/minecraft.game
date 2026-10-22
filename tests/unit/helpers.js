import { World } from '../../src/world/world.js';
import { Chunk } from '../../src/world/chunk.js';
import { B } from '../../src/world/blocks.js';
import { localIndex } from '../../src/world/coords.js';

/** A world of flat stone up to `ground` (inclusive) over chunks in [-r, r]^2. */
export function flatWorld(r = 1, ground = 10) {
  const w = new World('test');
  for (let cx = -r; cx <= r; cx++) {
    for (let cz = -r; cz <= r; cz++) {
      const c = new Chunk(cx, cz);
      for (let y = 0; y <= ground; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) c.blocks[localIndex(x, y, z)] = y === 0 ? B.bedrock : B.stone;
      w.addChunk(c);
    }
  }
  w.takeDirtySections();
  return w;
}
