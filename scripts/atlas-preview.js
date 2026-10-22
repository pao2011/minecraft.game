// Dev tool: writes the procedural block atlas to build/atlas.png (scaled) for visual review.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildAtlasPixels } from '../src/rendering/textures.js';

export function encodePNG(pixels, w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pixels, width, height } = buildAtlasPixels();
  const scale = 4;
  const W = width * scale, H = height * scale;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 4;
      const di = (y * W + x) * 4;
      const checker = ((x >> 3) + (y >> 3)) % 2 ? 90 : 60;
      const a = pixels[si + 3] / 255;
      // Show tint-masked pixels in a sample green so the preview matches the game.
      const tint = pixels[si + 3] > 150 && pixels[si + 3] < 230 ? [0.55, 0.75, 0.38] : [1, 1, 1];
      for (let k = 0; k < 3; k++) out[di + k] = pixels[si + k] * tint[k] * (a > 0 ? 1 : 0) + checker * (a > 0 ? 0 : 1);
      out[di + 3] = 255;
    }
  }
  mkdirSync('build', { recursive: true });
  writeFileSync('build/atlas.png', encodePNG(out, W, H));
  console.log(`wrote build/atlas.png ${W}x${H}`);
}
