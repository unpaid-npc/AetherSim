import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(__dirname, "..", "build");
fs.mkdirSync(buildDir, { recursive: true });

// CRC32 helper for valid PNG chunks
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * (width * 4 + 1);
    raw[rowOff] = 0; // filter type 0
    rgba.copy(raw, rowOff + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

function blendPixel(buf, size, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return;
  const idx = (y * size + x) * 4;
  const srcA = Math.min(1, Math.max(0, a));
  const dstA = buf[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 1e-6) return;
  buf[idx] = Math.round((r * srcA + buf[idx] * dstA * (1 - srcA)) / outA);
  buf[idx + 1] = Math.round((g * srcA + buf[idx + 1] * dstA * (1 - srcA)) / outA);
  buf[idx + 2] = Math.round((b * srcA + buf[idx + 2] * dstA * (1 - srcA)) / outA);
  buf[idx + 3] = Math.round(outA * 255);
}

/**
 * Renders original geometric AetherSim aerospace badge (rounded deep-space tile,
 * cyan orbital arc, stainless Starship silhouette, and Mach-diamond plume) at `size x size`.
 */
function renderIconRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  const half = size * 0.5;
  const cornerR = size * 0.22;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const nx = (px + 0.5) / size; // 0..1
      const ny = (py + 0.5) / size; // 0..1

      // Rounded-rect SDF
      const dx = Math.max(0, Math.abs(px + 0.5 - half) - (half - cornerR - size * 0.04));
      const dy = Math.max(0, Math.abs(py + 0.5 - half) - (half - cornerR - size * 0.04));
      const sdf = Math.hypot(dx, dy) - cornerR;
      if (sdf > 1.5) continue;
      const mask = Math.min(1, Math.max(0, 0.5 - sdf * 0.65));

      // Midnight space gradient background
      const radial = Math.hypot(nx - 0.5, ny - 0.42);
      const bgR = 8 + (1 - Math.min(1, radial)) * 14;
      const bgG = 14 + (1 - Math.min(1, radial)) * 28;
      const bgB = 28 + (1 - Math.min(1, radial)) * 54;
      blendPixel(buf, size, px, py, bgR, bgG, bgB, mask);

      // Subtle border glow
      if (sdf > -size * 0.025) {
        blendPixel(buf, size, px, py, 56, 189, 248, mask * 0.55);
      }

      // Tilted cyan orbital trajectory ring
      const rx = (nx - 0.5) * Math.cos(-0.45) - (ny - 0.52) * Math.sin(-0.45);
      const ry = (nx - 0.5) * Math.sin(-0.45) + (ny - 0.52) * Math.cos(-0.45);
      const ellDist = Math.abs(Math.hypot(rx / 0.36, ry / 0.14) - 1.0);
      if (ellDist < 0.08 && !(nx > 0.42 && nx < 0.58 && ny > 0.24 && ny < 0.62)) {
        const ringAlpha = (1 - ellDist / 0.08) * 0.72 * mask;
        blendPixel(buf, size, px, py, 56, 189, 248, ringAlpha);
      }

      // Mach-diamond exhaust plume below aft skirt (ny in 0.60..0.88)
      if (ny >= 0.60 && ny <= 0.88) {
        const t = (ny - 0.60) / 0.28;
        const plumeHalfW = 0.045 * (1 - t * 0.75);
        const ax = Math.abs(nx - 0.5);
        if (ax < plumeHalfW) {
          const core = 1 - ax / plumeHalfW;
          const diamond = 0.65 + 0.35 * Math.pow(Math.max(0, Math.sin(t * Math.PI * 3.5)), 2);
          const plumeA = (1 - t) * core * diamond * mask;
          blendPixel(buf, size, px, py, 145, 225, 255, plumeA);
          blendPixel(buf, size, px, py, 255, 195, 110, plumeA * 0.45 * t);
        }
      }

      // Starship fuselage & ogive nosecone (ny in 0.16..0.61)
      if (ny >= 0.16 && ny <= 0.61) {
        const bodyNormY = (ny - 0.16) / 0.45; // 0 nose tip -> 1 skirt
        const halfW =
          bodyNormY < 0.36
            ? 0.062 * Math.pow(Math.sin((bodyNormY / 0.36) * Math.PI * 0.5), 0.72)
            : 0.062;
        const dxShip = nx - 0.5;
        if (Math.abs(dxShip) <= halfW) {
          // Left windward dark TPS tiles vs right brushed stainless steel
          if (dxShip < -halfW * 0.08) {
            blendPixel(buf, size, px, py, 32, 41, 56, mask);
          } else {
            const shade = 215 + (1 - Math.abs(dxShip / Math.max(0.001, halfW))) * 35;
            blendPixel(buf, size, px, py, shade, shade + 4, 255, mask);
          }
        }
      }

      // Aft & Forward aerodynamic flaps
      const absX = Math.abs(nx - 0.5);
      if (ny >= 0.24 && ny <= 0.33 && absX >= 0.045 && absX <= 0.10) {
        const taper = (ny - 0.24) / 0.09;
        if (absX <= 0.05 + taper * 0.05) {
          blendPixel(buf, size, px, py, 148, 178, 214, mask * 0.95);
        }
      }
      if (ny >= 0.48 && ny <= 0.60 && absX >= 0.055 && absX <= 0.13) {
        const taper = (ny - 0.48) / 0.12;
        if (absX <= 0.06 + taper * 0.07) {
          blendPixel(buf, size, px, py, 168, 196, 228, mask * 0.95);
        }
      }
    }
  }
  return buf;
}

function buildIcoFromPngs(pngEntries) {
  const count = pngEntries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(count * 16);
  let offset = 6 + count * 16;
  const chunks = [header, dir];

  for (let i = 0; i < count; i++) {
    const { size, png } = pngEntries[i];
    const eOff = i * 16;
    dir[eOff] = size >= 256 ? 0 : size;
    dir[eOff + 1] = size >= 256 ? 0 : size;
    dir[eOff + 2] = 0;
    dir[eOff + 3] = 0;
    dir.writeUInt16LE(1, eOff + 4);
    dir.writeUInt16LE(32, eOff + 6);
    dir.writeUInt32LE(png.length, eOff + 8);
    dir.writeUInt32LE(offset, eOff + 12);
    offset += png.length;
    chunks.push(png);
  }
  return Buffer.concat(chunks);
}

const png512 = encodePng(512, 512, renderIconRgba(512));
fs.writeFileSync(path.join(buildDir, "icon.png"), png512);

const icoSizes = [256, 64, 32, 16];
const icoEntries = icoSizes.map((s) => ({
  size: s,
  png: encodePng(s, s, renderIconRgba(s)),
}));
fs.writeFileSync(path.join(buildDir, "icon.ico"), buildIcoFromPngs(icoEntries));

console.log(
  `Generated build/icon.png (${png512.length} bytes) and build/icon.ico (${icoSizes.join(", ")} px)`
);
