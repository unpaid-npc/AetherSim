import { describe, expect, it } from "vitest";
import { PLANET_ORDER, PLANETS, getPlanetConfig } from "../config/planets";

describe("planets configuration", () => {
  it("defines mars, earth, and moon with distinct NASA reference constants", () => {
    expect(PLANET_ORDER).toEqual(["mars", "earth", "moon"]);
    expect(Object.keys(PLANETS).sort()).toEqual(["earth", "mars", "moon"]);

    const moon = getPlanetConfig("moon");
    const mars = getPlanetConfig("mars");
    const earth = getPlanetConfig("earth");

    expect(moon.physics.gravityMps2).toBeLessThan(mars.physics.gravityMps2);
    expect(mars.physics.gravityMps2).toBeLessThan(earth.physics.gravityMps2);

    expect(moon.physics.surfacePressureBar).toBe(0);
    expect(moon.physics.airDensityKgM3).toBe(0);
    expect(mars.physics.surfacePressureBar).toBeGreaterThan(0);
    expect(mars.physics.surfacePressureBar).toBeLessThan(earth.physics.surfacePressureBar);
    expect(mars.physics.airDensityKgM3).toBeLessThan(earth.physics.airDensityKgM3);
  });

  it("assigns distinct shader, cloud, starfield, and terrain palettes per planet", () => {
    const moon = getPlanetConfig("moon");
    const mars = getPlanetConfig("mars");
    const earth = getPlanetConfig("earth");

    expect(moon.atmosphere.atmosphereStrength).toBe(0);
    expect(moon.atmosphere.starIntensity).toBeGreaterThan(mars.atmosphere.starIntensity);
    expect(earth.atmosphere.starIntensity).toBe(0);

    expect(earth.atmosphere.hasClouds).toBe(true);
    expect(mars.atmosphere.hasClouds).toBe(false);
    expect(moon.atmosphere.hasClouds).toBe(false);

    const horizonColors = new Set([
      moon.atmosphere.horizonColor,
      mars.atmosphere.horizonColor,
      earth.atmosphere.horizonColor,
    ]);
    expect(horizonColors.size).toBe(3);

    const primarySoils = new Set([
      moon.terrain.soilPalette[0],
      mars.terrain.soilPalette[0],
      earth.terrain.soilPalette[0],
    ]);
    expect(primarySoils.size).toBe(3);
  });
});
