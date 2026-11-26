import { describe, expect, it } from "vitest";
import { PLANET_ORDER, type PlanetId, getPlanetConfig } from "../config/planets";
import { type BoosterStatus, FlightController } from "../sim/FlightController";
import {
  computeGravitationalParameter,
  computeOrbitalElements,
  sampleOrbitPoints,
} from "../sim/OrbitalMechanics";

describe("True 1:1 Orbital Mechanics, 18% Staging & Autonomous Booster RTLS", () => {
  it("computes exact Keplerian circular orbital elements (Earth 200 km = 7,784 +/- 20 m/s) and closed loops across Moon, Mars, and Earth", () => {
    for (const id of PLANET_ORDER) {
      const cfg = getPlanetConfig(id);
      const R = cfg.scale.simRadiusM;
      const g0 = cfg.physics.gravityMps2;
      const alt = cfg.scale.targetOrbitAltM;
      const mu = computeGravitationalParameter(g0, R);
      const rCirc = R + alt;
      const vCirc = Math.sqrt(mu / rCirc);

      if (id === "earth") {
        expect(Math.abs(vCirc - 7784)).toBeLessThanOrEqual(20);
      }

      const orb = computeOrbitalElements(
        { x: 0, y: alt, z: 0 },
        { x: vCirc, y: 0, z: 0 },
        R,
        g0,
        cfg.scale.atmosphereTopM
      );

      expect(orb.eccentricity).toBeLessThan(1e-4);
      expect(orb.apoapsisAltM).toBeCloseTo(alt, 0);
      expect(orb.periapsisAltM).toBeCloseTo(alt, 0);
      expect(orb.circularVelocityMps).toBeCloseTo(vCirc, 2);
      expect(orb.isBoundOrbit).toBe(true);
      expect(orb.isOrbitAchieved).toBe(true);
      expect(orb.orbitalPeriodS).not.toBeNull();
      expect(orb.orbitalPeriodS!).toBeGreaterThan(60);

      const pts = sampleOrbitPoints({ x: 0, y: alt, z: 0 }, { x: vCirc, y: 0, z: 0 }, R, mu, 90);
      expect(pts.length).toBe(91);
      // Closed circle matches start & end within 1 meter
      expect(Math.hypot(pts[0].x - pts[90].x, pts[0].y - pts[90].y, pts[0].z - pts[90].z)).toBeLessThan(1.0);
    }
  });

  it("distinguishes elliptical bound orbits from suborbital surface-impact trajectories", () => {
    const mars = getPlanetConfig("mars");
    const R = mars.scale.simRadiusM;
    const g0 = mars.physics.gravityMps2;
    const mu = computeGravitationalParameter(g0, R);

    // Elliptical transfer orbit: faster than circular at periapsis 140 km
    const rp = R + 140_000;
    const vEllip = Math.sqrt(mu / rp) * 1.12;
    const ellip = computeOrbitalElements(
      { x: 0, y: 140_000, z: 0 },
      { x: vEllip, y: 0, z: 0 },
      R,
      g0,
      mars.scale.atmosphereTopM
    );
    expect(ellip.isBoundOrbit).toBe(true);
    expect(ellip.eccentricity).toBeGreaterThan(0.15);
    expect(ellip.eccentricity).toBeLessThan(0.8);
    expect(ellip.apoapsisAltM).toBeGreaterThan(ellip.periapsisAltM);
    expect(ellip.periapsisAltM).toBeCloseTo(140_000, 0);

    // Suborbital trajectory: slow horizontal speed -> periapsis below surface (Pe <= 0)
    const subPos = { x: 0, y: 60_000, z: 0 };
    const subVel = { x: 800, y: 180, z: 0 };
    const sub = computeOrbitalElements(subPos, subVel, R, g0, mars.scale.atmosphereTopM);
    expect(sub.isBoundOrbit).toBe(true);
    expect(sub.periapsisAltM).toBeLessThanOrEqual(0);
    expect(sub.isOrbitAchieved).toBe(false);

    const subPts = sampleOrbitPoints(subPos, subVel, R, mu, 80);
    expect(subPts.length).toBe(81);
    const last = subPts[subPts.length - 1];
    const lastR = Math.hypot(last.x, last.y + R, last.z);
    expect(lastR).toBeCloseTo(R, -2);
  });

  it("executes full surface-to-orbit launch, 18% staging, Starship circularization, and Booster RTLS recovery across Mars, Earth & Moon", () => {
    const padHeights: Record<PlanetId, number> = {
      mars: 2.2,
      earth: 18.0,
      moon: 1.6,
    };

    for (const id of PLANET_ORDER) {
      const cfg = getPlanetConfig(id);
      const ctrl = new FlightController(id, padHeights[id], "launch");
      ctrl.startMission();

      let tel = ctrl.getTelemetry();
      let timeToOrbitSec = 0;
      let altAtSepM = 0;
      let speedAtSepMps = 0;
      let fuelAtSep = 1;
      const seenBoosterStates = new Set<BoosterStatus>([tel.booster.status]);

      const isBoosterDone = (s: BoosterStatus) =>
        s === "BOOSTER_CAUGHT" || s === "BOOSTER_LANDED" || s === "BOOSTER_CRASHED";

      // Simulate up to 1200s of 1:1 flight via fixed 60 Hz steps until both Ship orbit and Booster RTLS settle
      for (let i = 0; i < 60 * 1200; i++) {
        const wasSep = tel.stageSeparated;
        tel = ctrl.update(1 / 60);
        seenBoosterStates.add(tel.booster.status);

        if (!wasSep && tel.stageSeparated) {
          altAtSepM = tel.altitudeM;
          speedAtSepMps = tel.speedMps;
          fuelAtSep = tel.booster.fuel;
        }
        if (tel.phase === "CRASHED") {
          break;
        }
        if (tel.phase === "ORBIT_ACHIEVED" && tel.orbital.orbitAchieved && timeToOrbitSec === 0) {
          timeToOrbitSec = tel.missionTimeSec;
        }
        if (timeToOrbitSec > 0 && isBoosterDone(tel.booster.status)) {
          break;
        }
      }

      const expectedBoosterDone: BoosterStatus =
        id === "earth" ? "BOOSTER_CAUGHT" : "BOOSTER_LANDED";

      console.log(
        `[1:1 Launch+RTLS Proof] planet=${id} sepAlt=${(altAtSepM / 1000).toFixed(2)}km sepSpeed=${speedAtSepMps.toFixed(0)}m/s sepFuel=${(fuelAtSep * 100).toFixed(1)}% | orbit t=${timeToOrbitSec.toFixed(1)}s Ap=${(tel.orbital.apoapsisAltM / 1000).toFixed(2)}km Pe=${(tel.orbital.periapsisAltM / 1000).toFixed(2)}km v=${tel.speedMps.toFixed(1)}m/s e=${tel.orbital.eccentricity.toFixed(4)} | booster=${tel.booster.status} offset=${tel.booster.touchdownOffsetM?.toFixed(2) ?? "null"}m |vy|=${tel.booster.touchdownVerticalSpeedMps?.toFixed(2) ?? "null"}m/s`
      );

      // Realistic propellant-driven staging (18% RTLS reserve)
      expect(fuelAtSep).toBeLessThanOrEqual(0.22);
      expect(altAtSepM).toBeGreaterThan(id === "earth" ? 40_000 : 12_000);

      // Starship stable 1:1 orbit
      expect(tel.phase).toBe("ORBIT_ACHIEVED");
      expect(tel.orbital.orbitAchieved).toBe(true);
      expect(tel.orbital.eccentricity).toBeLessThan(0.05);
      expect(tel.orbital.periapsisAltM).toBeGreaterThanOrEqual(
        cfg.scale.atmosphereTopM > 0 ? Math.max(cfg.scale.atmosphereTopM * 1.15, 140_000) : 60_000
      );
      expect(tel.crashEvent).toBeNull();

      // Autonomous Super Heavy Booster RTLS recovery
      expect(seenBoosterStates.has("BOOSTER_FLIP")).toBe(true);
      expect(seenBoosterStates.has("BOOSTER_BOOSTBACK")).toBe(true);
      expect(seenBoosterStates.has("BOOSTER_DESCENT")).toBe(true);
      expect(seenBoosterStates.has("BOOSTER_LANDING_BURN")).toBe(true);
      expect(tel.booster.status).toBe(expectedBoosterDone);
      expect(tel.booster.impactEvent).toBeNull();
      expect(tel.booster.touchdownOffsetM).not.toBeNull();
      expect(tel.booster.touchdownOffsetM!).toBeLessThanOrEqual(25.0);
      expect(tel.booster.touchdownVerticalSpeedMps).not.toBeNull();
      expect(tel.booster.touchdownVerticalSpeedMps!).toBeLessThan(5.0);

      // Verify Starship coasts smoothly around the globe for 60s without crashing or losing orbit
      const startPos = { ...tel.position };
      for (let i = 0; i < 60 * 60; i++) {
        tel = ctrl.update(1 / 60);
      }
      expect(tel.phase).toBe("ORBIT_ACHIEVED");
      expect(tel.orbital.orbitAchieved).toBe(true);
      expect(tel.crashEvent).toBeNull();
      const arcMoved = Math.hypot(
        tel.position.x - startPos.x,
        tel.position.y - startPos.y,
        tel.position.z - startPos.z
      );
      expect(arcMoved).toBeGreaterThan(5_000);
    }
  });

  it("supports deterministic TimeWarp stepping (1x..50x) and auto-resets warp to 1x on reset", () => {
    const ctrl = new FlightController("moon", 1.6, "launch");
    ctrl.setTimeWarp(50);
    expect(ctrl.getTimeWarp()).toBe(50);
    ctrl.startMission();

    // 2.0 real seconds at 50x warp = 100.0 simulated seconds (well past T-10s countdown & liftoff)
    let tel = ctrl.getTelemetry();
    for (let i = 0; i < 120; i++) {
      tel = ctrl.update(1 / 60);
    }
    expect(tel.missionTimeSec).toBeCloseTo(100.0, 1);
    expect(tel.altitudeM).toBeGreaterThan(20_000);
    expect(tel.orbital.timeWarp).toBe(50);

    ctrl.reset("moon", 1.6, "launch");
    expect(ctrl.getTimeWarp()).toBe(1);
    expect(ctrl.getTelemetry().orbital.timeWarp).toBe(1);
  });
});
