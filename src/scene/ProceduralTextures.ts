import * as THREE from "three";
import type { PlanetConfig } from "../config/planets";
import { SeededNoise2D, smoothstep } from "../utils/noise";

export interface PbrTextureSet {
  readonly albedoMap: THREE.DataTexture;
  readonly normalMap: THREE.DataTexture;
  readonly roughnessMap: THREE.DataTexture;
}

const TEXTURE_SIZE = 512;

function parseHexRgb(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [
    Math.round(c.r * 255),
    Math.round(c.g * 255),
    Math.round(c.b * 255),
  ];
}

function mixRgb(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number
): [number, number, number] {
  const k = Math.max(0, Math.min(1, t));
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

function configureRepeatTexture(
  data: Uint8Array,
  size: number,
  colorSpace: THREE.ColorSpace,
  repeat: number,
  anisotropy: number
): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = Math.min(8, Math.max(1, anisotropy));
  tex.needsUpdate = true;
  return tex;
}

function buildNormalBuffer(
  heightField: Float32Array,
  size: number,
  strength: number
): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const idx = (x: number, y: number): number => {
    const wx = ((x % size) + size) % size;
    const wy = ((y % size) + size) % size;
    return wy * size + wx;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = heightField[idx(x - 1, y - 1)];
      const t = heightField[idx(x, y - 1)];
      const tr = heightField[idx(x + 1, y - 1)];
      const l = heightField[idx(x - 1, y)];
      const r = heightField[idx(x + 1, y)];
      const bl = heightField[idx(x - 1, y + 1)];
      const b = heightField[idx(x, y + 1)];
      const br = heightField[idx(x + 1, y + 1)];

      const dx = (tr + 2 * r + br - (tl + 2 * l + bl)) * strength;
      const dy = (bl + 2 * b + br - (tl + 2 * t + tr)) * strength;
      let nx = -dx;
      let ny = -dy;
      let nz = 1.0;
      const invLen = 1 / Math.hypot(nx, ny, nz);
      nx *= invLen;
      ny *= invLen;
      nz *= invLen;

      const off = (y * size + x) * 4;
      out[off] = Math.round((nx * 0.5 + 0.5) * 255);
      out[off + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[off + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[off + 3] = 255;
    }
  }
  return out;
}

/** Sample seamless-ish 2D noise using toroidal 4-corner blend over [0, period]. */
function sampleTileableFbm(
  noise: SeededNoise2D,
  u: number,
  v: number,
  scale: number,
  octaves: number
): number {
  const nx0 = u * scale;
  const ny0 = v * scale;
  const nx1 = (u - 1) * scale;
  const ny1 = (v - 1) * scale;
  const wx = smoothstep(0.0, 1.0, u);
  const wy = smoothstep(0.0, 1.0, v);

  const n00 = noise.fbm(nx0, ny0, octaves);
  const n10 = noise.fbm(nx1, ny0, octaves);
  const n01 = noise.fbm(nx0, ny1, octaves);
  const n11 = noise.fbm(nx1, ny1, octaves);

  const a = n00 * (1 - wx) + n10 * wx;
  const b = n01 * (1 - wx) + n11 * wx;
  return a * (1 - wy) + b * wy;
}

export function generatePlanetTextureSet(
  config: PlanetConfig,
  maxAnisotropy: number
): PbrTextureSet {
  const size = TEXTURE_SIZE;
  const nPixels = size * size;
  const albedo = new Uint8Array(nPixels * 4);
  const roughness = new Uint8Array(nPixels * 4);
  const heights = new Float32Array(nPixels);

  const noise = new SeededNoise2D(config.terrain.seed + 17);
  const microNoise = new SeededNoise2D(config.terrain.seed + 503);

  const cPrimary = parseHexRgb(config.terrain.soilPalette[0]);
  const cSecondary = parseHexRgb(config.terrain.soilPalette[1]);
  const cDark = parseHexRgb(config.terrain.soilPalette[2]);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const macro = sampleTileableFbm(noise, u, v, 5.0, 4) * 0.5 + 0.5;
      const detail = sampleTileableFbm(microNoise, u, v, 14.0, 3) * 0.5 + 0.5;

      let heightVal = macro * 0.68 + detail * 0.32;
      let rgb: [number, number, number];
      let roughVal = config.terrain.baseRoughness;

      if (config.id === "mars") {
        // Oxidized iron-oxide dust, stratified rock bands, and dark basalt patches
        const strata = Math.sin((u * 1.4 + macro * 0.9) * Math.PI * 6) * 0.5 + 0.5;
        const basaltMask = smoothstep(0.62, 0.78, detail * 0.6 + macro * 0.4);
        rgb = mixRgb(cPrimary, cSecondary, strata * 0.75 + macro * 0.25);
        rgb = mixRgb(rgb, cDark, basaltMask * 0.85);
        heightVal += strata * 0.14 - basaltMask * 0.12;
        roughVal = Math.max(0.68, Math.min(0.98, 0.92 - basaltMask * 0.16 + (detail - 0.5) * 0.12));
      } else if (config.id === "earth") {
        // Coastal sandy soil blended with scrubland/grass patches
        const grassMask = smoothstep(0.42, 0.68, macro * 0.72 + detail * 0.28);
        const dampPatch = smoothstep(0.65, 0.84, detail);
        rgb = mixRgb(cPrimary, cSecondary, grassMask);
        rgb = mixRgb(rgb, cDark, dampPatch * 0.45);
        heightVal = macro * 0.55 + detail * 0.45;
        roughVal = Math.max(0.62, Math.min(0.96, 0.88 - dampPatch * 0.14 + (detail - 0.5) * 0.1));
      } else {
        // Moon: silicate regolith with sharp micro-craters and bright ejecta
        const microCrater = microNoise.craterField(u * 256, v * 256, 48);
        const mareMask = smoothstep(0.5, 0.76, macro);
        rgb = mixRgb(cPrimary, cSecondary, smoothstep(0.45, 0.85, detail + Math.max(0, microCrater)));
        rgb = mixRgb(rgb, cDark, mareMask * 0.65);
        heightVal += microCrater * 0.48;
        roughVal = Math.max(0.78, Math.min(0.99, 0.95 - mareMask * 0.06 + (detail - 0.5) * 0.08));
      }

      const i = y * size + x;
      heights[i] = heightVal;
      const off = i * 4;
      albedo[off] = Math.max(0, Math.min(255, Math.round(rgb[0])));
      albedo[off + 1] = Math.max(0, Math.min(255, Math.round(rgb[1])));
      albedo[off + 2] = Math.max(0, Math.min(255, Math.round(rgb[2])));
      albedo[off + 3] = 255;

      const rByte = Math.max(0, Math.min(255, Math.round(roughVal * 255)));
      roughness[off] = rByte;
      roughness[off + 1] = rByte;
      roughness[off + 2] = rByte;
      roughness[off + 3] = 255;
    }
  }

  const normalStrength = config.id === "moon" ? 3.2 : config.id === "mars" ? 2.6 : 2.0;
  const normals = buildNormalBuffer(heights, size, normalStrength);

  return {
    albedoMap: configureRepeatTexture(albedo, size, THREE.SRGBColorSpace, 24, maxAnisotropy),
    normalMap: configureRepeatTexture(normals, size, THREE.NoColorSpace, 24, maxAnisotropy),
    roughnessMap: configureRepeatTexture(roughness, size, THREE.NoColorSpace, 24, maxAnisotropy),
  };
}

export function generatePadConcreteTextureSet(
  config: PlanetConfig,
  maxAnisotropy: number
): PbrTextureSet {
  const size = 256;
  const nPixels = size * size;
  const albedo = new Uint8Array(nPixels * 4);
  const roughness = new Uint8Array(nPixels * 4);
  const heights = new Float32Array(nPixels);

  const noise = new SeededNoise2D(config.terrain.seed + 911);
  const base = parseHexRgb(config.terrain.padConcreteTint);
  const dust = parseHexRgb(config.terrain.dustColor);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const grit = sampleTileableFbm(noise, u, v, 12.0, 3) * 0.5 + 0.5;
      const seamX = Math.abs(((u * 8) % 1) - 0.5) > 0.475 ? 1 : 0;
      const seamY = Math.abs(((v * 8) % 1) - 0.5) > 0.475 ? 1 : 0;
      const seam = Math.max(seamX, seamY);

      let rgb = mixRgb(base, dust, grit * 0.22);
      if (seam > 0) {
        rgb = [rgb[0] * 0.72, rgb[1] * 0.72, rgb[2] * 0.72];
      }

      const i = y * size + x;
      heights[i] = grit * 0.5 - seam * 0.35;
      const off = i * 4;
      albedo[off] = Math.max(0, Math.min(255, Math.round(rgb[0])));
      albedo[off + 1] = Math.max(0, Math.min(255, Math.round(rgb[1])));
      albedo[off + 2] = Math.max(0, Math.min(255, Math.round(rgb[2])));
      albedo[off + 3] = 255;

      const roughByte = Math.round((0.76 + grit * 0.16) * 255);
      roughness[off] = roughByte;
      roughness[off + 1] = roughByte;
      roughness[off + 2] = roughByte;
      roughness[off + 3] = 255;
    }
  }

  const normals = buildNormalBuffer(heights, size, 1.8);
  return {
    albedoMap: configureRepeatTexture(albedo, size, THREE.SRGBColorSpace, 6, maxAnisotropy),
    normalMap: configureRepeatTexture(normals, size, THREE.NoColorSpace, 6, maxAnisotropy),
    roughnessMap: configureRepeatTexture(roughness, size, THREE.NoColorSpace, 6, maxAnisotropy),
  };
}

export function disposeTextureSet(set: PbrTextureSet | null): void {
  if (!set) {
    return;
  }
  set.albedoMap.dispose();
  set.normalMap.dispose();
  set.roughnessMap.dispose();
}

let cachedHeatShield: PbrTextureSet | null = null;
let cachedStainless: PbrTextureSet | null = null;
let cachedCryoFrost: THREE.DataTexture | null = null;

/** Cached 512x512 hexagonal ceramic TPS heat-shield PBR maps for Starship's windward side. */
export function getHeatShieldTextureSet(maxAnisotropy: number): PbrTextureSet {
  if (cachedHeatShield) {
    return cachedHeatShield;
  }
  const size = 512;
  const nPixels = size * size;
  const albedo = new Uint8Array(nPixels * 4);
  const roughness = new Uint8Array(nPixels * 4);
  const heights = new Float32Array(nPixels);
  const tileNoise = new SeededNoise2D(11881);

  const cols = 16;
  const hexW = size / cols;
  const hexH = hexW * 0.8660254;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const row = Math.floor(y / hexH);
      const colShift = (row & 1) * (hexW * 0.5);
      const lx = ((x + colShift) % hexW) / hexW - 0.5;
      const ly = (y % hexH) / hexH - 0.5;

      // Approximate hex distance for staggered hexagonal tile seams
      const ax = Math.abs(lx);
      const ay = Math.abs(ly);
      const hexDist = Math.max(ax * 1.0, (ax * 0.5 + ay * 0.866) * 1.06);
      const seam = smoothstep(0.42, 0.495, hexDist);

      const tileIdX = Math.floor((x + colShift) / hexW);
      const tileJitter =
        tileNoise.noise2D(tileIdX * 1.37 + 3.1, row * 1.91 - 2.4) * 0.5 + 0.5;
      const micro = tileNoise.noise2D(x * 0.09, y * 0.09) * 0.5 + 0.5;

      const baseTone = 24 + tileJitter * 12 + micro * 5;
      const shade = baseTone * (1 - seam * 0.62);
      const roughVal = Math.max(0.65, Math.min(0.96, 0.78 + tileJitter * 0.14 - seam * 0.08));

      const i = y * size + x;
      heights[i] = (1 - seam) * (0.55 + tileJitter * 0.18 + micro * 0.08);
      const off = i * 4;
      const byteVal = Math.max(6, Math.min(255, Math.round(shade)));
      albedo[off] = byteVal;
      albedo[off + 1] = Math.min(255, byteVal + 2);
      albedo[off + 2] = Math.min(255, byteVal + 5);
      albedo[off + 3] = 255;

      const roughByte = Math.round(roughVal * 255);
      roughness[off] = roughByte;
      roughness[off + 1] = roughByte;
      roughness[off + 2] = roughByte;
      roughness[off + 3] = 255;
    }
  }

  const normals = buildNormalBuffer(heights, size, 2.8);
  cachedHeatShield = {
    albedoMap: configureRepeatTexture(albedo, size, THREE.SRGBColorSpace, 4, maxAnisotropy),
    normalMap: configureRepeatTexture(normals, size, THREE.NoColorSpace, 4, maxAnisotropy),
    roughnessMap: configureRepeatTexture(roughness, size, THREE.NoColorSpace, 4, maxAnisotropy),
  };
  cachedHeatShield.albedoMap.repeat.set(3, 6);
  cachedHeatShield.normalMap.repeat.set(3, 6);
  cachedHeatShield.roughnessMap.repeat.set(3, 6);
  return cachedHeatShield;
}

/** Cached 512x512 brushed 304L stainless steel PBR maps with weld-seam ring bands. */
export function getStainlessSteelTextureSet(maxAnisotropy: number): PbrTextureSet {
  if (cachedStainless) {
    return cachedStainless;
  }
  const size = 512;
  const nPixels = size * size;
  const albedo = new Uint8Array(nPixels * 4);
  const roughness = new Uint8Array(nPixels * 4);
  const heights = new Float32Array(nPixels);
  const noise = new SeededNoise2D(30419);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    // Circumferential barrel weld seams every 1/8 height
    const ringDist = Math.abs(((v * 8) % 1) - 0.5);
    const weldSeam = smoothstep(0.46, 0.5, ringDist);
    const ringVariation = noise.noise2D(1.5, Math.floor(v * 8) * 2.13) * 0.5 + 0.5;

    for (let x = 0; x < size; x++) {
      const u = x / size;
      // Anisotropic horizontal brushed metal streaks + subtle smudge blotches
      const brush = sampleTileableFbm(noise, u, v, 36.0, 2) * 0.5 + 0.5;
      const streak = noise.noise2D(u * 6.0, v * 120.0) * 0.5 + 0.5;
      const smudge = sampleTileableFbm(noise, u, v, 4.5, 3) * 0.5 + 0.5;

      const baseLum =
        188 + ringVariation * 22 + streak * 16 - smudge * 18 - weldSeam * 34;
      const roughVal = Math.max(
        0.13,
        Math.min(0.44, 0.2 + smudge * 0.14 + (1 - streak) * 0.06 + weldSeam * 0.15)
      );

      const i = y * size + x;
      heights[i] = brush * 0.25 + streak * 0.2 - weldSeam * 0.45;
      const off = i * 4;
      const lum = Math.max(40, Math.min(242, Math.round(baseLum)));
      albedo[off] = lum;
      albedo[off + 1] = Math.min(246, lum + 3);
      albedo[off + 2] = Math.min(252, lum + 7);
      albedo[off + 3] = 255;

      const roughByte = Math.round(roughVal * 255);
      roughness[off] = roughByte;
      roughness[off + 1] = roughByte;
      roughness[off + 2] = roughByte;
      roughness[off + 3] = 255;
    }
  }

  const normals = buildNormalBuffer(heights, size, 1.35);
  cachedStainless = {
    albedoMap: configureRepeatTexture(albedo, size, THREE.SRGBColorSpace, 2, maxAnisotropy),
    normalMap: configureRepeatTexture(normals, size, THREE.NoColorSpace, 2, maxAnisotropy),
    roughnessMap: configureRepeatTexture(roughness, size, THREE.NoColorSpace, 2, maxAnisotropy),
  };
  return cachedStainless;
}

/** Cached RGBA cryogenic frost condensation overlay for LOX/CH4 tank zones. */
export function getCryoFrostTexture(maxAnisotropy: number): THREE.DataTexture {
  if (cachedCryoFrost) {
    return cachedCryoFrost;
  }
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const noise = new SeededNoise2D(7719);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    // Feather top and bottom edges smoothly
    const edgeFade = smoothstep(0.0, 0.16, v) * (1 - smoothstep(0.84, 1.0, v));
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const cloud = sampleTileableFbm(noise, u, v, 7.0, 4) * 0.5 + 0.5;
      const iceStreak = noise.noise2D(u * 28.0, v * 5.0) * 0.5 + 0.5;
      const alpha = Math.max(
        0,
        Math.min(1, edgeFade * (0.45 + cloud * 0.42 + iceStreak * 0.25))
      );

      const off = (y * size + x) * 4;
      data[off] = 236;
      data[off + 1] = 246;
      data[off + 2] = 255;
      data[off + 3] = Math.round(alpha * 220);
    }
  }

  cachedCryoFrost = configureRepeatTexture(data, size, THREE.SRGBColorSpace, 2, maxAnisotropy);
  return cachedCryoFrost;
}

export function disposeVehicleTextureCache(): void {
  disposeTextureSet(cachedHeatShield);
  cachedHeatShield = null;
  disposeTextureSet(cachedStainless);
  cachedStainless = null;
  if (cachedCryoFrost) {
    cachedCryoFrost.dispose();
    cachedCryoFrost = null;
  }
}
