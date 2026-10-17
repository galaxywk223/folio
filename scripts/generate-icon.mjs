import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const size = 512;
const png = new PNG({ width: size, height: size });

function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const idx = (size * y + x) << 2;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

function fillRect(x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPixel(x, y, ...color);
}

function fillRoundedRect(x0, y0, w, h, radius, color) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const dx = x < x0 + radius ? x0 + radius - x : x > x0 + w - radius - 1 ? x - (x0 + w - radius - 1) : 0;
      const dy = y < y0 + radius ? y0 + radius - y : y > y0 + h - radius - 1 ? y - (y0 + h - radius - 1) : 0;
      if (dx * dx + dy * dy <= radius * radius + radius) setPixel(x, y, ...color);
    }
  }
}

function strokeRoundedRect(x0, y0, w, h, radius, thickness, color) {
  for (let t = 0; t < thickness; t++) {
    fillRoundedRect(x0 + t, y0 + t, w - t * 2, h - t * 2, Math.max(1, radius - t), color);
  }
  fillRoundedRect(x0 + thickness, y0 + thickness, w - thickness * 2, h - thickness * 2, Math.max(1, radius - thickness), [0, 0, 0, 0]);
}

// Clear
for (let i = 0; i < size * size; i++) {
  const idx = i << 2;
  png.data[idx] = 0;
  png.data[idx + 1] = 0;
  png.data[idx + 2] = 0;
  png.data[idx + 3] = 0;
}

const ink = [28, 36, 48, 255];
const paper = [247, 248, 250, 255];
const accent = [59, 111, 156, 255];

fillRoundedRect(36, 36, 440, 440, 72, ink);
fillRoundedRect(92, 108, 140, 296, 28, paper);
fillRoundedRect(280, 108, 140, 296, 28, paper);
fillRect(118, 220, 88, 10, ink);
for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
  if (x * x + y * y <= 20) setPixel(350 + x, 256 + y, ...accent);
}

const out = path.join(__dirname, '../assets/icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
png.pack().pipe(fs.createWriteStream(out)).on('finish', () => {
  console.log('Wrote', out);
});
