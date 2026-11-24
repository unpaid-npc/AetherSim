import * as THREE from "three";
import type { PlanetConfig } from "../config/planets";
import {
  createExhaustPlumeGeometry,
  createExhaustPlumeMaterial,
  updateExhaustPlumeUniforms,
} from "../shaders/exhaustShader";
import type { FlightTelemetry } from "../sim/FlightController";

export type QualityPreset = "low" | "med" | "high";

interface ParticleBuffer {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  positions: Float32Array;
  velocities: Float32Array;
  ages: Float32Array;
  lifetimes: Float32Array;
  maxCount: number;
}

function createSoftSpriteTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const half = size * 0.5;

  // Multi-lobe feathered cloud puff with smooth cubic radial falloff (no hard sphere boundary)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x - half) / half;
      const ny = (y - half) / half;
      const r = Math.hypot(nx, ny);
      if (r >= 1.0) {
        continue;
      }
      const lobe =
        0.72 +
        0.16 * Math.sin(nx * 5.2 + ny * 3.1) +
        0.12 * Math.cos(nx * 8.4 - ny * 7.6);
      const falloff = Math.pow(Math.max(0, 1 - r), 2.55) * Math.max(0.25, lobe);
      const alpha = Math.min(255, Math.max(0, Math.round(falloff * 235)));
      const off = (y * size + x) * 4;
      img.data[off] = 255;
      img.data[off + 1] = 255;
      img.data[off + 2] = 255;
      img.data[off + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createParticleBuffer(
  maxCount: number,
  size: number,
  color: string,
  opacity: number,
  spriteTex: THREE.CanvasTexture
): ParticleBuffer {
  const positions = new Float32Array(maxCount * 3);
  const velocities = new Float32Array(maxCount * 3);
  const ages = new Float32Array(maxCount);
  const lifetimes = new Float32Array(maxCount);
  for (let i = 0; i < maxCount; i++) {
    ages[i] = 999;
    lifetimes[i] = 1;
    positions[i * 3 + 1] = -9999;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    size,
    map: spriteTex,
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,
    geometry,
    material,
    positions,
    velocities,
    ages,
    lifetimes,
    maxCount,
  };
}

/**
 * Manages GLSL Raptor Mach-diamond plumes, cryo LOX venting, cold-gas RCS jets,
 * and planet-specific ground exhaust dust/steam clouds.
 */
export class PropulsionEffects {
  public readonly worldGroup = new THREE.Group();

  private readonly spriteTex: THREE.CanvasTexture;
  private readonly plumeGeom: THREE.BufferGeometry;
  private readonly boosterPlumes: Array<{ mesh: THREE.Mesh; mat: THREE.ShaderMaterial }> = [];
  private readonly shipPlumes: Array<{ mesh: THREE.Mesh; mat: THREE.ShaderMaterial }> = [];

  private readonly rcsCones: Array<{
    mesh: THREE.Mesh;
    axis: "pitch" | "yaw" | "roll";
    sign: number;
  }> = [];
  private readonly rcsConeGeom: THREE.ConeGeometry;
  private readonly rcsConeMat: THREE.MeshBasicMaterial;

  private readonly cryoVent: ParticleBuffer;
  private readonly groundBlast: ParticleBuffer;
  private cryoCursor = 0;
  private blastCursor = 0;

  private planet: PlanetConfig;
  private quality: QualityPreset = "med";
  private elapsedSec = 0;
  private seedState = 13579;

  constructor(
    initialPlanet: PlanetConfig,
    boosterAnchor: THREE.Group,
    shipAnchor: THREE.Group,
    rcsAnchor: THREE.Group
  ) {
    this.planet = initialPlanet;
    this.spriteTex = createSoftSpriteTexture();
    this.plumeGeom = createExhaustPlumeGeometry();

    // 10 Booster plume sockets (3 center + 7 outer ring)
    const boosterCoords: Array<[number, number]> = [
      [0.85, 0],
      [-0.42, 0.74],
      [-0.42, -0.74],
      [3.5, 0],
      [2.18, 2.74],
      [-0.78, 3.41],
      [-3.15, 1.52],
      [-3.15, -1.52],
      [-0.78, -3.41],
      [2.18, -2.74],
    ];
    boosterCoords.forEach(([px, pz], idx) => {
      const mat = createExhaustPlumeMaterial(idx * 1.73);
      const mesh = new THREE.Mesh(this.plumeGeom, mat);
      mesh.position.set(px, -0.95, pz);
      mesh.scale.set(1.35, 1.0, 1.35);
      mesh.visible = false;
      boosterAnchor.add(mesh);
      this.boosterPlumes.push({ mesh, mat });
    });

    // 6 Ship plume sockets (3 vacuum + 3 sea-level)
    const shipCoords: Array<{ x: number; z: number; scale: number }> = [
      { x: 0.8, z: -0.45, scale: 1.1 },
      { x: -0.8, z: -0.45, scale: 1.1 },
      { x: 0.0, z: 0.92, scale: 1.1 },
      { x: 2.2, z: 1.25, scale: 1.65 },
      { x: -2.2, z: 1.25, scale: 1.65 },
      { x: 0.0, z: -2.55, scale: 1.65 },
    ];
    shipCoords.forEach((s, idx) => {
      const mat = createExhaustPlumeMaterial(10 + idx * 2.1);
      const mesh = new THREE.Mesh(this.plumeGeom, mat);
      mesh.position.set(s.x, -0.85, s.z);
      mesh.scale.set(s.scale, 1.0, s.scale);
      mesh.visible = false;
      shipAnchor.add(mesh);
      this.shipPlumes.push({ mesh, mat });
    });

    // Cold-gas RCS thruster cones around Starship nose & aft
    this.rcsConeGeom = new THREE.ConeGeometry(0.45, 3.8, 10, 1, true);
    this.rcsConeGeom.translate(0, -1.9, 0);
    this.rcsConeMat = new THREE.MeshBasicMaterial({
      color: "#e6f4ff",
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const addRcs = (
      pos: [number, number, number],
      rot: [number, number, number],
      axis: "pitch" | "yaw" | "roll",
      sign: number
    ) => {
      const mesh = new THREE.Mesh(this.rcsConeGeom, this.rcsConeMat);
      mesh.position.set(pos[0], pos[1], pos[2]);
      mesh.rotation.set(rot[0], rot[1], rot[2]);
      mesh.visible = false;
      rcsAnchor.add(mesh);
      this.rcsCones.push({ mesh, axis, sign });
    };

    // Pitch pods (+/-X at nose & aft)
    addRcs([3.2, 34, 0], [0, 0, Math.PI * 0.5], "pitch", 1);
    addRcs([-3.2, 34, 0], [0, 0, -Math.PI * 0.5], "pitch", -1);
    addRcs([-4.5, 6, 0], [0, 0, -Math.PI * 0.5], "pitch", 1);
    addRcs([4.5, 6, 0], [0, 0, Math.PI * 0.5], "pitch", -1);

    // Lateral roll pods (+/-Z at nose & aft)
    addRcs([0, 34, 3.2], [-Math.PI * 0.5, 0, 0], "roll", 1);
    addRcs([0, 34, -3.2], [Math.PI * 0.5, 0, 0], "roll", -1);

    // Yaw spin pods (tangential)
    addRcs([4.5, 16, 1.2], [Math.PI * 0.5, 0, 0], "yaw", 1);
    addRcs([-4.5, 16, -1.2], [-Math.PI * 0.5, 0, 0], "yaw", -1);

    this.cryoVent = createParticleBuffer(240, 8.5, "#eef7ff", 0.24, this.spriteTex);
    this.groundBlast = createParticleBuffer(420, 17.5, "#d49a6a", 0.36, this.spriteTex);
    this.worldGroup.add(this.cryoVent.points, this.groundBlast.points);

    this.setPlanet(initialPlanet);
  }

  private rand(): number {
    this.seedState = (this.seedState + 0x6d2b79f5) | 0;
    let t = Math.imul(this.seedState ^ (this.seedState >>> 15), 1 | this.seedState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  setPlanet(config: PlanetConfig): void {
    this.planet = config;
    if (config.id === "earth") {
      this.groundBlast.material.color.set("#edf4fa");
      this.groundBlast.material.opacity = 0.56;
      this.groundBlast.material.size = 16.0;
    } else if (config.id === "mars") {
      this.groundBlast.material.color.set("#c96d40");
      this.groundBlast.material.opacity = 0.52;
      this.groundBlast.material.size = 15.0;
    } else {
      this.groundBlast.material.color.set("#a2a8b2");
      this.groundBlast.material.opacity = 0.42;
      this.groundBlast.material.size = 9.5;
    }
    this.reset();
  }

  setQuality(quality: QualityPreset): void {
    this.quality = quality;
  }

  reset(): void {
    for (const buf of [this.cryoVent, this.groundBlast]) {
      for (let i = 0; i < buf.maxCount; i++) {
        buf.ages[i] = 999;
        buf.positions[i * 3 + 1] = -9999;
      }
      buf.geometry.attributes.position.needsUpdate = true;
    }
    for (const p of this.boosterPlumes) {
      p.mesh.visible = false;
    }
    for (const p of this.shipPlumes) {
      p.mesh.visible = false;
    }
    for (const r of this.rcsCones) {
      r.mesh.visible = false;
    }
  }

  update(dt: number, telemetry: FlightTelemetry, vehicleIntact: boolean): void {
    this.elapsedSec += dt;
    const pressureBar = this.planet.physics.surfacePressureBar;

    // 1. GLSL Mach-diamond exhaust plumes
    const maxBoosterPlumes = this.quality === "low" ? 3 : this.quality === "med" ? 6 : 10;
    const maxShipPlumes = this.quality === "low" ? 3 : 6;
    const bActive =
      vehicleIntact && !telemetry.stageSeparated && telemetry.boosterThrottle > 0.02;
    const sActive = vehicleIntact && telemetry.shipThrottle > 0.02;

    const bLen = 19.0 + (1 - Math.min(1, pressureBar)) * 12.0;
    const sLen = 16.0 + (1 - Math.min(1, pressureBar)) * 11.0;

    this.boosterPlumes.forEach((p, idx) => {
      const show = bActive && idx < maxBoosterPlumes;
      p.mesh.visible = show;
      if (show) {
        updateExhaustPlumeUniforms(
          p.mat,
          this.elapsedSec,
          telemetry.boosterThrottle,
          pressureBar,
          bLen
        );
      }
    });

    this.shipPlumes.forEach((p, idx) => {
      const show = sActive && idx < maxShipPlumes;
      p.mesh.visible = show;
      if (show) {
        updateExhaustPlumeUniforms(
          p.mat,
          this.elapsedSec,
          telemetry.shipThrottle,
          pressureBar,
          sLen
        );
      }
    });

    // 2. Cold-gas RCS thruster puffs
    for (const r of this.rcsCones) {
      const val = telemetry.rcsThrust[r.axis];
      const firing = vehicleIntact && val * r.sign > 0.12;
      r.mesh.visible = firing;
      if (firing) {
        const mag = Math.min(1, Math.abs(val));
        r.mesh.scale.set(0.7 + mag * 0.4, 0.5 + mag * 0.9, 0.7 + mag * 0.4);
      }
    }

    // 3. Cryogenic LOX venting during PRELAUNCH / COUNTDOWN
    const cryoBudget = this.quality === "low" ? 80 : this.quality === "med" ? 160 : 240;
    if (
      vehicleIntact &&
      telemetry.missionMode === "launch" &&
      (telemetry.phase === "PRELAUNCH" || telemetry.phase === "COUNTDOWN") &&
      telemetry.frostLevel > 0.25
    ) {
      const spawnCount = this.quality === "low" ? 1 : 2;
      for (let s = 0; s < spawnCount; s++) {
        const idx = this.cryoCursor % cryoBudget;
        this.cryoCursor++;
        const side = this.rand() > 0.5 ? 1 : -1;
        this.cryoVent.positions[idx * 3] = telemetry.position.x + side * 4.7;
        this.cryoVent.positions[idx * 3 + 1] =
          telemetry.position.y + 38 + this.rand() * 36;
        this.cryoVent.positions[idx * 3 + 2] = telemetry.position.z + (this.rand() - 0.5) * 3;

        const windX = this.planet.id === "moon" ? side * 6.5 : 4.5 + this.rand() * 4.5;
        this.cryoVent.velocities[idx * 3] = windX;
        this.cryoVent.velocities[idx * 3 + 1] =
          this.planet.id === "moon" ? -2.0 : -1.2 + this.rand() * 1.4;
        this.cryoVent.velocities[idx * 3 + 2] = (this.rand() - 0.5) * 3.0;
        this.cryoVent.ages[idx] = 0;
        this.cryoVent.lifetimes[idx] = this.planet.id === "moon" ? 1.1 : 3.2;
      }
    }
    this.stepParticles(this.cryoVent, dt, cryoBudget, 0.0, 0.35);

    // 4. Planet-specific ground blast dust / steam clouds
    const blastBudget = this.quality === "low" ? 120 : this.quality === "med" ? 260 : 420;
    const totalThrottle = Math.max(telemetry.boosterThrottle, telemetry.shipThrottle);
    if (vehicleIntact && totalThrottle > 0.06 && telemetry.altitudeM < 155) {
      const prox = 1 - telemetry.altitudeM / 155;
      const count = Math.ceil((this.quality === "low" ? 3 : this.quality === "med" ? 6 : 9) * prox);
      for (let s = 0; s < count; s++) {
        const idx = this.blastCursor % blastBudget;
        this.blastCursor++;
        const ang = this.rand() * Math.PI * 2;
        const r = 4.0 + this.rand() * 8.0;
        this.groundBlast.positions[idx * 3] = telemetry.position.x + Math.cos(ang) * r;
        this.groundBlast.positions[idx * 3 + 1] = telemetry.surfaceHeightM + 1.2 + this.rand() * 2.0;
        this.groundBlast.positions[idx * 3 + 2] = telemetry.position.z + Math.sin(ang) * r;

        const speedOut =
          this.planet.id === "moon"
            ? 32 + this.rand() * 28
            : 18 + this.rand() * 24 * totalThrottle;
        this.groundBlast.velocities[idx * 3] = Math.cos(ang) * speedOut;
        this.groundBlast.velocities[idx * 3 + 1] =
          this.planet.id === "moon"
            ? 2.0 + this.rand() * 4.5
            : 4.5 + this.rand() * 9.0 * prox;
        this.groundBlast.velocities[idx * 3 + 2] = Math.sin(ang) * speedOut;
        this.groundBlast.ages[idx] = 0;
        this.groundBlast.lifetimes[idx] = this.planet.id === "moon" ? 0.95 : 2.6 + this.rand() * 1.4;
      }
    }
    const blastGrav = this.planet.id === "moon" ? -5.5 : this.planet.id === "earth" ? 2.4 : 0.8;
    const blastDrag = this.planet.id === "moon" ? 0.05 : 0.95;
    this.stepParticles(this.groundBlast, dt, blastBudget, blastGrav, blastDrag);
  }

  private stepParticles(
    buf: ParticleBuffer,
    dt: number,
    budget: number,
    buoyancyY: number,
    drag: number
  ): void {
    let anyActive = false;
    for (let i = 0; i < budget; i++) {
      if (buf.ages[i] >= buf.lifetimes[i]) {
        if (buf.positions[i * 3 + 1] > -9000) {
          buf.positions[i * 3 + 1] = -9999;
          anyActive = true;
        }
        continue;
      }
      anyActive = true;
      buf.ages[i] += dt;
      buf.velocities[i * 3] *= Math.max(0, 1 - drag * dt);
      buf.velocities[i * 3 + 1] += buoyancyY * dt;
      buf.velocities[i * 3 + 2] *= Math.max(0, 1 - drag * dt);

      buf.positions[i * 3] += buf.velocities[i * 3] * dt;
      buf.positions[i * 3 + 1] += buf.velocities[i * 3 + 1] * dt;
      buf.positions[i * 3 + 2] += buf.velocities[i * 3 + 2] * dt;
    }
    if (anyActive) {
      buf.geometry.attributes.position.needsUpdate = true;
    }
  }

  dispose(): void {
    this.spriteTex.dispose();
    this.plumeGeom.dispose();
    for (const p of this.boosterPlumes) {
      p.mat.dispose();
    }
    for (const p of this.shipPlumes) {
      p.mat.dispose();
    }
    this.rcsConeGeom.dispose();
    this.rcsConeMat.dispose();
    this.cryoVent.geometry.dispose();
    this.cryoVent.material.dispose();
    this.groundBlast.geometry.dispose();
    this.groundBlast.material.dispose();
  }
}
