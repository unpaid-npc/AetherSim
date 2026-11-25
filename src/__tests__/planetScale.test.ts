import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { PLANET_ORDER, getPlanetConfig } from "../config/planets";
import {
  computeLaunchSiteZenithQuaternion,
  geoToSphereUnitVector,
  isEarthLand,
} from "../scene/earthGeography";
import { computeCurvedSurfaceDrop, computeSphereDrop } from "../utils/noise";

describe("Milestone 5 Stage 5A — Planetary Scale, Curvature & Geography", () => {
  it("defines valid 1:50 planetary scale parameters ordered Moon < Mars < Earth", () => {
    const moon = getPlanetConfig("moon");
    const mars = getPlanetConfig("mars");
    const earth = getPlanetConfig("earth");

    for (const id of PLANET_ORDER) {
      const cfg = getPlanetConfig(id);
      expect(cfg.scale.simScaleRatio).toBe(50);
      expect(cfg.scale.simRadiusM).toBeCloseTo((cfg.scale.realRadiusKm * 1000) / 50, 2);
      expect(cfg.scale.localTerrainRadiusM).toBeGreaterThanOrEqual(10_000);
      expect(cfg.scale.localTerrainRadiusM).toBeLessThanOrEqual(cfg.scale.simRadiusM * 0.45);
      expect(cfg.scale.targetOrbitAltM).toBeGreaterThan(cfg.scale.atmosphereTopM);
    }

    expect(moon.scale.simRadiusM).toBeLessThan(mars.scale.simRadiusM);
    expect(mars.scale.simRadiusM).toBeLessThan(earth.scale.simRadiusM);
    expect(moon.scale.atmosphereTopM).toBe(0);
    expect(mars.scale.atmosphereTopM).toBeGreaterThan(0);
    expect(earth.scale.atmosphereTopM).toBeGreaterThan(mars.scale.atmosphereTopM);
  });

  it("preserves flat pad apron, <0.5 m curvature inside +/-250 m PPO zone, and exact spherical drop beyond", () => {
    for (const id of PLANET_ORDER) {
      const { simRadiusM } = getPlanetConfig(id).scale;

      expect(computeSphereDrop(0, simRadiusM)).toBe(0);
      expect(computeCurvedSurfaceDrop(0, simRadiusM)).toBe(0);
      expect(computeCurvedSurfaceDrop(65, simRadiusM)).toBe(0);

      // Ensure PPO landing spawn box (+/-250 m) has negligible curvature offset (<0.5 m)
      expect(Math.abs(computeCurvedSurfaceDrop(250, simRadiusM))).toBeLessThan(0.5);

      const d1000 = computeSphereDrop(1000, simRadiusM);
      const d5000 = computeSphereDrop(5000, simRadiusM);
      const d15000 = computeSphereDrop(15000, simRadiusM);
      expect(d1000).toBeLessThan(0);
      expect(d5000).toBeLessThan(d1000);
      expect(d15000).toBeLessThan(d5000);
      expect(computeCurvedSurfaceDrop(5000, simRadiusM)).toBeCloseTo(d5000, 6);
    }
  });

  it("encodes accurate offline Earth continent polygons separating continents from oceans", () => {
    // Land points: Boca Chica, North America, Eurasia, India, Africa, Australia, Antarctica
    const landCoords: Array<[string, number, number]> = [
      ["Starbase Boca Chica", -97.156, 25.997],
      ["Central North America", -100, 40],
      ["Eurasia", 60, 55],
      ["India", 78, 21],
      ["Africa", 20, 5],
      ["Australia", 134, -25],
      ["Antarctica", 0, -82],
      ["Greenland", -40, 72],
    ];
    for (const [label, lon, lat] of landCoords) {
      expect(isEarthLand(lon, lat), `${label} should classify as land`).toBe(true);
    }

    // Ocean points: Mid-Pacific, Mid-Atlantic, Indian Ocean, Southern Ocean
    const oceanCoords: Array<[string, number, number]> = [
      ["Mid-Pacific", -150, 0],
      ["Mid-Atlantic", -35, 25],
      ["Indian Ocean", 80, -25],
      ["South Pacific", -120, -40],
    ];
    for (const [label, lon, lat] of oceanCoords) {
      expect(isEarthLand(lon, lat), `${label} should classify as ocean`).toBe(false);
    }
  });

  it("rotates each planet's launchSiteCoords cleanly to zenith (0, 1, 0)", () => {
    for (const id of PLANET_ORDER) {
      const { latDeg, lonDeg } = getPlanetConfig(id).scale.launchSiteCoords;
      const [vx, vy, vz] = geoToSphereUnitVector(latDeg, lonDeg);
      const v = new THREE.Vector3(vx, vy, vz).normalize();
      const q = computeLaunchSiteZenithQuaternion(latDeg, lonDeg);
      v.applyQuaternion(q);
      expect(v.x).toBeCloseTo(0, 4);
      expect(v.y).toBeCloseTo(1, 4);
      expect(v.z).toBeCloseTo(0, 4);
    }
  });
});
