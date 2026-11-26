import { describe, expect, it } from "vitest";
import { PLANET_ORDER, getPlanetConfig } from "../config/planets";
import {
  computeLaunchSiteZenithQuaternion,
  geoToLocalENU,
} from "../scene/earthGeography";
import {
  SeededNoise2D,
  computeCurvedSurfaceDrop,
  computeEarthShorelineX,
  samplePlanetTerrainHeight,
} from "../utils/noise";

describe("Milestone 6 Stage 6B — ENU Globe Orientation & Boca Chica Coastline", () => {
  it("rotates launchSiteCoords into strict local ENU axes (+X East, +Y Up, -Z North)", () => {
    for (const id of PLANET_ORDER) {
      const { latDeg, lonDeg } = getPlanetConfig(id).scale.launchSiteCoords;
      const { east, up, north } = geoToLocalENU(latDeg, lonDeg);
      const q = computeLaunchSiteZenithQuaternion(latDeg, lonDeg);

      const rotatedEast = east.clone().applyQuaternion(q);
      const rotatedUp = up.clone().applyQuaternion(q);
      const rotatedNorth = north.clone().applyQuaternion(q);

      expect(rotatedUp.x).toBeCloseTo(0, 4);
      expect(rotatedUp.y).toBeCloseTo(1, 4);
      expect(rotatedUp.z).toBeCloseTo(0, 4);

      expect(rotatedEast.x).toBeCloseTo(1, 4);
      expect(rotatedEast.y).toBeCloseTo(0, 4);
      expect(rotatedEast.z).toBeCloseTo(0, 4);

      expect(rotatedNorth.x).toBeCloseTo(0, 4);
      expect(rotatedNorth.y).toBeCloseTo(0, 4);
      expect(rotatedNorth.z).toBeCloseTo(-1, 4);
    }
  });

  it("produces flat coastal plain inland West and submerged Gulf seabed East at Starbase Boca Chica", () => {
    const earth = getPlanetConfig("earth");
    const noise = new SeededNoise2D(earth.terrain.seed);

    // Pad deck apron strictly zero
    expect(samplePlanetTerrainHeight(0, 0, earth, noise)).toBe(0);
    expect(samplePlanetTerrainHeight(45, -30, earth, noise)).toBe(0);

    // Inland West coastal plain stays flat/gently rolling (no mountains)
    for (const xInland of [-200, -600, -1200]) {
      for (const z of [-400, 0, 400]) {
        const y = samplePlanetTerrainHeight(xInland, z, earth, noise);
        const drop = computeCurvedSurfaceDrop(Math.hypot(xInland, z), earth.scale.simRadiusM);
        const localRelief = y - drop;
        expect(localRelief).toBeGreaterThanOrEqual(-1.0);
        expect(localRelief).toBeLessThanOrEqual(6.0);
      }
    }

    // Offshore East descends strictly below sea level into Gulf seabed (shallow shelf -> deeper Gulf)
    for (const xOffshore of [560, 950, 1600]) {
      const xShore = computeEarthShorelineX(0, noise);
      expect(xOffshore).toBeGreaterThan(xShore + 55);
      const y = samplePlanetTerrainHeight(xOffshore, 0, earth, noise);
      const drop = computeCurvedSurfaceDrop(xOffshore, earth.scale.simRadiusM);
      const localDepth = y - drop;
      expect(localDepth).toBeLessThan(-0.5);
    }
    const deepDepth =
      samplePlanetTerrainHeight(1600, 0, earth, noise) -
      computeCurvedSurfaceDrop(1600, earth.scale.simRadiusM);
    expect(deepDepth).toBeLessThan(-10.0);
  });

  it("keeps Mars and Moon non-coastal terrain relief intact", () => {
    const mars = getPlanetConfig("mars");
    const moon = getPlanetConfig("moon");
    const marsNoise = new SeededNoise2D(mars.terrain.seed);
    const moonNoise = new SeededNoise2D(moon.terrain.seed);

    const marsSamples = [
      samplePlanetTerrainHeight(-800, 300, mars, marsNoise) -
        computeCurvedSurfaceDrop(Math.hypot(-800, 300), mars.scale.simRadiusM),
      samplePlanetTerrainHeight(950, -680, mars, marsNoise) -
        computeCurvedSurfaceDrop(Math.hypot(950, -680), mars.scale.simRadiusM),
    ];
    const moonSamples = [
      samplePlanetTerrainHeight(-800, 300, moon, moonNoise) -
        computeCurvedSurfaceDrop(Math.hypot(-800, 300), moon.scale.simRadiusM),
      samplePlanetTerrainHeight(950, -680, moon, moonNoise) -
        computeCurvedSurfaceDrop(Math.hypot(950, -680), moon.scale.simRadiusM),
    ];

    expect(Math.max(...marsSamples) > 8 || Math.min(...marsSamples) < -4).toBe(true);
    expect(Math.max(...moonSamples) > 8 || Math.min(...moonSamples) < -4).toBe(true);
  });
});
