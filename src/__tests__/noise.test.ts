import { describe, expect, it } from "vitest";
import { getPlanetConfig, PLANET_ORDER } from "../config/planets";
import { PAD_FLAT_RADIUS_M, SeededNoise2D, samplePlanetTerrainHeight } from "../utils/noise";

describe("procedural noise and terrain height", () => {
  it("produces deterministic noise values for identical seeds and differs across seeds", () => {
    const a1 = new SeededNoise2D(12345);
    const a2 = new SeededNoise2D(12345);
    const b = new SeededNoise2D(99999);

    for (const [x, y] of [
      [0.12, -3.45],
      [42.5, 18.2],
      [-120.0, 88.4],
    ]) {
      expect(a1.noise2D(x, y)).toBe(a2.noise2D(x, y));
      expect(a1.fbm(x, y, 4)).toBe(a2.fbm(x, y, 4));
      expect(a1.ridged(x, y, 4)).toBe(a2.ridged(x, y, 4));
      expect(a1.craterField(x * 50, y * 50, 150)).toBe(a2.craterField(x * 50, y * 50, 150));
      expect(a1.noise2D(x, y)).not.toBe(b.noise2D(x, y));
    }
  });

  it("keeps launchpad area strictly flat at y=0 and varies terrain outside blend zone", () => {
    for (const planetId of PLANET_ORDER) {
      const cfg = getPlanetConfig(planetId);
      const noise1 = new SeededNoise2D(cfg.terrain.seed);
      const noise2 = new SeededNoise2D(cfg.terrain.seed);

      // Inside flat apron (r <= 65 m)
      expect(samplePlanetTerrainHeight(0, 0, cfg, noise1)).toBe(0);
      expect(samplePlanetTerrainHeight(30, -40, cfg, noise1)).toBe(0);
      expect(samplePlanetTerrainHeight(PAD_FLAT_RADIUS_M - 0.1, 0, cfg, noise1)).toBe(0);

      // Deterministic outside pad + non-flat relief
      const samples: number[] = [];
      for (const [x, z] of [
        [240, 180],
        [-420, 310],
        [950, -680],
        [-1500, -1100],
      ]) {
        const h1 = samplePlanetTerrainHeight(x, z, cfg, noise1);
        const h2 = samplePlanetTerrainHeight(x, z, cfg, noise2);
        expect(h1).toBe(h2);
        samples.push(h1);
      }
      expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(1.0);
    }
  });
});
