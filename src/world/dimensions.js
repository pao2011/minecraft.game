// Dimension registry: each dimension has its own seeded generator, sky and rules.
import { WorldGenerator } from './generator.js';
import { NetherGenerator } from './nether.js';
import { EndGenerator } from './end.js';

export const DIMS = ['overworld', 'nether', 'end'];
export const DIM_LABEL = { overworld: 'Overworld', nether: 'Cinder Realm', end: 'Void Isles' };

export function makeGenerator(dim, seed) {
  if (dim === 'nether') return new NetherGenerator(seed);
  if (dim === 'end') return new EndGenerator(seed);
  return new WorldGenerator(seed);
}
