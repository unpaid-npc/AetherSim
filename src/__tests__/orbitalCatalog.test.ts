import { describe, expect, it } from "vitest";
import { EARTH_LAUNCH_SITES } from "../config/launchSites";
import { getPlanetConfig } from "../config/planets";
import { fetchCelesTrakGpSnapshot } from "../orbital/CelesTrakService";
import {
  EARTH_SATELLITE_DEFINITIONS,
  GROUND_TRACK_OFFSET_M,
  MARS_SATELLITE_DEFINITIONS,
  MOON_SATELLITE_DEFINITIONS,
  createRuntimeSatelliteEntry,
  evaluateSatelliteSnapshot,
  geodeticToPlanetWorld,
  propagateSatelliteGeodetic,
  sampleGroundTrack,
  sampleOrbitalPathPlanetCentered,
} from "../orbital/SatelliteCatalog";
import { computeLaunchSiteZenithQuaternion } from "../scene/earthGeography";

describe("Stage 6D: SGP4 Satellite Catalog, Ground Tracks & CelesTrak Service", () => {
  it("parses embedded OMM JSON with satellite.js and propagates Earth catalog to realistic altitudes", () => {
    const sampleDate = new Date("2026-11-26T00:00:00.000Z");
    const byId = new Map(EARTH_SATELLITE_DEFINITIONS.map((d) => [d.id, d]));

    const expectedAltRangesKm: Record<string, [number, number]> = {
      iss: [350, 460],
      tiangong: [350, 440],
      hubble: [490, 580],
      sentinel2a: [750, 830],
      noaa20: [780, 870],
      gps3_sv01: [19_500, 21_000],
      goes16: [35_000, 36_500],
    };

    for (const [id, [minKm, maxKm]] of Object.entries(expectedAltRangesKm)) {
      const def = byId.get(id);
      expect(def).toBeDefined();
      const entry = createRuntimeSatelliteEntry(def!);
      expect(entry.satrec).not.toBeNull();
      const pt = propagateSatelliteGeodetic(entry, sampleDate);
      expect(pt).not.toBeNull();
      expect(Number.isFinite(pt!.latDeg)).toBe(true);
      expect(Number.isFinite(pt!.lonDeg)).toBe(true);
      expect(pt!.latDeg).toBeGreaterThanOrEqual(-90);
      expect(pt!.latDeg).toBeLessThanOrEqual(90);
      expect(pt!.lonDeg).toBeGreaterThanOrEqual(-180);
      expect(pt!.lonDeg).toBeLessThanOrEqual(180);
      expect(pt!.altKm).toBeGreaterThanOrEqual(minKm);
      expect(pt!.altKm).toBeLessThanOrEqual(maxKm);
      expect(pt!.velKms).toBeGreaterThan(2.5);
    }

    // Verify all 6 Starlink demo train units propagate around 550 km with distinct positions
    const starlinks = EARTH_SATELLITE_DEFINITIONS.filter((d) => d.category === "starlink");
    expect(starlinks).toHaveLength(6);
    const lons = new Set<string>();
    for (const sl of starlinks) {
      const entry = createRuntimeSatelliteEntry(sl);
      const pt = propagateSatelliteGeodetic(entry, sampleDate);
      expect(pt).not.toBeNull();
      expect(pt!.altKm).toBeGreaterThan(500);
      expect(pt!.altKm).toBeLessThan(600);
      lons.add(`${pt!.latDeg.toFixed(2)},${pt!.lonDeg.toFixed(2)}`);
    }
    expect(lons.size).toBe(6);
  });

  it("maps a satellite directly above any Earth launch site onto local +Y zenith at y ≈ altM", () => {
    const earthR = getPlanetConfig("earth").scale.simRadiusM;
    const testAltM = 420_000;

    for (const site of EARTH_LAUNCH_SITES) {
      const q = computeLaunchSiteZenithQuaternion(site.latDeg, site.lonDeg);
      const worldPos = geodeticToPlanetWorld(site.latDeg, site.lonDeg, testAltM, earthR, q);
      expect(Math.abs(worldPos.x)).toBeLessThan(1e-3);
      expect(Math.abs(worldPos.z)).toBeLessThan(1e-3);
      expect(Math.abs(worldPos.y - testAltM)).toBeLessThan(1e-3);
    }
  });

  it("samples continuous ISS ground tracks at radius simRadiusM + GROUND_TRACK_OFFSET_M and closed 3D orbits", () => {
    const earth = getPlanetConfig("earth");
    const R = earth.scale.simRadiusM;
    const issDef = EARTH_SATELLITE_DEFINITIONS.find((d) => d.id === "iss")!;
    const entry = createRuntimeSatelliteEntry(issDef);
    const site = EARTH_LAUNCH_SITES[0];
    const q = computeLaunchSiteZenithQuaternion(site.latDeg, site.lonDeg);
    const simDate = new Date("2026-11-26T00:00:00.000Z");

    const gt = sampleGroundTrack(entry, simDate, R, q, 180, GROUND_TRACK_OFFSET_M);
    expect(gt.latLon.length).toBe(181);
    const expectedR = R + GROUND_TRACK_OFFSET_M;

    for (let i = 0; i < gt.latLon.length; i++) {
      const { latDeg, lonDeg } = gt.latLon[i];
      expect(latDeg).toBeGreaterThanOrEqual(-90);
      expect(latDeg).toBeLessThanOrEqual(90);
      expect(lonDeg).toBeGreaterThanOrEqual(-180);
      expect(lonDeg).toBeLessThanOrEqual(180);

      const wx = gt.worldPoints[i * 3];
      const wy = gt.worldPoints[i * 3 + 1] + R;
      const wz = gt.worldPoints[i * 3 + 2];
      const rad = Math.hypot(wx, wy, wz);
      expect(Math.abs(rad - expectedR)).toBeLessThan(2.0);
    }

    const orbitPts = sampleOrbitalPathPlanetCentered(entry, simDate, R, q, 128);
    expect(orbitPts.length).toBe(129 * 3);
    for (let i = 0; i <= 128; i++) {
      const rOrbit = Math.hypot(orbitPts[i * 3], orbitPts[i * 3 + 1], orbitPts[i * 3 + 2]);
      expect(rOrbit).toBeGreaterThan(R + 350_000);
      expect(rOrbit).toBeLessThan(R + 460_000);
    }
  });

  it("handles offline CelesTrak failures cleanly as 'simulated' and parses live GP JSON accurately", async () => {
    // 1. Offline failure -> zero rejections, cleanly marks simulated
    const failingFetch = (async () => {
      throw new Error("Network offline");
    }) as unknown as typeof fetch;

    const offlineRes = await fetchCelesTrakGpSnapshot({
      force: true,
      fetchImpl: failingFetch,
      bypassStorage: true,
      nowMs: Date.parse("2026-11-26T00:05:00.000Z"),
    });
    expect(offlineRes.dataSource).toBe("simulated");
    expect(offlineRes.recordsByNorad.size).toBe(0);
    expect(offlineRes.errorMessage).toContain("Offline fallback");

    // 2. Live mock GP payload -> marks live_celestrak and propagates via satellite.js
    const issOmm = EARTH_SATELLITE_DEFINITIONS.find((d) => d.id === "iss")!.fallbackOmm!;
    const mockFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      const body = u.includes("GROUP=STATIONS") ? [issOmm] : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const liveRes = await fetchCelesTrakGpSnapshot({
      force: true,
      fetchImpl: mockFetch,
      bypassStorage: true,
      nowMs: Date.parse("2026-11-26T00:05:00.000Z"),
    });
    expect(liveRes.dataSource).toBe("live_celestrak");
    expect(liveRes.recordsByNorad.has(25544)).toBe(true);
    expect(liveRes.lastUpdatedUtc).toBe("2026-11-26 00:05 UTC");

    const issLiveEntry = createRuntimeSatelliteEntry(
      EARTH_SATELLITE_DEFINITIONS[0],
      liveRes.recordsByNorad.get(25544),
      liveRes.dataSource,
      liveRes.lastUpdatedUtc
    );
    expect(issLiveEntry.dataSource).toBe("live_celestrak");
    expect(issLiveEntry.tleEpochUtc).toContain("UTC");
  });

  it("propagates simulated Moon & Mars orbiters with honest simulated provenance", () => {
    const simDate = new Date("2026-11-26T00:00:00.000Z");

    for (const [planetId, defs] of [
      ["moon", MOON_SATELLITE_DEFINITIONS],
      ["mars", MARS_SATELLITE_DEFINITIONS],
    ] as const) {
      const cfg = getPlanetConfig(planetId);
      const q = computeLaunchSiteZenithQuaternion(
        cfg.scale.launchSiteCoords.latDeg,
        cfg.scale.launchSiteCoords.lonDeg
      );
      expect(defs.length).toBeGreaterThanOrEqual(2);
      for (const def of defs) {
        const entry = createRuntimeSatelliteEntry(def);
        const snap = evaluateSatelliteSnapshot(entry, simDate, cfg.scale.simRadiusM, q, 2);
        expect(snap).not.toBeNull();
        expect(snap!.dataSource).toBe("simulated");
        expect(snap!.altitudeKm).toBeGreaterThan(50);
        expect(snap!.velocityKms).toBeGreaterThan(0.5);
        expect(Number.isFinite(snap!.worldPos.x)).toBe(true);
      }
    }
  });
});
