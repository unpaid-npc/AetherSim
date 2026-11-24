import gsap from "gsap";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { FlightTelemetry } from "../sim/FlightController";

export type CameraPreset = "pad" | "drone" | "engine" | "station" | "orbit";
export type CameraFocusMode = "rocket" | "base";

/**
 * GSAP-powered multi-camera cinematography director with guaranteed vehicle re-lock
 * on mission resets, planet/mission switches, and post-RUD LIVE TRAIN auto-resets.
 */
export class CameraDirector {
  public readonly controls: OrbitControls;
  private readonly camera: THREE.PerspectiveCamera;

  private preset: CameraPreset = "orbit";
  private focusMode: CameraFocusMode = "rocket";
  private autoDirector = false;
  private lastTrackedRocketPos = new THREE.Vector3();
  private smoothCamPos = new THREE.Vector3();
  private smoothTarget = new THREE.Vector3();
  private initialized = false;

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.camera = camera;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.minDistance = 14;
    this.controls.maxDistance = 2600;
    this.controls.maxPolarAngle = Math.PI * 0.495;
  }

  getPreset(): CameraPreset {
    return this.preset;
  }

  getFocusMode(): CameraFocusMode {
    return this.focusMode;
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
    this.controls.enabled = preset === "orbit";
    if (preset === "orbit") {
      this.focusMode = "rocket";
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

    const { camPos, target, fov } = this.computePresetPose(this.preset, tel, baseTarget);
    this.lastTrackedRocketPos.set(tel.position.x, tel.position.y, tel.position.z);
    this.smoothCamPos.copy(camPos);
    this.smoothTarget.copy(target);
    this.initialized = true;

    if (Math.abs(this.camera.fov - fov) > 0.1) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

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

  private getRocketAnchor(tel: FlightTelemetry): THREE.Vector3 {
    const yOffset = tel.missionMode === "launch" && !tel.stageSeparated ? 54 : 22;
    return new THREE.Vector3(tel.position.x, tel.position.y + yOffset, tel.position.z);
  }

  private computePresetPose(
    preset: CameraPreset,
    tel: FlightTelemetry,
    baseTarget: THREE.Vector3
  ): { camPos: THREE.Vector3; target: THREE.Vector3; fov: number } {
    const rocketAnchor = this.getRocketAnchor(tel);

    if (preset === "pad") {
      return {
        camPos: new THREE.Vector3(82, tel.padDeckY + 7.5, 92),
        target: rocketAnchor,
        fov: 56,
      };
    }

    if (preset === "drone") {
      const dist = tel.missionMode === "launch" && !tel.stageSeparated ? 128 : 82;
      const elev = tel.missionMode === "launch" && !tel.stageSeparated ? 34 : 24;
      return {
        camPos: new THREE.Vector3(
          rocketAnchor.x + dist * 0.78,
          Math.max(tel.surfaceHeightM + 8, rocketAnchor.y + elev),
          rocketAnchor.z + dist * 0.68
        ),
        target: rocketAnchor,
        fov: 50,
      };
    }

    if (preset === "engine") {
      // Mounted beside lower engine skirt looking down past the nozzle bells and plume
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
      const lookBelow = new THREE.Vector3(
        tel.position.x - dirX * 32,
        Math.max(0, tel.position.y - dirY * 32),
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

    if (this.preset === "orbit") {
      this.controls.enabled = true;
      if (this.focusMode === "rocket") {
        const dx = tel.position.x - this.lastTrackedRocketPos.x;
        const dy = tel.position.y - this.lastTrackedRocketPos.y;
        const dz = tel.position.z - this.lastTrackedRocketPos.z;
        if (dx !== 0 || dy !== 0 || dz !== 0) {
          this.camera.position.x += dx;
          this.camera.position.y += dy;
          this.camera.position.z += dz;
          this.controls.target.x += dx;
          this.controls.target.y += dy;
          this.controls.target.z += dz;
        }
      }
      this.lastTrackedRocketPos.set(tel.position.x, tel.position.y, tel.position.z);
      this.controls.update();
      return;
    }

    this.controls.enabled = false;
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
    this.lastTrackedRocketPos.set(tel.position.x, tel.position.y, tel.position.z);
  }

  dispose(): void {
    gsap.killTweensOf(this.camera.position);
    gsap.killTweensOf(this.controls.target);
    this.controls.dispose();
  }
}
