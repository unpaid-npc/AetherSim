import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  EARTH_LAUNCH_SITES,
  getLaunchSiteConfig,
} from "../config/launchSites";
import { getPlanetConfig } from "../config/planets";
import { type VehicleId, getVehicleConfig } from "../config/vehicles";
import {
  computeLaunchSiteZenithQuaternion,
  geoToSphereUnitVector,
} from "../scene/earthGeography";
import { FlightController, type FlightTelemetry } from "../sim/FlightController";
import {
  SeededNoise2D,
  computeCurvedSurfaceDrop,
  samplePlanetTerrainHeight,
} from "../utils/noise";

function runHeadlessLaunch(
  vehicleId: VehicleId,
  siteId: "starbase" | "ksc_lc39a" | "sriharikota" | "kourou" | "tanegashima" | "baikonur",
  maxSimSec = 1400
): {
  finalTel: FlightTelemetry;
  sawSideBoosterSep: boolean;
  sawStageSep: boolean;
  sawBoosterLegsDeployed: boolean;
} {
  const site = getLaunchSiteConfig(siteId);
  const veh = getVehicleConfig(vehicleId);
  const ctrl = new FlightController("earth", site.elevationM, "launch", vehicleId, siteId);
  ctrl.setControlMode("autopilot");
  ctrl.setTimeWarp(5);
  ctrl.startMission();

  const manual = {
    throttleDelta: 0,
    throttleSet: null,
    pitchInput: 0,
    yawInput: 0,
    rollInput: 0,
  };

  let simSec = 0;
  const frameDt = 0.05; // 5x warp = 0.25s sim per call at internal 1/60s physics steps
  let sawSideBoosterSep = false;
  let sawStageSep = false;
  let sawBoosterLegsDeployed = false;
  let tel = ctrl.getTelemetry();

  while (simSec < maxSimSec) {
    tel = ctrl.update(frameDt, manual);
    simSec += frameDt * 5;

    if (tel.sideBoostersSeparated) sawSideBoosterSep = true;
    if (tel.stageSeparated) sawStageSep = true;
    if ((tel.booster.landingLegsDeployed ?? 0) > 0.8) sawBoosterLegsDeployed = true;
    if (tel.phase === "CRASHED") break;

    const boosterDone =
      !veh.rtlsCapable
        ? tel.booster.status === "BOOSTER_EXPENDED"
        : tel.booster.status === "BOOSTER_CAUGHT" ||
          tel.booster.status === "BOOSTER_LANDED" ||
          tel.booster.status === "BOOSTER_CRASHED";

    if (tel.orbital.orbitAchieved && boosterDone) {
      break;
    }
  }

  return {
    finalTel: tel,
    sawSideBoosterSep,
    sawStageSep,
    sawBoosterLegsDeployed,
  };
}

describe("Stage 6C: Global Earth Launch Sites & Rocket Fleet", () => {
  it("defines 6 distinct Earth spaceports with orthonormal ENU frames aligning +Y to surface normal", () => {
    expect(EARTH_LAUNCH_SITES).toHaveLength(6);
    const coords = new Set(EARTH_LAUNCH_SITES.map((s) => `${s.latDeg.toFixed(3)},${s.lonDeg.toFixed(3)}`));
    expect(coords.size).toBe(6);

    const zenith = new THREE.Vector3(0, 1, 0);
    for (const site of EARTH_LAUNCH_SITES) {
      const [nx, ny, nz] = geoToSphereUnitVector(site.latDeg, site.lonDeg);
      const expectedNormal = new THREE.Vector3(nx, ny, nz);
      const q = computeLaunchSiteZenithQuaternion(site.latDeg, site.lonDeg);
      const rotatedNormal = expectedNormal.clone().applyQuaternion(q);
      expect(rotatedNormal.distanceTo(zenith)).toBeLessThan(1e-6);
      expect(Math.abs(q.length() - 1)).toBeLessThan(1e-6);
    }
  });

  it("models Baikonur inland arid steppe without ocean and rotates coastal sites accurately", () => {
    const earth = getPlanetConfig("earth");
    const noise = new SeededNoise2D(earth.terrain.seed);
    const baikonur = getLaunchSiteConfig("baikonur");
    expect(baikonur.hasOcean).toBe(false);
    for (const [x, z] of [
      [-6000, 0],
      [0, 0],
      [6000, 0],
      [0, -6000],
      [0, 6000],
      [4000, 4000],
    ] as Array<[number, number]>) {
      const h = samplePlanetTerrainHeight(x, z, earth, noise, baikonur);
      const localRelief = h - computeCurvedSurfaceDrop(Math.hypot(x, z), earth.scale.simRadiusM);
      expect(localRelief).toBeGreaterThanOrEqual(0);
    }

    const starbase = getLaunchSiteConfig("starbase");
    expect(samplePlanetTerrainHeight(3500, 0, earth, noise, starbase)).toBeLessThan(-1);
    expect(samplePlanetTerrainHeight(-2500, 0, earth, noise, starbase)).toBeGreaterThan(0);

    const kourou = getLaunchSiteConfig("kourou");
    // coastAzimuthDeg = 45 (NE): (+X, -Z) is Atlantic ocean; (-X, +Z) is South American jungle
    expect(samplePlanetTerrainHeight(2500, -2500, earth, noise, kourou)).toBeLessThan(-1);
    expect(samplePlanetTerrainHeight(-2500, 2500, earth, noise, kourou)).toBeGreaterThan(0);
  });

  it("Starship + Super Heavy reaches 200 km Earth LEO from Starbase and achieves Booster RTLS catch", () => {
    const res = runHeadlessLaunch("starship", "starbase");
    const { finalTel } = res;
    expect(finalTel.phase).not.toBe("CRASHED");
    expect(res.sawStageSep).toBe(true);
    expect(finalTel.orbital.orbitAchieved).toBe(true);
    expect(finalTel.orbital.periapsisAltM).toBeGreaterThan(140_000);
    expect(finalTel.orbital.apoapsisAltM).toBeGreaterThan(180_000);
    expect(finalTel.orbital.orbitalSpeedMps).toBeGreaterThan(7_400);
    expect(finalTel.booster.status).toBe("BOOSTER_CAUGHT");
    expect(finalTel.booster.touchdownOffsetM ?? 999).toBeLessThan(10);
  });

  it("Falcon 9 Block 5 reaches Earth LEO from KSC LC-39A and lands booster with deployed legs", () => {
    const res = runHeadlessLaunch("falcon9", "ksc_lc39a");
    const { finalTel } = res;
    expect(finalTel.phase).not.toBe("CRASHED");
    expect(res.sawStageSep).toBe(true);
    expect(res.sawBoosterLegsDeployed).toBe(true);
    expect(finalTel.orbital.orbitAchieved).toBe(true);
    expect(finalTel.orbital.periapsisAltM).toBeGreaterThan(140_000);
    expect(finalTel.orbital.apoapsisAltM).toBeGreaterThan(180_000);
    expect(finalTel.booster.status).toBe("BOOSTER_LANDED");
    expect(finalTel.booster.touchdownOffsetM ?? 999).toBeLessThan(10);
  });

  it("ISRO LVM3 separates twin S200 side boosters and reaches Earth LEO from Sriharikota", () => {
    const res = runHeadlessLaunch("lvm3", "sriharikota");
    const { finalTel } = res;
    expect(finalTel.phase).not.toBe("CRASHED");
    expect(res.sawSideBoosterSep).toBe(true);
    expect(res.sawStageSep).toBe(true);
    expect(finalTel.orbital.orbitAchieved).toBe(true);
    expect(finalTel.orbital.periapsisAltM).toBeGreaterThan(140_000);
    expect(finalTel.orbital.apoapsisAltM).toBeGreaterThan(180_000);
    expect(finalTel.booster.status).toBe("BOOSTER_EXPENDED");
  });

  it("NASA Saturn V reaches Earth LEO from KSC LC-39A", () => {
    const res = runHeadlessLaunch("saturn5", "ksc_lc39a");
    const { finalTel } = res;
    expect(finalTel.phase).not.toBe("CRASHED");
    expect(res.sawStageSep).toBe(true);
    expect(finalTel.orbital.orbitAchieved).toBe(true);
    expect(finalTel.orbital.periapsisAltM).toBeGreaterThan(140_000);
    expect(finalTel.orbital.apoapsisAltM).toBeGreaterThan(180_000);
    expect(finalTel.booster.status).toBe("BOOSTER_EXPENDED");
  });
});
