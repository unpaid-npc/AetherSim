import gsap from "gsap";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { getVehicleConfig } from "../config/vehicles";
import type { FlightTelemetry } from "../sim/FlightController";
import { smoothstep } from "../utils/noise";

export type CameraMode =
  | "pad"
  | "chase"
  | "engine"
  | "station"
  | "free"
  | "map"
  | "booster";
export type CameraPreset = CameraMode;
export type CameraFocusMode = "rocket" | "base";
export type TrackTarget = "ship" | "booster";

export interface CameraDirectorState {
  readonly mode: CameraMode;
  readonly trackTarget: TrackTarget;
  readonly autoDirector: boolean;
  readonly padRangeM: number;
  readonly padRangeHint: string | null;
}

export interface CameraSceneContext {
  readonly tel: FlightTelemetry;
  readonly baseTarget: THREE.Vector3;
  readonly stationWorldPos: THREE.Vector3 | null;
  readonly inspectedOrbitalPos?: THREE.Vector3 | null;
  readonly inspectedOrbitalRadiusM?: number;
  readonly shipGroup: THREE.Object3D;
  readonly boosterGroup: THREE.Object3D;
  readonly vehicleRoot: THREE.Object3D;
  readonly detachedBoosterRoot: THREE.Object3D;
}

export interface OrbitControlsLike {
  target: THREE.Vector3;
  enabled: boolean;
  enableDamping: boolean;
  dampingFactor: number;
  minDistance: number;
  maxDistance: number;
  maxPolarAngle: number;
  zoomSpeed: number;
  update(): void;
  dispose(): void;
}

interface LiveVehicleFrame {
  readonly useDetachedBooster: boolean;
  readonly activeGroup: THREE.Object3D;
  readonly activeRoot: THREE.Object3D;
  readonly rootWorldPos: { readonly x: number; readonly y: number; readonly z: number };
  readonly midHullWorld: THREE.Vector3;
  readonly aftSkirtWorld: THREE.Vector3;
  readonly bodyUp: THREE.Vector3;
  readonly radialUp: THREE.Vector3;
  readonly east: THREE.Vector3;
  readonly south: THREE.Vector3;
  readonly horizDir: THREE.Vector3;
  readonly altitudeM: number;
  readonly hullRadiusM: number;
  readonly chaseSideDistM: number;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function createHeadlessControls(camera: THREE.PerspectiveCamera): OrbitControlsLike {
  const target = new THREE.Vector3();
  return {
    target,
    enabled: true,
    enableDamping: false,
    dampingFactor: 0.07,
    minDistance: 25,
    maxDistance: 100_000_000,
    maxPolarAngle: Math.PI * 0.495,
    zoomSpeed: 1,
    update: () => {
      camera.lookAt(target);
    },
    dispose: () => {},
  };
}

/**
 * Authoritative camera state machine and live-matrix framing director:
 * - Single source of truth for `{ mode, trackTarget, autoDirector, padRangeM, padRangeHint }`.
 * - Synchronous zero-lag state transitions (kills all active GSAP tweens on every switch).
 * - Float64 camera-relative `renderOrigin` with live Three.js matrix vehicle framing across 0 m..orbit.
 */
export class CameraDirector {
  public readonly controls: OrbitControlsLike;
  private readonly camera: THREE.PerspectiveCamera;

  private mode: CameraMode = "free";
  private focusMode: CameraFocusMode = "rocket";
  private trackTarget: TrackTarget = "ship";
  private autoDirector = false;
  private padRangeM = 0;
  private padRangeHint: string | null = null;
  private lastEmittedHintKey = "";

  private simRadiusM = 6_371_000;
  private globeBlend = 0;
  private lastNear = 0.5;
  private lastFar = 80_000_000;
  private initialized = false;
  private inspectingOrbital = false;
  private inspectedMinDist = 12;
  private readonly renderOrigin = { x: 0, y: 0, z: 0 };
  private readonly prevTrackedWorld = new THREE.Vector3();
  private readonly prevInspectedWorld = new THREE.Vector3();
  private stateListener: ((state: CameraDirectorState) => void) | null = null;

  // Scratch vectors to avoid per-frame allocations
  private readonly sQuat = new THREE.Quaternion();
  private readonly sTmpA = new THREE.Vector3();
  private readonly sTmpB = new THREE.Vector3();
  private readonly sTmpC = new THREE.Vector3();
  private readonly sTmpD = new THREE.Vector3();
  private readonly sPlanetCenter = new THREE.Vector3();
  private readonly sAftLocal = new THREE.Vector3(0, 0, 0);
  private readonly sMidLocal = new THREE.Vector3(0, 0, 0);
  private readonly sEngCamLocal = new THREE.Vector3(8.5, 12.0, 0);
  private readonly sEngTgtLocal = new THREE.Vector3(0, -35.0, 0);
  private readonly sCamWorld = new THREE.Vector3();
  private readonly sTgtWorld = new THREE.Vector3();
  private readonly sUpWorld = new THREE.Vector3(0, 1, 0);

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement | null) {
    this.camera = camera;
    if (canvas) {
      const orbit = new OrbitControls(this.camera, canvas);
      orbit.enableDamping = true;
      orbit.dampingFactor = 0.07;
      orbit.minDistance = 25;
      orbit.maxDistance = this.simRadiusM * 3.8;
      orbit.maxPolarAngle = Math.PI * 0.495;
      this.controls = orbit;
    } else {
      this.controls = createHeadlessControls(this.camera);
    }
  }

  setStateListener(listener: ((state: CameraDirectorState) => void) | null): void {
    this.stateListener = listener;
    if (listener) {
      listener(this.getState());
    }
  }

  getState(): CameraDirectorState {
    return {
      mode: this.mode,
      trackTarget: this.trackTarget,
      autoDirector: this.autoDirector,
      padRangeM: this.padRangeM,
      padRangeHint: this.padRangeHint,
    };
  }

  private emitState(): void {
    this.lastEmittedHintKey = this.padRangeHint ?? "";
    this.stateListener?.(this.getState());
  }

  getRenderOrigin(): { readonly x: number; readonly y: number; readonly z: number } {
    return this.renderOrigin;
  }

  getCameraWorldPosition(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(
      this.camera.position.x + this.renderOrigin.x,
      this.camera.position.y + this.renderOrigin.y,
      this.camera.position.z + this.renderOrigin.z
    );
  }

  setPlanetRadius(simRadiusM: number): void {
    this.simRadiusM = Math.max(1000, simRadiusM);
    if (this.mode === "map") {
      this.controls.minDistance = this.simRadiusM * 1.15;
      this.controls.maxDistance = this.simRadiusM * 12.0;
    } else {
      this.controls.minDistance = 25;
      this.controls.maxDistance = this.simRadiusM * 10.0;
    }
    const desiredFar = Math.max(500_000, this.simRadiusM * 26);
    this.camera.far = desiredFar;
    this.lastFar = desiredFar;
    this.camera.updateProjectionMatrix();
  }

  getMode(): CameraMode {
    return this.mode;
  }

  getPreset(): CameraPreset {
    return this.mode;
  }

  getFocusMode(): CameraFocusMode {
    return this.focusMode;
  }

  getTrackTarget(): TrackTarget {
    return this.trackTarget;
  }

  getAutoDirector(): boolean {
    return this.autoDirector;
  }

  setFocusMode(mode: CameraFocusMode, ctx: CameraSceneContext): void {
    this.inspectingOrbital = false;
    this.focusMode = mode;
    this.autoDirector = false;
    this.mode = "free";
    this.applyInstantModeSnap(ctx);
    this.emitState();
  }

  setMode(mode: CameraMode, ctx: CameraSceneContext, fromAuto = false): void {
    this.killActiveTweens();
    this.inspectingOrbital = false;
    if (!fromAuto) {
      this.autoDirector = false;
    }
    this.mode = mode;
    if (mode === "booster") {
      this.trackTarget = "booster";
      this.focusMode = "rocket";
    } else if (mode === "chase" || mode === "engine") {
      this.focusMode = "rocket";
    }
    this.applyInstantModeSnap(ctx);
    this.emitState();
  }

  /** Backwards-compatible alias for `setMode`. */
  setPreset(preset: CameraPreset, ctx: CameraSceneContext): void {
    this.setMode(preset, ctx, false);
  }

  setTrackTarget(target: TrackTarget, ctx: CameraSceneContext): void {
    this.killActiveTweens();
    this.inspectingOrbital = false;
    this.autoDirector = false;
    this.focusMode = "rocket";
    this.trackTarget = target;
    if (target === "ship" && this.mode === "booster") {
      this.mode = "chase";
    }
    this.applyInstantModeSnap(ctx);
    this.emitState();
  }

  setAutoDirector(enabled: boolean, ctx?: CameraSceneContext): void {
    this.autoDirector = enabled;
    if (enabled) {
      this.inspectingOrbital = false;
    }
    if (enabled && ctx) {
      const desired = this.computeAutoDesiredMode(ctx.tel);
      if (desired !== this.mode) {
        this.setMode(desired, ctx, true);
        return;
      }
    }
    this.emitState();
  }

  toggleAutoDirector(ctx: CameraSceneContext): boolean {
    this.setAutoDirector(!this.autoDirector, ctx);
    return this.autoDirector;
  }

  reLockOnVehicle(ctx: CameraSceneContext): void {
    this.killActiveTweens();
    this.inspectingOrbital = false;
    this.focusMode = "rocket";
    this.applyInstantModeSnap(ctx);
    this.emitState();
  }

  focusOrbitalObject(ctx: CameraSceneContext): void {
    const satPos = ctx.inspectedOrbitalPos;
    if (!satPos) {
      return;
    }
    this.killActiveTweens();
    this.autoDirector = false;
    this.mode = "free";
    this.inspectingOrbital = true;
    this.padRangeHint = null;
    this.padRangeM = 0;
    this.globeBlend = 0;

    const radius = ctx.inspectedOrbitalRadiusM ?? 32;
    const inspectDist = clamp(radius * 1.7, 14, 105);
    this.inspectedMinDist = clamp(radius * 0.55, 6, 36);

    const desiredFar = Math.max(500_000, this.simRadiusM * 26);
    this.controls.enabled = true;
    this.controls.minDistance = this.inspectedMinDist;
    this.controls.maxDistance = this.simRadiusM * 10.0;
    this.controls.maxPolarAngle = Math.PI * 0.96;
    this.controls.zoomSpeed = 1.05;

    this.renderOrigin.x = satPos.x;
    this.renderOrigin.y = satPos.y;
    this.renderOrigin.z = satPos.z;
    this.prevInspectedWorld.copy(satPos);

    // Hero 3/4 sunlit framing with strictly level world-up (0, 1, 0) for roll-free OrbitControls
    this.camera.position.set(
      inspectDist * 0.68,
      inspectDist * 0.34,
      inspectDist * 0.65
    );
    this.controls.target.set(0, 0, 0);
    this.camera.up.set(0, 1, 0);
    this.adaptClipPlanes(0, desiredFar, true);
    this.camera.fov = 48;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.initialized = true;
    this.emitState();
  }

  isInspectingOrbital(): boolean {
    return this.inspectingOrbital;
  }

  private killActiveTweens(): void {
    gsap.killTweensOf(this.camera.position);
    gsap.killTweensOf(this.controls.target);
    gsap.killTweensOf(this.camera.up);
  }

  private rebaseRenderOrigin(nextX: number, nextY: number, nextZ: number): void {
    const dx = nextX - this.renderOrigin.x;
    const dy = nextY - this.renderOrigin.y;
    const dz = nextZ - this.renderOrigin.z;
    if (dx === 0 && dy === 0 && dz === 0) {
      return;
    }
    this.renderOrigin.x = nextX;
    this.renderOrigin.y = nextY;
    this.renderOrigin.z = nextZ;
    this.camera.position.set(
      this.camera.position.x - dx,
      this.camera.position.y - dy,
      this.camera.position.z - dz
    );
    this.controls.target.set(
      this.controls.target.x - dx,
      this.controls.target.y - dy,
      this.controls.target.z - dz
    );
  }

  private localToWorldFloat64(
    group: THREE.Object3D,
    root: THREE.Object3D,
    rootWorldPos: { readonly x: number; readonly y: number; readonly z: number },
    localPoint: THREE.Vector3,
    out: THREE.Vector3
  ): THREE.Vector3 {
    out.copy(localPoint);
    group.localToWorld(out);
    out.x = out.x - root.position.x + rootWorldPos.x;
    out.y = out.y - root.position.y + rootWorldPos.y;
    out.z = out.z - root.position.z + rootWorldPos.z;
    return out;
  }

  private resolveLiveVehicleFrame(
    ctx: CameraSceneContext,
    target: TrackTarget,
    forEngine = false
  ): LiveVehicleFrame {
    const { tel } = ctx;
    const isLaunch = tel.missionMode === "launch";
    const boosterAvailable = isLaunch && target === "booster";
    const useDetachedBooster =
      boosterAvailable && tel.stageSeparated && tel.booster.status !== "NONE";

    // Pre-separation Engine cam uses Stage 1 booster skirt if ship is selected while Stage 1 fires
    const useBoosterGroup =
      boosterAvailable || (forEngine && isLaunch && !tel.stageSeparated);

    const activeGroup = useBoosterGroup ? ctx.boosterGroup : ctx.shipGroup;
    const activeRoot = useDetachedBooster ? ctx.detachedBoosterRoot : ctx.vehicleRoot;
    const rootWorldPos = useDetachedBooster ? tel.booster.position : tel.position;

    activeRoot.updateMatrixWorld(true);
    activeGroup.updateWorldMatrix(true, false);
    activeGroup.getWorldQuaternion(this.sQuat);

    const aftSkirtWorld = this.localToWorldFloat64(
      activeGroup,
      activeRoot,
      rootWorldPos,
      this.sAftLocal,
      new THREE.Vector3()
    );

    const veh = getVehicleConfig(tel.vehicleId);
    const midY = useBoosterGroup
      ? veh.boosterMidY
      : isLaunch && !tel.stageSeparated
        ? veh.stackMidY - veh.stage1HeightM
        : veh.shipMidY;
    this.sMidLocal.set(0, midY, 0);
    const midHullWorld = this.localToWorldFloat64(
      activeGroup,
      activeRoot,
      rootWorldPos,
      this.sMidLocal,
      new THREE.Vector3()
    );

    const bodyUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.sQuat).normalize();
    this.sPlanetCenter.set(0, -this.simRadiusM, 0);
    const radialUp = midHullWorld.clone().sub(this.sPlanetCenter);
    if (radialUp.lengthSq() > 1e-6) {
      radialUp.normalize();
    } else {
      radialUp.set(0, 1, 0);
    }

    // Local tangent East/South basis around radialUp
    this.sTmpA.set(0, 0, 1);
    const east = new THREE.Vector3().crossVectors(this.sTmpA, radialUp);
    if (east.lengthSq() < 1e-5) {
      east.set(1, 0, 0);
    } else {
      east.normalize();
    }
    const south = new THREE.Vector3().crossVectors(east, radialUp).normalize();

    // Guaranteed 3/4 side-quarter horizontal offset >= 50 deg off exhaust direction (-bodyUp)
    const defaultQuarter = this.sTmpB
      .copy(south)
      .multiplyScalar(0.81)
      .addScaledVector(east, -0.58)
      .normalize();

    const exhaustDir = this.sTmpC.copy(bodyUp).negate();
    const horizExh = this.sTmpD
      .copy(exhaustDir)
      .addScaledVector(radialUp, -exhaustDir.dot(radialUp));
    const horizExhLen = horizExh.length();

    const horizDir = defaultQuarter.clone();
    if (horizExhLen > 0.1) {
      const aftH = horizExh.clone().divideScalar(horizExhLen);
      const sideH = new THREE.Vector3().crossVectors(radialUp, aftH).normalize();
      if (sideH.dot(south) < 0) {
        sideH.negate();
      }
      const angledQuarter = sideH.multiplyScalar(0.82).addScaledVector(aftH, 0.57).normalize();
      const blend = smoothstep(0.1, 0.45, horizExhLen);
      horizDir.lerp(angledQuarter, blend).normalize();
    }

    const altitudeM = useDetachedBooster ? tel.booster.altitudeM : tel.altitudeM;
    const chaseSideDistM = clamp(veh.heightM * 0.92, 68, 122);

    return {
      useDetachedBooster,
      activeGroup,
      activeRoot,
      rootWorldPos,
      midHullWorld,
      aftSkirtWorld,
      bodyUp,
      radialUp,
      east,
      south,
      horizDir,
      altitudeM,
      hullRadiusM: veh.hullRadiusM,
      chaseSideDistM,
    };
  }

  private orthonormalUp(forward: THREE.Vector3, preferredUp: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.copy(preferredUp).addScaledVector(forward, -preferredUp.dot(forward));
    if (out.lengthSq() > 1e-6) {
      return out.normalize();
    }
    this.sTmpA.set(0, 0, 1);
    if (Math.abs(forward.dot(this.sTmpA)) > 0.92) {
      this.sTmpA.set(1, 0, 0);
    }
    return out.crossVectors(this.sTmpA, forward).normalize();
  }

  private computePadPose(frame: LiveVehicleFrame, ctx: CameraSceneContext): { fov: number } {
    const { tel } = ctx;
    const isEarth = tel.planetId === "earth";
    this.sCamWorld.set(isEarth ? -118 : 118, tel.padDeckY + 22, 122);
    this.padRangeM = this.sCamWorld.distanceTo(frame.midHullWorld);

    if (this.padRangeM > 8000) {
      const kmText = (this.padRangeM / 1000).toFixed(1);
      this.padRangeHint = `PAD VIEW · Vehicle ${kmText} km away — press F2 Chase or F6 Map`;
      // Clamp vertical aim elevation cleanly so high-altitude orbital ships stay framed over horizon
      const toVeh = this.sTmpA.copy(frame.midHullWorld).sub(this.sCamWorld);
      const horizLen = Math.max(1, Math.hypot(toVeh.x, toVeh.z));
      const clampedY = Math.min(toVeh.y, horizLen * 0.52);
      this.sTgtWorld.set(
        this.sCamWorld.x + (toVeh.x / horizLen) * 500,
        this.sCamWorld.y + (clampedY / horizLen) * 500,
        this.sCamWorld.z + (toVeh.z / horizLen) * 500
      );
      this.sUpWorld.set(0, 1, 0);
      return { fov: 46 };
    }

    this.padRangeHint = null;
    this.sTgtWorld.copy(frame.midHullWorld);
    if (this.sTgtWorld.y < tel.padDeckY + 14) {
      this.sTgtWorld.y = tel.padDeckY + 14;
    }
    const zoomT = clamp((this.padRangeM - 175) / 6000, 0, 1);
    this.sUpWorld.set(0, 1, 0);
    return { fov: 52 - zoomT * 22 };
  }

  private computeChaseOrBoosterPose(
    mode: "chase" | "booster",
    frame: LiveVehicleFrame,
    tel: FlightTelemetry
  ): { fov: number } {
    this.padRangeHint = null;
    this.padRangeM = 0;

    const sideDist = mode === "booster" ? Math.max(66, frame.chaseSideDistM * 0.92) : frame.chaseSideDistM;
    const upDist = Math.max(22, sideDist * 0.31);

    this.sTgtWorld.copy(frame.midHullWorld);
    this.sCamWorld
      .copy(frame.midHullWorld)
      .addScaledVector(frame.horizDir, sideDist)
      .addScaledVector(frame.radialUp, upDist);

    if (frame.altitudeM < 200 && this.sCamWorld.y < tel.padDeckY + 12) {
      this.sCamWorld.y = tel.padDeckY + 12;
    }

    this.sUpWorld.copy(frame.radialUp);
    return { fov: 50 };
  }

  private computeEnginePose(frame: LiveVehicleFrame): { fov: number } {
    this.padRangeHint = null;
    this.padRangeM = 0;

    this.sEngCamLocal.set(
      frame.hullRadiusM + 4.0,
      Math.min(12.0, frame.hullRadiusM * 2.6 + 2.5),
      0
    );
    this.sEngTgtLocal.set(0, -Math.max(24, frame.hullRadiusM * 7.2), 0);

    this.localToWorldFloat64(
      frame.activeGroup,
      frame.activeRoot,
      frame.rootWorldPos,
      this.sEngCamLocal,
      this.sCamWorld
    );
    this.localToWorldFloat64(
      frame.activeGroup,
      frame.activeRoot,
      frame.rootWorldPos,
      this.sEngTgtLocal,
      this.sTgtWorld
    );

    // Keep stainless hull at top of viewport andMach-diamond plume streaming downward
    const forward = this.sTmpA.copy(this.sTgtWorld).sub(this.sCamWorld).normalize();
    this.orthonormalUp(forward, frame.bodyUp, this.sUpWorld);
    return { fov: 64 };
  }

  private computeStationPose(ctx: CameraSceneContext): { fov: number } {
    this.padRangeHint = null;
    this.padRangeM = 0;

    const stationPos = ctx.stationWorldPos;
    if (!stationPos) {
      this.sTgtWorld.copy(ctx.baseTarget).add(new THREE.Vector3(0, 60, 0));
      this.sCamWorld.copy(this.sTgtWorld).add(new THREE.Vector3(-80, 32, 85));
      this.sUpWorld.set(0, 1, 0);
      return { fov: 48 };
    }

    this.sTgtWorld.copy(stationPos);
    this.sPlanetCenter.set(0, -this.simRadiusM, 0);
    const radialUp = this.sTmpA.copy(stationPos).sub(this.sPlanetCenter);
    if (radialUp.lengthSq() > 1e-6) {
      radialUp.normalize();
    } else {
      radialUp.set(0, 1, 0);
    }

    this.sTmpB.set(0, 0, 1);
    const east = this.sTmpC.crossVectors(this.sTmpB, radialUp);
    if (east.lengthSq() < 1e-5) {
      east.set(1, 0, 0);
    } else {
      east.normalize();
    }
    const south = this.sTmpD.crossVectors(east, radialUp).normalize();

    this.sCamWorld
      .copy(stationPos)
      .addScaledVector(east, 68)
      .addScaledVector(south, 60)
      .addScaledVector(radialUp, 26);

    this.sUpWorld.copy(radialUp);
    return { fov: 48 };
  }

  private applyInstantModeSnap(ctx: CameraSceneContext): void {
    const frame = this.resolveLiveVehicleFrame(ctx, this.trackTarget, this.mode === "engine");
    const desiredFar = Math.max(500_000, this.simRadiusM * 26);
    this.globeBlend = 0;
    this.prevTrackedWorld.copy(frame.midHullWorld);

    if (this.mode === "map") {
      this.padRangeHint = null;
      this.padRangeM = 0;
      this.controls.enabled = true;
      this.controls.minDistance = this.simRadiusM * 1.15;
      this.controls.maxDistance = this.simRadiusM * 12.0;
      this.controls.maxPolarAngle = Math.PI * 0.96;
      this.controls.zoomSpeed = 1.6;

      this.renderOrigin.x = 0;
      this.renderOrigin.y = -this.simRadiusM;
      this.renderOrigin.z = 0;

      // Same-hemisphere framing over active vehicle / launch site with 28° 3D tilt
      this.sPlanetCenter.set(0, -this.simRadiusM, 0);
      const radial = this.sTmpA.copy(frame.midHullWorld).sub(this.sPlanetCenter);
      if (radial.lengthSq() > 1e-6) {
        radial.normalize();
      } else {
        radial.set(0, 1, 0);
      }

      const tiltPref = this.sTmpB.set(0.35, 0, 0.94);
      const tiltDir = tiltPref.addScaledVector(radial, -tiltPref.dot(radial));
      if (tiltDir.lengthSq() < 1e-5) {
        tiltDir.set(1, 0, 0).addScaledVector(radial, -radial.x);
      }
      tiltDir.normalize();

      const tiltRad = THREE.MathUtils.degToRad(28);
      const camDir = this.sTmpC
        .copy(radial)
        .multiplyScalar(Math.cos(tiltRad))
        .addScaledVector(tiltDir, Math.sin(tiltRad))
        .normalize();

      const mapDist = this.simRadiusM * 2.4;
      this.camera.position.copy(camDir).multiplyScalar(mapDist);
      this.controls.target.set(0, 0, 0);
      // Strictly keep world-up (0, 1, 0) aligned with OrbitControls' spherical axis -> zero drag roll
      this.camera.up.set(0, 1, 0);
      this.adaptClipPlanes(mapDist - this.simRadiusM, desiredFar);
      this.camera.fov = 46;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(this.controls.target);
      this.controls.update();
      this.initialized = true;
      return;
    }

    if (this.mode === "free") {
      this.padRangeHint = null;
      this.padRangeM = 0;
      this.controls.enabled = true;
      this.controls.minDistance = 25;
      this.controls.maxDistance = this.simRadiusM * 3.8;
      this.controls.maxPolarAngle = Math.PI * 0.495;
      this.controls.zoomSpeed = 1.0;

      const anchor =
        this.focusMode === "base" ? ctx.baseTarget : frame.midHullWorld;
      this.renderOrigin.x = anchor.x;
      this.renderOrigin.y = anchor.y;
      this.renderOrigin.z = anchor.z;

      const onPadLaunch =
        frame.altitudeM < 50 &&
        ctx.tel.missionMode === "launch" &&
        this.focusMode === "rocket";
      const onPadEarth = ctx.tel.planetId === "earth" && onPadLaunch;
      const onPadMars = ctx.tel.planetId === "mars" && onPadLaunch;

      if (onPadEarth) {
        this.sCamWorld.set(-96, 40, 106);
      } else if (onPadMars) {
        // Elevated look-down framing (+18 m over default) so camera never sits behind foreground crater hills
        this.sCamWorld
          .copy(frame.horizDir)
          .multiplyScalar(132)
          .addScaledVector(frame.radialUp, 62);
      } else {
        this.sCamWorld
          .copy(frame.horizDir)
          .multiplyScalar(132)
          .addScaledVector(frame.radialUp, 44);
      }

      this.controls.target.set(0, 0, 0);
      this.camera.position.copy(this.sCamWorld);
      // Strictly keep world-up (0, 1, 0) aligned with OrbitControls' spherical axis -> zero figure-8 roll
      this.camera.up.set(0, 1, 0);
      this.adaptClipPlanes(Math.max(25, frame.altitudeM), desiredFar);
      this.camera.fov = 52;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(this.controls.target);
      this.controls.update();
      this.initialized = true;
      return;
    }

    // Locked preset modes: pad | chase | engine | station | booster
    this.controls.enabled = false;
    let fov = 50;
    if (this.mode === "pad") {
      ({ fov } = this.computePadPose(frame, ctx));
    } else if (this.mode === "engine") {
      ({ fov } = this.computeEnginePose(frame));
    } else if (this.mode === "station") {
      ({ fov } = this.computeStationPose(ctx));
    } else {
      ({ fov } = this.computeChaseOrBoosterPose(this.mode, frame, ctx.tel));
    }

    this.renderOrigin.x = this.sTgtWorld.x;
    this.renderOrigin.y = this.sTgtWorld.y;
    this.renderOrigin.z = this.sTgtWorld.z;

    this.camera.position.set(
      this.sCamWorld.x - this.renderOrigin.x,
      this.sCamWorld.y - this.renderOrigin.y,
      this.sCamWorld.z - this.renderOrigin.z
    );
    this.controls.target.set(0, 0, 0);
    this.camera.up.copy(this.sUpWorld);
    const camAltM = Math.max(
      0,
      Math.hypot(this.sCamWorld.x, this.sCamWorld.y + this.simRadiusM, this.sCamWorld.z) -
        this.simRadiusM
    );
    this.adaptClipPlanes(camAltM, desiredFar);
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.controls.target);
    this.initialized = true;
  }

  private adaptClipPlanes(
    camAltM: number,
    desiredFar: number,
    forceCloseNear = false
  ): void {
    const closeSubject =
      forceCloseNear ||
      this.mode === "engine" ||
      this.mode === "station" ||
      this.mode === "chase" ||
      this.mode === "booster" ||
      this.inspectingOrbital;
    const desiredNear =
      this.mode === "engine"
        ? 0.35
        : closeSubject
          ? 0.5
          : clamp(camAltM * 0.0005, 0.5, 500);
    const nearChanged =
      Math.abs(desiredNear - this.lastNear) / Math.max(0.1, this.lastNear) > 0.05;
    const farChanged =
      Math.abs(desiredFar - this.lastFar) / Math.max(1, this.lastFar) > 0.05;
    if (nearChanged || farChanged) {
      this.camera.near = desiredNear;
      this.camera.far = desiredFar;
      this.lastNear = desiredNear;
      this.lastFar = desiredFar;
      this.camera.updateProjectionMatrix();
    }
  }

  private computeAutoDesiredMode(tel: FlightTelemetry): CameraMode {
    if (tel.missionMode !== "launch") {
      return tel.altitudeM > 140 ? "chase" : "pad";
    }
    if (tel.tClockSec < 18) {
      return "pad";
    }
    if (!tel.stageSeparated) {
      return "chase";
    }
    if (
      tel.booster.status === "BOOSTER_LANDING_BURN" ||
      tel.booster.status === "BOOSTER_DESCENT"
    ) {
      return "booster";
    }
    if (tel.orbital.orbitAchieved || tel.altitudeM >= 130_000) {
      return "map";
    }
    if (tel.shipThrottle > 0.05) {
      return "engine";
    }
    return "chase";
  }

  update(dt: number, ctx: CameraSceneContext): void {
    const { tel } = ctx;

    if (this.autoDirector && tel.running && !tel.paused) {
      const desired = this.computeAutoDesiredMode(tel);
      if (desired !== this.mode) {
        this.setMode(desired, ctx, true);
        return;
      }
    }

    if (!this.initialized) {
      this.applyInstantModeSnap(ctx);
      this.emitState();
      return;
    }

    const desiredFar = Math.max(500_000, this.simRadiusM * 26);
    const camWorld = this.getCameraWorldPosition(this.sTmpD);
    const camAltM = Math.max(
      0,
      Math.hypot(camWorld.x, camWorld.y + this.simRadiusM, camWorld.z) - this.simRadiusM
    );
    this.adaptClipPlanes(camAltM, desiredFar);

    if (this.mode === "map") {
      this.rebaseRenderOrigin(0, -this.simRadiusM, 0);
      this.camera.up.set(0, 1, 0);
      this.controls.enabled = true;
      this.controls.minDistance = this.simRadiusM * 1.15;
      this.controls.maxDistance = this.simRadiusM * 12.0;
      this.controls.maxPolarAngle = Math.PI * 0.96;
      const dist = this.camera.position.distanceTo(this.controls.target);
      this.controls.zoomSpeed = 1.0 + Math.min(2.2, Math.log10(Math.max(10, dist / 200)) * 0.65);
      this.controls.target.set(0, 0, 0);
      this.controls.update();
      return;
    }

    if (this.mode === "free" && this.inspectingOrbital && ctx.inspectedOrbitalPos) {
      this.camera.up.set(0, 1, 0);
      this.controls.enabled = true;
      this.controls.minDistance = this.inspectedMinDist;
      this.controls.maxDistance = this.simRadiusM * 10.0;
      this.controls.maxPolarAngle = Math.PI * 0.96;

      const satPos = ctx.inspectedOrbitalPos;
      const dx = satPos.x - this.prevInspectedWorld.x;
      const dy = satPos.y - this.prevInspectedWorld.y;
      const dz = satPos.z - this.prevInspectedWorld.z;
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        this.renderOrigin.x += dx;
        this.renderOrigin.y += dy;
        this.renderOrigin.z += dz;
      }
      this.prevInspectedWorld.copy(satPos);

      const dist = this.camera.position.distanceTo(this.controls.target);
      this.controls.zoomSpeed =
        1.0 + Math.min(2.2, Math.log10(Math.max(10, dist / 25)) * 0.55);
      this.controls.update();
      if (this.controls.target.length() > 500) {
        this.rebaseRenderOrigin(
          this.renderOrigin.x + this.controls.target.x,
          this.renderOrigin.y + this.controls.target.y,
          this.renderOrigin.z + this.controls.target.z
        );
      }
      return;
    }

    const frame = this.resolveLiveVehicleFrame(ctx, this.trackTarget, this.mode === "engine");

    if (this.mode === "free") {
      this.camera.up.set(0, 1, 0);
      this.controls.enabled = true;
      this.controls.minDistance = 25;
      this.controls.maxDistance = this.simRadiusM * 3.8;

      const worldAnchor =
        this.focusMode === "base" ? ctx.baseTarget : frame.midHullWorld;

      const localAnchorX = worldAnchor.x - this.renderOrigin.x;
      const localAnchorY = worldAnchor.y - this.renderOrigin.y;
      const localAnchorZ = worldAnchor.z - this.renderOrigin.z;
      const distFromAnchor = Math.hypot(
        this.camera.position.x - localAnchorX,
        this.camera.position.y - localAnchorY,
        this.camera.position.z - localAnchorZ
      );

      this.controls.zoomSpeed =
        1.0 + Math.min(2.0, Math.log10(Math.max(10, distFromAnchor / 25)) * 0.55);
      const polarT = smoothstep(0.02 * this.simRadiusM, 0.14 * this.simRadiusM, distFromAnchor);
      this.controls.maxPolarAngle = Math.PI * (0.495 + 0.465 * polarT);

      const desiredBlend = smoothstep(0.08 * this.simRadiusM, 0.35 * this.simRadiusM, distFromAnchor);
      this.globeBlend += (desiredBlend - this.globeBlend) * Math.min(1, dt * 6.0);

      if (this.focusMode === "rocket") {
        const dx = frame.midHullWorld.x - this.prevTrackedWorld.x;
        const dy = frame.midHullWorld.y - this.prevTrackedWorld.y;
        const dz = frame.midHullWorld.z - this.prevTrackedWorld.z;
        const trackWeight = 1 - this.globeBlend;
        if ((dx !== 0 || dy !== 0 || dz !== 0) && trackWeight > 0.001) {
          this.renderOrigin.x += dx * trackWeight;
          this.renderOrigin.y += dy * trackWeight;
          this.renderOrigin.z += dz * trackWeight;
        }
      }

      if (this.globeBlend > 0.005) {
        const localPlanetX = -this.renderOrigin.x;
        const localPlanetY = -this.simRadiusM - this.renderOrigin.y;
        const localPlanetZ = -this.renderOrigin.z;
        this.sTmpA.set(
          localAnchorX + (localPlanetX - localAnchorX) * this.globeBlend,
          localAnchorY + (localPlanetY - localAnchorY) * this.globeBlend,
          localAnchorZ + (localPlanetZ - localAnchorZ) * this.globeBlend
        );
        this.controls.target.lerp(this.sTmpA, Math.min(1, dt * 8.0));
      }

      this.prevTrackedWorld.copy(frame.midHullWorld);
      this.controls.update();

      if (this.controls.target.length() > 500) {
        this.rebaseRenderOrigin(
          this.renderOrigin.x + this.controls.target.x,
          this.renderOrigin.y + this.controls.target.y,
          this.renderOrigin.z + this.controls.target.z
        );
      }
      return;
    }

    // Locked preset modes: pad | chase | engine | station | booster
    this.controls.enabled = false;
    let fov = 50;
    if (this.mode === "pad") {
      ({ fov } = this.computePadPose(frame, ctx));
    } else if (this.mode === "engine") {
      ({ fov } = this.computeEnginePose(frame));
    } else if (this.mode === "station") {
      ({ fov } = this.computeStationPose(ctx));
    } else {
      ({ fov } = this.computeChaseOrBoosterPose(this.mode, frame, tel));
    }

    const originShift = Math.hypot(
      this.sTgtWorld.x - this.renderOrigin.x,
      this.sTgtWorld.y - this.renderOrigin.y,
      this.sTgtWorld.z - this.renderOrigin.z
    );
    if (originShift > 120) {
      this.rebaseRenderOrigin(this.sTgtWorld.x, this.sTgtWorld.y, this.sTgtWorld.z);
    }

    const localCamX = this.sCamWorld.x - this.renderOrigin.x;
    const localCamY = this.sCamWorld.y - this.renderOrigin.y;
    const localCamZ = this.sCamWorld.z - this.renderOrigin.z;
    const localTgtX = this.sTgtWorld.x - this.renderOrigin.x;
    const localTgtY = this.sTgtWorld.y - this.renderOrigin.y;
    const localTgtZ = this.sTgtWorld.z - this.renderOrigin.z;

    if (this.mode === "engine" || this.mode === "station") {
      this.camera.position.set(localCamX, localCamY, localCamZ);
      this.controls.target.set(localTgtX, localTgtY, localTgtZ);
      this.camera.up.copy(this.sUpWorld);
    } else {
      const camAlpha = Math.min(1, dt * 8.0);
      const tgtAlpha = Math.min(1, dt * 12.0);
      this.sTmpA.set(localCamX, localCamY, localCamZ);
      this.sTmpB.set(localTgtX, localTgtY, localTgtZ);
      this.camera.position.lerp(this.sTmpA, camAlpha);
      this.controls.target.lerp(this.sTmpB, tgtAlpha);
      this.camera.up.lerp(this.sUpWorld, Math.min(1, dt * 7.0)).normalize();
    }

    this.camera.lookAt(this.controls.target);
    if (Math.abs(this.camera.fov - fov) > 0.15) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 5.0);
      this.camera.updateProjectionMatrix();
    }

    this.prevTrackedWorld.copy(frame.midHullWorld);

    const hintKey = this.padRangeHint ?? "";
    if (hintKey !== this.lastEmittedHintKey) {
      this.emitState();
    }
  }

  dispose(): void {
    this.killActiveTweens();
    this.controls.dispose();
  }
}
