// Web Worker: generates chunk terrain off the main thread and transfers the typed arrays back.
import { makeGenerator } from './dimensions.js';

let gen = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    gen = makeGenerator(m.dim, m.seed);
  } else if (m.type === 'gen') {
    try {
      const r = gen.generateChunk(m.cx, m.cz);
      self.postMessage({ type: 'chunk', cx: m.cx, cz: m.cz, blocks: r.blocks, meta: r.meta, climate: r.climate }, [r.blocks.buffer, r.meta.buffer, r.climate.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', cx: m.cx, cz: m.cz, message: String(err && err.stack || err) });
    }
  }
};
