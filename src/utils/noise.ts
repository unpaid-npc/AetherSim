import type { LaunchSiteConfig } from "../config/launchSites";
import type { PlanetConfig } from "../config/planets";

export const PAD_FLAT_RADIUS_M = 65;
export const PAD_BLEND_RADIUS_M = 140;

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

const GRAD2: readonly [number, number][] = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0, 1],
  [0, -1],
];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) {
    return x >= edge1 ? 1 : 0;
  }
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Deterministic 2D Simplex + FBM + ridged + crater noise generator. */
export class SeededNoise2D {
  private readonly perm: Uint8Array;
  private readonly permMod12: Uint8Array;

  constructor(seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      p[i] = i;
    }
    const rng = mulberry32(seed);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** Returns 2D Simplex noise in approximately [-1, 1]. */
  noise2D(xin: number, yin: number): number {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    let n0 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const g0 = GRAD2[this.permMod12[ii + this.perm[jj]]];
      t0 *= t0;
      n0 = t0 * t0 * (g0[0] * x0 + g0[1] * y0);
    }

    let n1 = 0;
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const g1 = GRAD2[this.permMod12[ii + i1 + this.perm[jj + j1]]];
      t1 *= t1;
      n1 = t1 * t1 * (g1[0] * x1 + g1[1] * y1);
    }

    let n2 = 0;
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const g2 = GRAD2[this.permMod12[ii + 1 + this.perm[jj + 1]]];
      t2 *= t2;
      n2 = t2 * t2 * (g2[0] * x2 + g2[1] * y2);
    }

    return 70 * (n0 + n1 + n2);
  }

  /** Fractal Brownian Motion in approximately [-1, 1]. */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2.05, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise2D(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /** Ridged multifractal noise in [0, 1]. */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2.1, gain = 0.52): number {
    let sum = 0;
    let amp = 0.5;
    let freq = 1;
    let weight = 1;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      let signal = 1 - Math.abs(this.noise2D(x * freq, y * freq));
      signal *= signal * weight;
      weight = Math.max(0, Math.min(1, signal * 1.8));
      sum += signal * amp;
      norm += amp;
      freq *= lacunarity;
      amp *= gain;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /** Cellular-like impact crater profile with raised rim and bowl depression. */
  craterField(x: number, y: number, cellSize: number): number {
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
    let heightDelta = 0;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cx = gx + dx;
        const cy = gy + dy;
        const h1 = this.hash2D(cx, cy, 17);
        if (h1 < 0.42) {
          continue;
        }
        const ox = (cx + 0.2 + 0.6 * this.hash2D(cx, cy, 53)) * cellSize;
        const oy = (cy + 0.2 + 0.6 * this.hash2D(cx, cy, 97)) * cellSize;
        const radius = cellSize * (0.18 + 0.24 * this.hash2D(cx, cy, 131));
        const dist = Math.hypot(x - ox, y - oy) / radius;
        if (dist < 1.38) {
          if (dist < 0.84) {
            const bowl = (dist / 0.84) * (dist / 0.84) - 1;
            heightDelta += bowl * 0.62;
          } else {
            const rimT = 1 - Math.abs(dist - 1.0) / 0.38;
            heightDelta += Math.max(0, rimT) * 0.32;
          }
        }
      }
    }
    return heightDelta;
  }

  private hash2D(ix: number, iy: number, salt: number): number {
    const a = this.perm[(ix + salt) & 255];
    const b = this.perm[(iy + a) & 255];
    return this.perm[(b + salt * 3) & 255] / 255;
  }
}

/**
 * Exact spherical planetary surface vertical drop at horizontal distance `r` (m)
 * from the tangent zenith point on a sphere of radius `simRadiusM` (m).
 */
export function computeSphereDrop(r: number, simRadiusM: number): number {
  if (r <= 0 || simRadiusM <= 0) {
    return 0;
  }
  const clampedR = Math.min(r, simRadiusM);
  return Math.sqrt(Math.max(0, simRadiusM * simRadiusM - clampedR * clampedR)) - simRadiusM;
}

/**
 * Smoothly transitions from strictly 0 inside the launchpad apron (r <= 70 m)
 * to full spherical curvature for r >= 450 m, keeping the +/-250 m PPO zone flat-compatible (<0.5 m).
 */
export function computeCurvedSurfaceDrop(r: number, simRadiusM: number): number {
  if (r <= 70) {
    return 0;
  }
  return smoothstep(70, 450, r) * computeSphereDrop(r, simRadiusM);
}

/**
 * Deterministic Starbase Boca Chica shoreline X-coordinate (east of pad, running North-South along Z).
 * Shared across coastal terrain elevation, shoreline vertex tinting, and Gulf ocean geometry.
 */
export function computeEarthShorelineX(z: number, noise: SeededNoise2D): number {
  return 385 + noise.fbm(0, z * 0.00055, 3) * 42;
}

export function sampleEarthSiteTerrainHeight(
  x: number,
  z: number,
  config: PlanetConfig,
  noise: SeededNoise2D,
  site?: LaunchSiteConfig
): number {
  const r = Math.hypot(x, z);
  if (r <= PAD_FLAT_RADIUS_M) {
    return 0;
  }
  const localR = config.scale.localTerrainRadiusM;
  const sphereDrop = computeCurvedSurfaceDrop(r, config.scale.simRadiusM);
  if (r >= localR) {
    return sphereDrop;
  }

  const blend = smoothstep(PAD_FLAT_RADIUS_M, PAD_BLEND_RADIUS_M, r);
  const outerTaper = 1 - smoothstep(localR * 0.6, localR * 0.92, r);

  // Inland arid steppe (e.g. Baikonur Cosmodrome): dry Kazakh plain with zero ocean
  if (site && !site.hasOcean) {
    const steppeWave = noise.fbm(x * 0.0018 + 3.1, z * 0.0018 - 1.7, 4) * 0.5 + 0.5;
    const ridge = noise.ridged(x * 0.0009, z * 0.0009, 3) * 2.4;
    let rawSteppeY = 0.45 + steppeWave * 3.4 + ridge;
    const railCorridor =
      (1 - smoothstep(14, 42, Math.abs(z - 84))) * (1 - smoothstep(260, 420, x));
    rawSteppeY = rawSteppeY * (1 - railCorridor) + 0.3 * railCorridor;
    return blend * rawSteppeY * outerTaper + sphereDrop;
  }

  // Orient coastline according to launch site coast azimuth (default 90 deg = East +X)
  const azDeg = site?.coastAzimuthDeg ?? 90;
  let coastU = x;
  let coastT = z;
  if (Math.abs(azDeg - 90) > 0.1) {
    const azRad = (azDeg * Math.PI) / 180;
    const s = Math.sin(azRad);
    const c = Math.cos(azRad);
    coastU = x * s - z * c;
    coastT = x * c + z * s;
  }

  const xShore = computeEarthShorelineX(coastT, noise);
  const dShore = coastU - xShore;
  let rawCoastalY: number;

  if (site?.biome === "coastal_bluff") {
    // Tanegashima scenic green hills & elevated volcanic bluff descending into Pacific surf
    if (dShore < -55) {
      const hillMask = smoothstep(220, 750, -dShore);
      const bluffHills = (noise.fbm(x * 0.002 + 7.2, z * 0.002 + 2.4, 4) * 0.5 + 0.5) * 22.0;
      const roadFlat =
        (1 - smoothstep(14, 40, Math.abs(z - 78))) * (1 - smoothstep(230, 310, x));
      rawCoastalY = (1.1 + bluffHills * hillMask) * (1 - roadFlat) + 0.35 * roadFlat;
    } else if (dShore <= 55) {
      const slope = 2.6 - smoothstep(-55, 55, dShore) * 3.4;
      rawCoastalY = slope;
    } else {
      const shelfT = smoothstep(55, 880, dShore);
      rawCoastalY = -0.8 - shelfT * 17.5;
    }
    return blend * rawCoastalY * outerTaper + sphereDrop;
  }

  if (dShore < -55) {
    // Flat coastal plain & sandy dunes (+ shallow marsh pocket West-NW)
    const duneWave = noise.fbm(x * 0.0022, z * 0.0022, 3) * 0.5 + 0.5;
    const rolling = 0.65 + duneWave * 2.65;
    const marshMask =
      smoothstep(-220, -480, coastU) * smoothstep(-60, -280, coastT) * (0.6 + 0.4 * duneWave);
    rawCoastalY = rolling * (1 - marshMask * 0.85) - marshMask * 0.35;

    const hwyCorridor =
      (1 - smoothstep(14, 42, Math.abs(z - 78))) * (1 - smoothstep(230, 310, x));
    rawCoastalY = rawCoastalY * (1 - hwyCorridor) + 0.35 * hwyCorridor;
  } else if (dShore <= 55) {
    const berm = smoothstep(-55, -28, dShore) * (1 - smoothstep(-28, 0, dShore)) * 1.45;
    const slope = 1.65 - smoothstep(-55, 55, dShore) * 2.25;
    rawCoastalY = slope + berm;
  } else {
    const shelfT = smoothstep(55, 880, dShore);
    rawCoastalY = -0.6 - shelfT * 15.9;
  }

  return blend * rawCoastalY * outerTaper + sphereDrop;
}

/**
 * Sample deterministic spherically curved planetary terrain height at world (x, z) meters.
 * Guarantees strictly 0.0 inside `r <= 65 m` so the launchpad apron sits flush,
 * and smoothly tapers relief into the underlying globe curve toward `localTerrainRadiusM`.
 */
export function samplePlanetTerrainHeight(
  x: number,
  z: number,
  config: PlanetConfig,
  noise: SeededNoise2D,
  site?: LaunchSiteConfig
): number {
  const r = Math.hypot(x, z);
  if (r <= PAD_FLAT_RADIUS_M) {
    return 0;
  }

  const localR = config.scale.localTerrainRadiusM;
  const sphereDrop = computeCurvedSurfaceDrop(r, config.scale.simRadiusM);
  if (r >= localR) {
    return sphereDrop;
  }

  if (config.id === "earth") {
    return sampleEarthSiteTerrainHeight(x, z, config, noise, site);
  }

  const blend = smoothstep(PAD_FLAT_RADIUS_M, PAD_BLEND_RADIUS_M, r);
  const outerTaper = 1 - smoothstep(localR * 0.6, localR * 0.92, r);

  const { terrain } = config;
  const fx = x * terrain.noiseFrequency;
  const fz = z * terrain.noiseFrequency;

  const baseFbm = noise.fbm(fx, fz, 5, 2.05, 0.5);
  const ridges = noise.ridged(fx * 1.45 + 11.3, fz * 1.45 - 7.1, 4) * 2 - 0.85;
  const craters =
    terrain.craterWeight > 0
      ? noise.craterField(x, z, 280) * 0.85 + noise.craterField(x + 42, z - 19, 135) * 0.45
      : 0;

  const distanceBoost = 1 + smoothstep(850, 4200, r) * 1.65;
  const rawHeight =
    (baseFbm * 0.55 + ridges * terrain.ridgeWeight + craters * terrain.craterWeight) *
    terrain.heightScale *
    distanceBoost;

  // Keep terrain mostly positive/rolling hills outside the pad while preserving crater bowls
  const shifted = rawHeight + terrain.heightScale * 0.14;
  return blend * shifted * outerTaper + sphereDrop;
}
