import gsap from "gsap";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { FlightTelemetry } from "../sim/FlightController";
import { smoothstep } from "../utils/noise";

export type CameraPreset =
  | "pad"
  | "drone"
  | "engine"
  | "station"
  | "orbit"
  | "map"
  | "booster";
export type CameraFocusMode = "rocket" | "base";
export type TrackTarget = "ship" | "booster";

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * GSAP-powered multi-camera cinematography director with guaranteed vehicle re-lock,
 * independent SHIP / BOOSTER RTLS tracking, and smooth Google-Earth surface-to-globe zoom.
 */
export class CameraDirector {
  public readonly controls: OrbitControls;
  private readonly camera: THREE.PerspectiveCamera;

  private preset: CameraPreset = "orbit";
  private focusMode: CameraFocusMode = "rocket";
  private trackTarget: TrackTarget = "ship";
  private autoDirector = false;
  private lastTrackedRocketPos = new THREE.Vector3();
  private smoothCamPos = new THREE.Vector3();
  private smoothTarget = new THREE.Vector3();
  private initialized = false;

  private simRadiusM = 67_790;
  private globeBlend = 0;
  private lastNear = 0.5;
  private lastFar = 1_355_800;

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 25;
    this.controls.maxDistance = this.simRadiusM * 4.5;
    this.controls.maxPolarAngle = Math.PI * 0.495;
  }

  setPlanetRadius(simRadiusM: number): void {
    this.simRadiusM = Math.max(1000, simRadiusM);
    if (this.preset === "map") {
      this.controls.minDistance = this.simRadiusM * 1.18;
      this.controls.maxDistance = this.simRadiusM * 6.5;
    } else {
      this.controls.minDistance = 25;
      this.controls.maxDistance = this.simRadiusM * 5.0;
    }
    const desiredFar = Math.max(250_000, this.simRadiusM * 20);
    this.camera.far = desiredFar;
    this.lastFar = desiredFar;
    this.camera.updateProjectionMatrix();
  }

  getPreset(): CameraPreset {
    return this.preset;
  }

  getFocusMode(): CameraFocusMode {
    return this.focusMode;
  }

  setTrackTarget(target: TrackTarget, tel: FlightTelemetry, baseTarget: THREE.Vector3): void {
    this.trackTarget = target;
    if (this.preset === "booster" && target === "ship") {
      this.preset = "orbit";
    } else if (target === "booster" && this.preset !== "map") {
      // Keep current interactive orbit preset if active, otherwise track cleanly
      if (this.preset !== "orbit") {
        this.preset = "booster";
      }
    }
    this.reLockOnVehicle(tel, baseTarget, false);
  }

  getTrackTarget(): TrackTarget {
    return this.trackTarget;
  }

  setFocusMode(mode: CameraFocusMode, tel: FlightTelemetry, baseTarget: THREE.Vector3): void {
    this.focusMode = mode;
    this.preset = "orbit";
    this.reLockOnVehicle(tel, baseTarget, false);
  }

  setAutoDirector(enabled: boolean): void {
    this.autoDirector = enabled;
  }

  getAutoDirector(): boolean {
    return this.autoDirector;
  }

  setPreset(
    preset: CameraPreset,
    tel: FlightTelemetry,
    baseTarget: THREE.Vector3,
    immediate = false
  ): void {
    this.preset = preset;
    this.controls.enabled = preset === "orbit" || preset === "map";
    if (preset === "orbit") {
      this.focusMode = "rocket";
    } else if (preset === "booster") {
      this.trackTarget = "booster";
    }
    this.reLockOnVehicle(tel, baseTarget, immediate);
  }

  /**
   * Immediately or smoothly re-anchors the camera onto Starship (or Pad/Base when selected),
   * killing stale GSAP tweens so Starship NEVER drifts out of view after RUD resets.
   */
  reLockOnVehicle(
    tel: FlightTelemetry,
    baseTarget: THREE.Vector3,
    immediate = true
  ): void {
    gsap.killTweensOf(this.camera.position);
    gsap.killTweensOf(this.controls.target);

    this.globeBlend = 0;
    this.camera.up.set(0, 1, 0);
    if (this.preset === "map") {
      this.controls.minDistance = this.simRadiusM * 1.18;
      this.controls.maxDistance = this.simRadiusM * 6.5;
      this.controls.maxPolarAngle = Math.PI * 0.98;
    } else {
      this.controls.minDistance = 25;
      this.controls.maxDistance = this.simRadiusM * 5.0;
      this.controls.maxPolarAngle = Math.PI * 0.495;
    }
    this.controls.zoomSpeed = 1.0;

    const desiredFar = Math.max(250_000, this.simRadiusM * 20);
    this.camera.near = 0.5;
    this.camera.far = desiredFar;
    this.lastNear = 0.5;
    this.lastFar = desiredFar;

    const { camPos, target, fov } = this.computePresetPose(this.preset, tel, baseTarget);
    const trackedPos = this.getTrackedPosition(tel);
    this.lastTrackedRocketPos.set(trackedPos.x, trackedPos.y, trackedPos.z);
    this.smoothCamPos.copy(camPos);
    this.smoothTarget.copy(target);
    this.initialized = true;

    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();

    if (immediate) {
      this.camera.position.copy(camPos);
      this.controls.target.copy(target);
      this.camera.lookAt(target);
      this.controls.update();
      return;
    }

    gsap.to(this.camera.position, {
      x: camPos.x,
      y: camPos.y,
      z: camPos.z,
      duration: 0.75,
      ease: "power2.out",
    });
    gsap.to(this.controls.target, {
      x: target.x,
      y: target.y,
      z: target.z,
      duration: 0.75,
      ease: "power2.out",
      onUpdate: () => this.controls.update(),
    });
  }

  private isTrackingBooster(tel: FlightTelemetry): boolean {
    return (
      (this.preset === "booster" || (this.preset === "orbit" && this.trackTarget === "booster")) &&
      tel.missionMode === "launch" &&
      tel.stageSeparated &&
      tel.booster.status !== "NONE"
    );
  }

  private getTrackedPosition(tel: FlightTelemetry): { x: number; y: number; z: number } {
    return this.isTrackingBooster(tel) ? tel.booster.position : tel.position;
  }

  private getRadialUp(tel: FlightTelemetry): THREE.Vector3 {
    if (tel.missionMode !== "launch") {
      return new THREE.Vector3(0, 1, 0);
    }
    const pos = this.getTrackedPosition(tel);
    const v = new THREE.Vector3(pos.x, pos.y + this.simRadiusM, pos.z);
    return v.lengthSq() > 1e-6 ? v.normalize() : new THREE.Vector3(0, 1, 0);
  }

  private getRocketAnchor(tel: FlightTelemetry): THREE.Vector3 {
    const pos = this.getTrackedPosition(tel);
    const yOffset = this.isTrackingBooster(tel)
      ? 35
      : tel.missionMode === "launch" && !tel.stageSeparated
        ? 54
        : 22;
    const up = this.getRadialUp(tel);
    return new THREE.Vector3(
      pos.x + up.x * yOffset,
      pos.y + up.y * yOffset,
      pos.z + up.z * yOffset
    );
  }

  private computePresetPose(
    preset: CameraPreset,
    tel: FlightTelemetry,
    baseTarget: THREE.Vector3
  ): { camPos: THREE.Vector3; target: THREE.Vector3; fov: number } {
    const rocketAnchor = this.getRocketAnchor(tel);
    const up = this.getRadialUp(tel);
    const east = new THREE.Vector3(up.y, -up.x, 0);
    if (east.lengthSq() < 1e-6) {
      east.set(1, 0, 0);
    } else {
      east.normalize();
    }

    if (preset === "map") {
      const planetCenter = new THREE.Vector3(0, -this.simRadiusM, 0);
      return {
        camPos: new THREE.Vector3(
          this.simRadiusM * 0.45,
          -this.simRadiusM + this.simRadiusM * 0.85,
          this.simRadiusM * 2.65
        ),
        target: planetCenter,
        fov: 46,
      };
    }

    if (preset === "pad") {
      return {
        camPos: new THREE.Vector3(82, tel.padDeckY + 7.5, 92),
        target: rocketAnchor,
        fov: 56,
      };
    }

    if (preset === "booster") {
      const dist = tel.stageSeparated ? 115 : 132;
      const elev = tel.stageSeparated ? 30 : 36;
      const offset = east
        .clone()
        .multiplyScalar(dist * 0.72)
        .addScaledVector(up, elev)
        .add(new THREE.Vector3(0, 0, dist * 0.68));
      const camPos = rocketAnchor.clone().add(offset);
      if (tel.booster.altitudeM < 500 && camPos.y < tel.padDeckY + 8) {
        camPos.y = tel.padDeckY + 8;
      }
      return {
        camPos,
        target: rocketAnchor,
        fov: 52,
      };
    }

    if (preset === "drone") {
      const dist = tel.missionMode === "launch" && !tel.stageSeparated ? 128 : 82;
      const elev = tel.missionMode === "launch" && !tel.stageSeparated ? 34 : 24;
      const offset = east
        .clone()
        .multiplyScalar(dist * 0.78)
        .addScaledVector(up, elev)
        .add(new THREE.Vector3(0, 0, dist * 0.68));
      const camPos = rocketAnchor.clone().add(offset);
      if (tel.altitudeM < 500 && camPos.y < tel.surfaceHeightM + 8) {
        camPos.y = tel.surfaceHeightM + 8;
      }
      return {
        camPos,
        target: rocketAnchor,
        fov: 50,
      };
    }

    if (preset === "engine") {
      const sinP = Math.sin(tel.pitch);
      const cosP = Math.cos(tel.pitch);
      const dirX = sinP;
      const dirY = cosP * Math.cos(tel.roll);
      const dirZ = cosP * Math.sin(tel.roll);
      const mountPos = new THREE.Vector3(
        tel.position.x + dirX * 16 + 7.5,
        tel.position.y + dirY * 16 + 2.0,
        tel.position.z + dirZ * 16 + 7.5
      );
      const rawBelowY = tel.position.y - dirY * 32;
      const lookBelow = new THREE.Vector3(
        tel.position.x - dirX * 32,
        tel.altitudeM > 500 ? rawBelowY : Math.max(0, rawBelowY),
        tel.position.z - dirZ * 32
      );
      return {
        camPos: mountPos,
        target: lookBelow,
        fov: 62,
      };
    }

    if (preset === "station") {
      const camPos = new THREE.Vector3(
        baseTarget.x + 95,
        Math.max(48, baseTarget.y + 52),
        baseTarget.z + 115
      );
      const midTarget = rocketAnchor.clone().lerp(baseTarget, 0.38);
      return {
        camPos,
        target: midTarget,
        fov: 48,
      };
    }

    // "orbit"
    const target = this.focusMode === "base" ? baseTarget.clone() : rocketAnchor;
    const offset =
      this.focusMode === "base"
        ? new THREE.Vector3(110, 52, 125)
        : tel.missionMode === "launch"
          ? new THREE.Vector3(118, 46, 138)
          : new THREE.Vector3(64, 24, 76);
    return {
      camPos: target.clone().add(offset),
      target,
      fov: 52,
    };
  }

  private adaptClipPlanes(camAltM: number): void {
    const desiredNear = clamp(camAltM * 0.002, 0.4, 50);
    const desiredFar = Math.max(250_000, this.simRadiusM * 20);
    const nearChanged = Math.abs(desiredNear - this.lastNear) / Math.max(0.1, this.lastNear) > 0.05;
    const farChanged = Math.abs(desiredFar - this.lastFar) / Math.max(1, this.lastFar) > 0.05;
    if (nearChanged || farChanged) {
      this.camera.near = desiredNear;
      this.camera.far = desiredFar;
      this.lastNear = desiredNear;
      this.lastFar = desiredFar;
      this.camera.updateProjectionMatrix();
    }
  }

  update(dt: number, tel: FlightTelemetry, baseTarget: THREE.Vector3): void {
    if (this.autoDirector && tel.running && !tel.paused) {
      let desired: CameraPreset = this.preset;
      if (tel.missionMode === "launch") {
        if (tel.tClockSec < 8) {
          desired = "pad";
        } else if (tel.stageSeparated) {
          desired = "engine";
        } else {
          desired = "drone";
        }
      } else {
        desired = tel.altitudeM > 110 ? "drone" : "pad";
      }
      if (desired !== this.preset) {
        this.setPreset(desired, tel, baseTarget, false);
      }
    }

    if (!this.initialized) {
      this.reLockOnVehicle(tel, baseTarget, true);
      return;
    }

    const planetCenter = new THREE.Vector3(0, -this.simRadiusM, 0);
    const camAltM = Math.max(0, this.camera.position.distanceTo(planetCenter) - this.simRadiusM);
    this.adaptClipPlanes(camAltM);

    if (this.preset === "map") {
      this.controls.enabled = true;
      this.controls.minDistance = this.simRadiusM * 1.18;
      this.controls.maxDistance = this.simRadiusM * 6.5;
      this.controls.maxPolarAngle = Math.PI * 0.98;
      const dist = this.camera.position.distanceTo(this.controls.target);
      this.controls.zoomSpeed = 1.0 + Math.min(2.2, Math.log10(Math.max(10, dist / 200)) * 0.65);
      this.camera.up.lerp(new THREE.Vector3(0, 1, 0), Math.min(1, dt * 6.0)).normalize();
      this.controls.target.lerp(planetCenter, Math.min(1, dt * 6.0));
      this.lastTrackedRocketPos.set(tel.position.x, tel.position.y, tel.position.z);
      this.controls.update();
      return;
    }

    if (this.preset === "orbit") {
      this.controls.enabled = true;
      this.controls.minDistance = 25;
      this.controls.maxDistance = this.simRadiusM * 5.0;
      this.camera.up.lerp(new THREE.Vector3(0, 1, 0), Math.min(1, dt * 6.0)).normalize();

      const anchor = this.focusMode === "base" ? baseTarget : this.getRocketAnchor(tel);
      const distFromAnchor = this.camera.position.distanceTo(anchor);

      // Google-Earth-style zoom responsiveness & smooth pivot transition from rocket -> planet center
      this.controls.zoomSpeed = 1.0 + Math.min(1.8, Math.log10(Math.max(10, distFromAnchor / 25)) * 0.5);
      const polarT = smoothstep(0.04 * this.simRadiusM, 0.25 * this.simRadiusM, distFromAnchor);
      this.controls.maxPolarAngle = Math.PI * (0.495 + 0.465 * polarT);

      const desiredBlend = smoothstep(
        0.35 * this.simRadiusM,
        0.95 * this.simRadiusM,
        distFromAnchor
      );
      const prevBlend = this.globeBlend;
      this.globeBlend += (desiredBlend - this.globeBlend) * Math.min(1, dt * 6.0);

      const trackedPos = this.getTrackedPosition(tel);
      if (this.focusMode === "rocket") {
        const dx = trackedPos.x - this.lastTrackedRocketPos.x;
        const dy = trackedPos.y - this.lastTrackedRocketPos.y;
        const dz = trackedPos.z - this.lastTrackedRocketPos.z;
        const trackWeight = 1 - this.globeBlend;
        if ((dx !== 0 || dy !== 0 || dz !== 0) && trackWeight > 0.001) {
          this.camera.position.x += dx * trackWeight;
          this.camera.position.y += dy * trackWeight;
          this.camera.position.z += dz * trackWeight;
          this.controls.target.x += dx * trackWeight;
          this.controls.target.y += dy * trackWeight;
          this.controls.target.z += dz * trackWeight;
        }
      }

      if (this.globeBlend > 0.005 || prevBlend > 0.005) {
        const idealTarget = anchor.clone().lerp(planetCenter, this.globeBlend);
        this.controls.target.lerp(idealTarget, Math.min(1, dt * 8.0));
      }

      this.lastTrackedRocketPos.set(trackedPos.x, trackedPos.y, trackedPos.z);
      this.controls.update();
      return;
    }

    this.controls.enabled = false;
    const desiredUp =
      (this.preset === "drone" || this.preset === "booster") && tel.missionMode === "launch"
        ? this.getRadialUp(tel)
        : new THREE.Vector3(0, 1, 0);
    this.camera.up.lerp(desiredUp, Math.min(1, dt * 4.5)).normalize();
    const { camPos, target, fov } = this.computePresetPose(this.preset, tel, baseTarget);
    const alpha = this.preset === "engine" ? 1.0 : Math.min(1, dt * 5.2);
    this.smoothCamPos.lerp(camPos, alpha);
    this.smoothTarget.lerp(target, Math.min(1, dt * 8.0));

    this.camera.position.copy(this.smoothCamPos);
    this.controls.target.copy(this.smoothTarget);
    this.camera.lookAt(this.smoothTarget);
    if (Math.abs(this.camera.fov - fov) > 0.2) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 4.0);
      this.camera.updateProjectionMatrix();
    }
    const trackedEndPos = this.getTrackedPosition(tel);
    this.lastTrackedRocketPos.set(trackedEndPos.x, trackedEndPos.y, trackedEndPos.z);
  }

  dispose(): void {
    gsap.killTweensOf(this.camera.position);
    gsap.killTweensOf(this.controls.target);
    this.controls.dispose();
  }
}
