// Generates icons/icon-{16,32,48,128}.png (no dependencies). Run: node tools/make-icons.mjs
// Design: indigo rounded square with a white "day line" and a marker dot on it.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(out, { recursive: true });

const SS = 4; // supersampling factor for smooth edges

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in unit coordinates (0..1)
const inRoundRect = (x, y, r) => {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return dx * dx + dy * dy <= r * r;
};
const inCapsule = (x, y, x0, x1, cy, half) => {
  const cx = Math.min(Math.max(x, x0), x1);
  return (x - cx) ** 2 + (y - cy) ** 2 <= half * half;
};
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function sample(x, y) {
  if (!inRoundRect(x, y, 0.22)) return null;
  const t = (x + y) / 2;
  const base = [79 + (124 - 79) * t, 70 + (58 - 70) * t, 229 + (237 - 229) * t]; // indigo -> violet
  const white = [255, 255, 255];
  // "now" marker on a timeline that fades out into the future
  if (inCircle(x, y, 0.34, 0.5, 0.13)) return white;
  if (inCapsule(x, y, 0.16, 0.84, 0.5, 0.05)) {
    const k = x <= 0.34 ? 1 : Math.max(0.25, 0.75 - (x - 0.34));
    return base.map((c, i) => white[i] * k + c * (1 - k));
  }
  return base;
}

for (const size of [16, 32, 48, 128]) {
  const data = png(size, (px, py) => {
    let r = 0, g = 0, b = 0, hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
        if (!c) continue;
        r += c[0]; g += c[1]; b += c[2]; hits++;
      }
    }
    if (!hits) return [0, 0, 0, 0];
    return [Math.round(r / hits), Math.round(g / hits), Math.round(b / hits), Math.round((hits / (SS * SS)) * 255)];
  });
  writeFileSync(join(out, `icon-${size}.png`), data);
}
console.log('icons written to', out);
