import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { getPlanetConfig } from "../config/planets";
import {
  CameraDirector,
  type CameraDirectorState,
  type CameraMode,
  type CameraSceneContext,
  type TrackTarget,
} from "../scene/CameraDirector";
import { type FlightTelemetry, FlightController } from "../sim/FlightController";

function makeRig(tel: FlightTelemetry) {
  const vehicleRoot = new THREE.Group();
  vehicleRoot.rotation.order = "YXZ";
  const detachedBoosterRoot = new THREE.Group();
  detachedBoosterRoot.rotation.order = "YXZ";

  const boosterGroup = new THREE.Group();
  const shipGroup = new THREE.Group();

  if (tel.stageSeparated) {
    vehicleRoot.add(shipGroup);
    detachedBoosterRoot.add(boosterGroup);
    shipGroup.position.set(0, 0, 0);
  } else {
    vehicleRoot.add(boosterGroup, shipGroup);
    shipGroup.position.set(0, 71, 0);
  }

  vehicleRoot.position.set(tel.position.x, tel.position.y, tel.position.z);
  vehicleRoot.rotation.set(tel.roll, tel.yaw, -tel.pitch);
  detachedBoosterRoot.position.set(
    tel.booster.position.x,
    tel.booster.position.y,
    tel.booster.position.z
  );
  detachedBoosterRoot.rotation.set(tel.booster.roll, tel.booster.yaw, -tel.booster.pitch);
  vehicleRoot.updateMatrixWorld(true);
  detachedBoosterRoot.updateMatrixWorld(true);

  return {
    vehicleRoot,
    detachedBoosterRoot,
    shipGroup,
    boosterGroup,
  };
}

function makeContext(
  tel: FlightTelemetry,
  stationWorldPos: THREE.Vector3 | null = new THREE.Vector3(350_000, 198_000, -120_000)
): CameraSceneContext {
  const rig = makeRig(tel);
  return {
    tel,
    baseTarget: new THREE.Vector3(0, 14, 0),
    stationWorldPos,
    shipGroup: rig.shipGroup,
    boosterGroup: rig.boosterGroup,
    vehicleRoot: rig.vehicleRoot,
    detachedBoosterRoot: rig.detachedBoosterRoot,
  };
}

function makeTelemetry(
  overrides: Omit<Partial<FlightTelemetry>, "booster"> & {
    booster?: Partial<FlightTelemetry["booster"]>;
  } = {}
): FlightTelemetry {
  const fc = new FlightController("earth", 2.2, "launch");
  const base = fc.getTelemetry();
  return {
    ...base,
    ...overrides,
    booster: {
      ...base.booster,
      ...(overrides.booster ?? {}),
    },
  };
}

function worldCamForward(camera: THREE.PerspectiveCamera, director: CameraDirector): {
  camWorld: THREE.Vector3;
  tgtWorld: THREE.Vector3;
  forward: THREE.Vector3;
} {
  const origin = director.getRenderOrigin();
  const camWorld = new THREE.Vector3(
    camera.position.x + origin.x,
    camera.position.y + origin.y,
    camera.position.z + origin.z
  );
  const tgtWorld = new THREE.Vector3(
    director.controls.target.x + origin.x,
    director.controls.target.y + origin.y,
    director.controls.target.z + origin.z
  );
  const forward = tgtWorld.clone().sub(camWorld).normalize();
  return { camWorld, tgtWorld, forward };
}

function activeAnchorWorld(ctx: CameraSceneContext, target: TrackTarget, forEngine: boolean): THREE.Vector3 {
  const { tel } = ctx;
  const boosterTarget = tel.missionMode === "launch" && target === "booster";
  const detached = boosterTarget && tel.stageSeparated && tel.booster.status !== "NONE";
  const useBoosterGroup = boosterTarget || (forEngine && tel.missionMode === "launch" && !tel.stageSeparated);
  const group = useBoosterGroup ? ctx.boosterGroup : ctx.shipGroup;
  const root = detached ? ctx.detachedBoosterRoot : ctx.vehicleRoot;
  const rootPos = detached ? tel.booster.position : tel.position;
  root.updateMatrixWorld(true);
  group.updateWorldMatrix(true, false);

  const localY = forEngine
    ? 0
    : useBoosterGroup
      ? 35.5
      : !tel.stageSeparated
        ? -12.0
        : 24.0;
  const out = new THREE.Vector3(0, localY, 0);
  group.localToWorld(out);
  out.x = out.x - root.position.x + rootPos.x;
  out.y = out.y - root.position.y + rootPos.y;
  out.z = out.z - root.position.z + rootPos.z;
  return out;
}

describe("CameraDirector — Authoritative State Machine & Guaranteed 3D Vehicle Framing", () => {
  it("synchronizes F1-F8 state transitions instantly, syncs Ship/Booster, and clears Auto on manual switch", () => {
    const cam = new THREE.PerspectiveCamera(52, 16 / 9, 0.5, 80_000_000);
    const director = new CameraDirector(cam, null);
    director.setPlanetRadius(getPlanetConfig("earth").scale.simRadiusM);

    const emitted: CameraDirectorState[] = [];
    director.setStateListener((s) => emitted.push(s));

    const ctx = makeContext(makeTelemetry({ running: true, tClockSec: 30 }));
    director.reLockOnVehicle(ctx);

    const modes: CameraMode[] = ["pad", "chase", "engine", "station", "free", "map", "booster"];
    for (const m of modes) {
      director.setMode(m, ctx);
      const st = director.getState();
      expect(st.mode).toBe(m);
      expect(st.autoDirector).toBe(false);
      if (m === "booster") {
        expect(st.trackTarget).toBe("booster");
      }
      expect(emitted[emitted.length - 1]).toEqual(st);
    }

    // Switching Ship while in F7 Booster moves cleanly to F2 Chase on Ship
    director.setTrackTarget("ship", ctx);
    expect(director.getMode()).toBe("chase");
    expect(director.getTrackTarget()).toBe("ship");

    // Switching Booster while in F3 Engine preserves Engine mode on Booster
    director.setMode("engine", ctx);
    director.setTrackTarget("booster", ctx);
    expect(director.getMode()).toBe("engine");
    expect(director.getTrackTarget()).toBe("booster");

    // Toggle F8 Auto on -> selecting F1 Pad turns F8 Auto off cleanly
    expect(director.toggleAutoDirector(ctx)).toBe(true);
    expect(director.getAutoDirector()).toBe(true);
    director.setMode("pad", ctx);
    expect(director.getAutoDirector()).toBe(false);
    expect(director.getMode()).toBe("pad");
  });

  it("frames both Ship and Booster accurately across pad, gravity turn, 90° orbit, and inverted boostback", () => {
    const R = getPlanetConfig("earth").scale.simRadiusM;
    const cam = new THREE.PerspectiveCamera(52, 16 / 9, 0.5, R * 12);
    const director = new CameraDirector(cam, null);
    director.setPlanetRadius(R);

    const scenarios: Array<{ name: string; tel: FlightTelemetry }> = [
      {
        name: "earth-pad",
        tel: makeTelemetry({ position: { x: 0, y: 2.2, z: 0 }, pitch: 0, yaw: 0, roll: 0 }),
      },
      {
        name: "gravity-turn-ascent",
        tel: makeTelemetry({
          running: true,
          stageSeparated: false,
          position: { x: 24_000, y: 35_000, z: -2_000 },
          altitudeM: 35_000,
          pitch: 0.72,
          yaw: -0.35,
          roll: 0.14,
          booster: {
            active: false,
            status: "ATTACHED",
            position: { x: 24_000, y: 35_000, z: -2_000 },
            pitch: 0.72,
            yaw: -0.35,
            roll: 0.14,
            altitudeM: 35_000,
          },
        }),
      },
      {
        name: "orbital-90deg-ship-and-inverted-boostback",
        tel: makeTelemetry({
          running: true,
          stageSeparated: true,
          position: { x: 900_000, y: 200_000 - 63_000, z: 50_000 },
          altitudeM: 200_000,
          pitch: Math.PI * 0.5,
          yaw: 0.28,
          roll: 0,
          booster: {
            active: true,
            status: "BOOSTER_BOOSTBACK",
            position: { x: 110_000, y: 74_000, z: -12_000 },
            pitch: -2.65,
            yaw: 0.22,
            roll: 0.05,
            altitudeM: 74_000,
          },
        }),
      },
    ];

    for (const sc of scenarios) {
      const ctx = makeContext(sc.tel);
      for (const target of ["ship", "booster"] as const) {
        director.setTrackTarget(target, ctx);

        // F2 Chase & F7 Booster (side-quarter view, zero plume alignment)
        const lockedModes: CameraMode[] =
          target === "booster" ? ["chase", "booster"] : ["chase"];
        for (const mode of lockedModes) {
          director.setMode(mode, ctx);
          director.setTrackTarget(target, ctx);
          if (mode === "booster") director.setMode("booster", ctx);

          const anchor = activeAnchorWorld(ctx, target, false);
          const { camWorld, forward } = worldCamForward(cam, director);
          expect(Number.isFinite(camWorld.x)).toBe(true);
          expect(Number.isFinite(camWorld.y)).toBe(true);
          expect(Number.isFinite(camWorld.z)).toBe(true);

          const toAnchor = anchor.clone().sub(camWorld);
          const dist = toAnchor.length();
          expect(dist).toBeGreaterThan(75);
          expect(dist).toBeLessThan(155);
          expect(forward.dot(toAnchor.normalize())).toBeGreaterThan(0.95);

          // Confirm camera is well off the exhaust vector (-bodyUp)
          const group = target === "booster" ? ctx.boosterGroup : ctx.shipGroup;
          const q = new THREE.Quaternion();
          group.getWorldQuaternion(q);
          const exhaustDir = new THREE.Vector3(0, -1, 0).applyQuaternion(q).normalize();
          const camOffsetDir = camWorld.clone().sub(anchor).normalize();
          expect(camOffsetDir.dot(exhaustDir)).toBeLessThan(0.75);
        }

        // F3 Engine (fuselage skirt mount looking at aft nozzle cluster)
        director.setMode("engine", ctx);
        const skirt = activeAnchorWorld(ctx, target, true);
        const engPose = worldCamForward(cam, director);
        const toSkirt = skirt.clone().sub(engPose.camWorld).normalize();
        expect(engPose.forward.dot(toSkirt)).toBeGreaterThan(0.86);
        expect(engPose.camWorld.distanceTo(skirt)).toBeGreaterThan(10);
        expect(engPose.camWorld.distanceTo(skirt)).toBeLessThan(20);

        // F5 Free tracks vehicle center cleanly
        director.setMode("free", ctx);
        const freePose = worldCamForward(cam, director);
        const freeAnchor = activeAnchorWorld(ctx, target, false);
        expect(freePose.forward.dot(freeAnchor.clone().sub(freePose.camWorld).normalize())).toBeGreaterThan(
          0.98
        );
      }
    }
  });

  it("frames F4 Station closely, emits F1 Pad range hint past 8 km, and aims F6 Map at active hemisphere", () => {
    const R = getPlanetConfig("earth").scale.simRadiusM;
    const cam = new THREE.PerspectiveCamera(52, 16 / 9, 0.5, R * 12);
    const director = new CameraDirector(cam, null);
    director.setPlanetRadius(R);

    const stationPos = new THREE.Vector3(420_000, 198_000, -180_000);
    const nearCtx = makeContext(makeTelemetry({ position: { x: 0, y: 500, z: 0 }, altitudeM: 500 }), stationPos);

    // F4 Station
    director.setMode("station", nearCtx);
    const stPose = worldCamForward(cam, director);
    const distStation = stPose.camWorld.distanceTo(stationPos);
    expect(distStation).toBeGreaterThan(60);
    expect(distStation).toBeLessThan(140);
    expect(stPose.forward.dot(stationPos.clone().sub(stPose.camWorld).normalize())).toBeGreaterThan(0.99);

    // F1 Pad: near pad -> no hint; 24 km away -> crisp hint
    director.setMode("pad", nearCtx);
    expect(director.getState().padRangeHint).toBeNull();
    const farCtx = makeContext(
      makeTelemetry({ position: { x: 18_000, y: 16_000, z: 0 }, altitudeM: 16_000 }),
      stationPos
    );
    director.setMode("pad", farCtx);
    expect(director.getState().padRangeHint).toContain("PAD VIEW");
    expect(director.getState().padRangeHint).toContain("F2 Chase");

    // F6 Map: must be on the SAME hemisphere as the active vehicle everywhere around the globe
    const planetCenter = new THREE.Vector3(0, -R, 0);
    for (const pos of [
      { x: 0, y: 10, z: 0 },
      { x: 950_000, y: 120_000, z: 120_000 },
      { x: -3_500_000, y: -2_000_000, z: 2_500_000 },
    ]) {
      const mCtx = makeContext(makeTelemetry({ position: pos, altitudeM: 200_000 }), stationPos);
      director.setMode("map", mCtx);
      const mapPose = worldCamForward(cam, director);
      const camRadial = mapPose.camWorld.clone().sub(planetCenter).normalize();
      const vehRadial = new THREE.Vector3(pos.x, pos.y, pos.z).sub(planetCenter).normalize();
      expect(camRadial.dot(vehRadial)).toBeGreaterThan(0.7);
    }
  });

  it("maintains zero horizon roll (< 0.01 deg) across 0..315 deg horizontal drag in F5 Free, F6 Map, and orbital inspect", () => {
    const R = getPlanetConfig("earth").scale.simRadiusM;
    const cam = new THREE.PerspectiveCamera(52, 16 / 9, 0.5, R * 26);
    const director = new CameraDirector(cam, null);
    director.setPlanetRadius(R);

    const ctx = makeContext(makeTelemetry({ position: { x: 0, y: 18.0, z: 0 }, altitudeM: 0 }));
    director.setMode("free", ctx);

    const radius = Math.hypot(cam.position.x, cam.position.z);
    const camY = cam.position.y;
    const azimuthsDeg = [0, 45, 90, 135, 180, 225, 270, 315];

    for (const deg of azimuthsDeg) {
      const rad = THREE.MathUtils.degToRad(deg);
      cam.position.set(Math.sin(rad) * radius, camY, Math.cos(rad) * radius);
      director.update(1 / 60, ctx);
      cam.updateMatrixWorld(true);

      // Camera local +X (right vector) must stay strictly horizontal (y = 0) -> zero roll!
      const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
      const rollDeg = Math.abs(THREE.MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, camRight.y)))));
      expect(rollDeg).toBeLessThan(0.01);
    }

    // Verify F6 Map & orbital inspect also keep strictly level horizon across horizontal sweep
    director.setMode("map", ctx);
    const mapR = Math.hypot(cam.position.x, cam.position.z);
    const mapY = cam.position.y;
    for (const deg of azimuthsDeg) {
      const rad = THREE.MathUtils.degToRad(deg);
      cam.position.set(Math.sin(rad) * mapR, mapY, Math.cos(rad) * mapR);
      director.update(1 / 60, ctx);
      cam.updateMatrixWorld(true);
      const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
      const rollDeg = Math.abs(THREE.MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, camRight.y)))));
      expect(rollDeg).toBeLessThan(0.01);
    }

    // Verify spacecraft inspect distance scales proportionally to object bounding radius (ISS vs Sentinel-2A)
    const satWorld = new THREE.Vector3(1_200_000, 410_000, -500_000);
    director.focusOrbitalObject({ ...ctx, inspectedOrbitalPos: satWorld, inspectedOrbitalRadiusM: 56 });
    const issDist = cam.position.length();
    expect(issDist).toBeGreaterThan(80);
    expect(issDist).toBeLessThan(110);

    director.focusOrbitalObject({ ...ctx, inspectedOrbitalPos: satWorld, inspectedOrbitalRadiusM: 12 });
    const sentinelDist = cam.position.length();
    expect(sentinelDist).toBeGreaterThan(14);
    expect(sentinelDist).toBeLessThan(26);
  });
});
