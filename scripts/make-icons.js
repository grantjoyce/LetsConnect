'use strict';

/**
 * Generates the PWA icon set as real PNGs, with no dependencies.
 *
 * A PWA needs actual PNGs - SVG icons in a manifest are not reliably honoured,
 * and iOS ignores them entirely for the home-screen icon. Rather than add a
 * native image dependency (which is exactly the sort of thing that breaks an
 * `npm install` on shared hosting), this draws the artwork mathematically and
 * writes the PNG bytes directly: zlib is in Node's standard library, and a PNG
 * is little more than a CRC and a deflate stream.
 *
 * Run once and commit the output:  npm run make-icons
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

const BG_TOP = [232, 62, 124]; // #E83E7C
const BG_BOTTOM = [120, 32, 84]; // #782054
const HEART = [255, 244, 249]; // #FFF4F9

// ---------------------------------------------------------------------------
// PNG writing
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** rgba: Buffer of size w*h*4 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Each scanline is prefixed with a filter byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

/**
 * The classic implicit heart: (x^2 + y^2 - 1)^3 - x^2 * y^3 <= 0.
 * Spans roughly x in [-1.2, 1.2] and y in [-1.35, 1.0].
 */
function insideHeart(x, y) {
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y <= 0;
}

function drawIcon(size, heartRatio) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;

  // The heart is 2.4 units wide and 2.35 tall, centred on y = -0.175.
  const radius = (size * heartRatio) / 2.4;
  const SS = 4; // 4x4 supersampling for clean edges

  for (let py = 0; py < size; py += 1) {
    const t = py / (size - 1);
    const bg = [
      Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
      Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
      Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
    ];

    for (let px = 0; px < size; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const fx = px + (sx + 0.5) / SS;
          const fy = py + (sy + 0.5) / SS;
          const u = (fx - cx) / radius;
          const v = (cy - fy) / radius - 0.175;
          if (insideHeart(u, v)) hits += 1;
        }
      }
      const cov = hits / (SS * SS);
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(bg[0] + (HEART[0] - bg[0]) * cov);
      rgba[i + 1] = Math.round(bg[1] + (HEART[1] - bg[1]) * cov);
      rgba[i + 2] = Math.round(bg[2] + (HEART[2] - bg[2]) * cov);
      rgba[i + 3] = 255;
    }
  }

  return encodePng(size, size, rgba);
}

// ---------------------------------------------------------------------------

const ICONS = [
  // Maskable icons get a smaller heart so nothing important sits outside the
  // 80% safe zone Android may crop to.
  { file: 'icon-192.png', size: 192, ratio: 0.56 },
  { file: 'icon-512.png', size: 512, ratio: 0.56 },
  { file: 'icon-maskable-512.png', size: 512, ratio: 0.44 },
  { file: 'apple-touch-icon.png', size: 180, ratio: 0.62 },
  { file: 'favicon-32.png', size: 32, ratio: 0.74 },
];

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const icon of ICONS) {
  const png = drawIcon(icon.size, icon.ratio);
  fs.writeFileSync(path.join(OUT_DIR, icon.file), png);
  console.log(`✓ ${icon.file}  ${icon.size}x${icon.size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log(`\n✅ ${ICONS.length} icons written to public/icons/`);
