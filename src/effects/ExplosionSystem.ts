import * as THREE from "three";
import type { PlanetConfig } from "../config/planets";
import type { CrashEvent } from "../sim/FlightController";
import { SeededNoise2D, samplePlanetTerrainHeight } from "../utils/noise";
import type { QualityPreset } from "./PropulsionEffects";

const FIREBALL_VERT = /* glsl */ `
uniform float uTime;
uniform float uProgress;
varying vec3 vNormalDir;
varying vec3 vLocalPos;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vNormalDir = normalize(normal);
  vLocalPos = position;
  float bump = sin(position.x * 4.5 + uTime * 7.0) * cos(position.y * 4.2 - uTime * 5.0) * sin(position.z * 4.5);
  float disp = 1.0 + bump * (0.22 + 0.25 * uProgress) + 0.08 * hash31(floor(position * 6.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position * disp, 1.0);
}
`;

const FIREBALL_FRAG = /* glsl */ `
uniform float uProgress;
uniform float uTime;
varying vec3 vNormalDir;
varying vec3 vLocalPos;

void main() {
  float swirl = sin(vLocalPos.x * 6.0 + uTime * 6.0) * cos(vLocalPos.y * 6.0 - uTime * 4.5) * 0.5 + 0.5;
  float rim = 1.0 - abs(dot(vNormalDir, vec3(0.0, 1.0, 0.0)));

  vec3 hotCore = vec3(3.2, 2.8, 1.8);
  vec3 orangeFlame = vec3(2.4, 0.72, 0.14);
  vec3 soot = vec3(0.14, 0.12, 0.12);

  float coolT = smoothstep(0.05, 0.78, uProgress);
  vec3 flame = mix(hotCore, orangeFlame, clamp(coolT * 1.15 + swirl * 0.35, 0.0, 1.0));
  vec3 col = mix(flame, soot, smoothstep(0.45, 0.92, uProgress + (1.0 - swirl) * 0.22));
  col *= (0.8 + 0.4 * rim);

  float alpha = (1.0 - smoothstep(0.68, 1.0, uProgress)) * 0.95;
  if (alpha < 0.01) {
    discard;
  }
  gl_FragColor = vec4(col, alpha);
}
`;

const SHOCKWAVE_FRAG = /* glsl */ `
uniform float uProgress;
uniform vec3 uColor;
varying vec2 vUv;

void main() {
  float r = length(vUv - 0.5) * 2.0;
  float ring = smoothstep(0.55, 0.85, r) * (1.0 - smoothstep(0.88, 1.0, r));
  float alpha = ring * (1.0 - smoothstep(0.2, 1.0, uProgress)) * 0.85;
  if (alpha < 0.01) {
    discard;
  }
  gl_FragColor = vec4(uColor * (2.2 - uProgress), alpha);
}
`;

const SHOCKWAVE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MAX_DEBRIS = 160;
const MAX_SMOKE = 240;

function createSmokeSprite(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 3, 32, 32, 30);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.55, "rgba(180,180,180,0.45)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 3D Crash / RUD Explosion system: volumetric GLSL fireball, blast shockwave,
 * ballistic tumbling burning debris, rising smoke column, flash light, and camera shake.
 */
export class ExplosionSystem {
  public readonly group = new THREE.Group();

  private readonly fireballGeom: THREE.IcosahedronGeometry;
  private readonly fireballMats: THREE.ShaderMaterial[] = [];
  private readonly fireballMeshes: THREE.Mesh[] = [];

  private readonly shockwaveGeom: THREE.PlaneGeometry;
  private readonly shockwaveMat: THREE.ShaderMaterial;
  private readonly shockwaveMesh: THREE.Mesh;

  private readonly debrisGeom: THREE.BoxGeometry;
  private readonly debrisMat: THREE.MeshStandardMaterial;
  private readonly debrisMesh: THREE.InstancedMesh;
  private readonly debrisPos = new Float32Array(MAX_DEBRIS * 3);
  private readonly debrisVel = new Float32Array(MAX_DEBRIS * 3);
  private readonly debrisRot = new Float32Array(MAX_DEBRIS * 3);
  private readonly debrisSpin = new Float32Array(MAX_DEBRIS * 3);
  private readonly debrisScale = new Float32Array(MAX_DEBRIS * 3);

  private readonly smokeSprite: THREE.CanvasTexture;
  private readonly smokeGeom: THREE.BufferGeometry;
  private readonly smokeMat: THREE.PointsMaterial;
  private readonly smokePoints: THREE.Points;
  private readonly smokePos = new Float32Array(MAX_SMOKE * 3);
  private readonly smokeVel = new Float32Array(MAX_SMOKE * 3);

  private readonly flashLight: THREE.PointLight;

  private planet: PlanetConfig;
  private noise: SeededNoise2D;
  private quality: QualityPreset = "med";
  private active = false;
  private elapsed = 0;
  private blastScale = 1.0;
  private origin = new THREE.Vector3();
  private lastTriggeredEventId = -1;

  constructor(initialPlanet: PlanetConfig) {
    this.planet = initialPlanet;
    this.noise = new SeededNoise2D(initialPlanet.terrain.seed);
    this.group.visible = false;

    this.fireballGeom = new THREE.IcosahedronGeometry(1.0, 3);
    const offsets: Array<[number, number, number]> = [
      [0, 6, 0],
      [-7, 11, 5],
      [8, 10, -5],
    ];
    for (const off of offsets) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: FIREBALL_VERT,
        fragmentShader: FIREBALL_FRAG,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: { value: 0 },
          uProgress: { value: 0 },
        },
      });
      const mesh = new THREE.Mesh(this.fireballGeom, mat);
      mesh.position.set(off[0], off[1], off[2]);
      this.fireballMats.push(mat);
      this.fireballMeshes.push(mesh);
      this.group.add(mesh);
    }

    this.shockwaveGeom = new THREE.PlaneGeometry(2, 2);
    this.shockwaveGeom.rotateX(-Math.PI * 0.5);
    this.shockwaveMat = new THREE.ShaderMaterial({
      vertexShader: SHOCKWAVE_VERT,
      fragmentShader: SHOCKWAVE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uProgress: { value: 0 },
        uColor: { value: new THREE.Color("#ffd8a8") },
      },
    });
    this.shockwaveMesh = new THREE.Mesh(this.shockwaveGeom, this.shockwaveMat);
    this.group.add(this.shockwaveMesh);

    this.debrisGeom = new THREE.BoxGeometry(1, 0.25, 0.7);
    this.debrisMat = new THREE.MeshStandardMaterial({
      color: "#9ca3af",
      emissive: "#ff6b22",
      emissiveIntensity: 0.9,
      metalness: 0.78,
      roughness: 0.42,
    });
    this.debrisMesh = new THREE.InstancedMesh(this.debrisGeom, this.debrisMat, MAX_DEBRIS);
    this.debrisMesh.frustumCulled = false;
    this.group.add(this.debrisMesh);

    this.smokeSprite = createSmokeSprite();
    this.smokeGeom = new THREE.BufferGeometry();
    this.smokeGeom.setAttribute("position", new THREE.BufferAttribute(this.smokePos, 3));
    this.smokeMat = new THREE.PointsMaterial({
      size: 26,
      map: this.smokeSprite,
      color: "#22201e",
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });
    this.smokePoints = new THREE.Points(this.smokeGeom, this.smokeMat);
    this.smokePoints.frustumCulled = false;
    this.group.add(this.smokePoints);

    this.flashLight = new THREE.PointLight("#ff9848", 0, 520, 1.4);
    this.group.add(this.flashLight);
  }

  setPlanet(config: PlanetConfig): void {
    this.planet = config;
    this.noise = new SeededNoise2D(config.terrain.seed);
    if (config.id === "earth") {
      (this.shockwaveMat.uniforms.uColor.value as THREE.Color).set("#f0f7ff");
    } else if (config.id === "mars") {
      (this.shockwaveMat.uniforms.uColor.value as THREE.Color).set("#e8935c");
    } else {
      (this.shockwaveMat.uniforms.uColor.value as THREE.Color).set("#ffe6b8");
    }
  }

  setQuality(quality: QualityPreset): void {
    this.quality = quality;
  }

  reset(): void {
    this.active = false;
    this.elapsed = 0;
    this.lastTriggeredEventId = -1;
    this.group.visible = false;
    this.flashLight.intensity = 0;
  }

  trigger(event: CrashEvent): void {
    if (event.id === this.lastTriggeredEventId) {
      return;
    }
    this.lastTriggeredEventId = event.id;
    this.active = true;
    this.elapsed = 0;
    this.group.visible = true;
    this.origin.set(event.position.x, event.position.y, event.position.z);

    const energyScale = Math.min(1.65, 0.85 + Math.log10(1 + event.impactEnergyJ / 1e8) * 0.25);
    this.blastScale = energyScale * (0.75 + 0.45 * event.remainingFuelRatio);

    this.flashLight.position.set(this.origin.x, this.origin.y + 18, this.origin.z);
    this.shockwaveMesh.position.set(this.origin.x, this.origin.y + 1.0, this.origin.z);
    this.debrisMat.emissiveIntensity = 1.6;

    // Seed deterministic ballistic debris & smoke column
    let s = (event.id * 977 + this.planet.terrain.seed) >>> 0;
    const rand = (): number => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const debrisBudget = this.quality === "low" ? 60 : this.quality === "med" ? 110 : 160;
    this.debrisMesh.count = debrisBudget;
    for (let i = 0; i < debrisBudget; i++) {
      const ang = rand() * Math.PI * 2;
      const spd = (18 + rand() * 58) * this.blastScale;
      const elev = 0.25 + rand() * 1.1;
      this.debrisPos[i * 3] = this.origin.x + (rand() - 0.5) * 6;
      this.debrisPos[i * 3 + 1] = this.origin.y + 3 + rand() * 14;
      this.debrisPos[i * 3 + 2] = this.origin.z + (rand() - 0.5) * 6;

      this.debrisVel[i * 3] = Math.cos(ang) * spd;
      this.debrisVel[i * 3 + 1] = elev * spd * 0.85;
      this.debrisVel[i * 3 + 2] = Math.sin(ang) * spd;

      this.debrisRot[i * 3] = rand() * Math.PI;
      this.debrisRot[i * 3 + 1] = rand() * Math.PI;
      this.debrisRot[i * 3 + 2] = rand() * Math.PI;

      this.debrisSpin[i * 3] = (rand() - 0.5) * 9;
      this.debrisSpin[i * 3 + 1] = (rand() - 0.5) * 9;
      this.debrisSpin[i * 3 + 2] = (rand() - 0.5) * 9;

      const sc = 0.9 + rand() * 2.6;
      this.debrisScale[i * 3] = sc;
      this.debrisScale[i * 3 + 1] = sc * (0.4 + rand() * 0.7);
      this.debrisScale[i * 3 + 2] = sc * (0.6 + rand() * 0.8);
    }

    const smokeBudget = this.quality === "low" ? 80 : this.quality === "med" ? 160 : 240;
    for (let i = 0; i < MAX_SMOKE; i++) {
      if (i < smokeBudget) {
        const a = rand() * Math.PI * 2;
        const rad = rand() * 16;
        this.smokePos[i * 3] = this.origin.x + Math.cos(a) * rad;
        this.smokePos[i * 3 + 1] = this.origin.y + 4 + rand() * 22;
        this.smokePos[i * 3 + 2] = this.origin.z + Math.sin(a) * rad;

        this.smokeVel[i * 3] = Math.cos(a) * (4 + rand() * 14);
        this.smokeVel[i * 3 + 1] =
          this.planet.id === "moon" ? 5 + rand() * 14 : 10 + rand() * 26;
        this.smokeVel[i * 3 + 2] = Math.sin(a) * (4 + rand() * 14);
      } else {
        this.smokePos[i * 3 + 1] = -9999;
      }
    }
    this.smokeGeom.attributes.position.needsUpdate = true;
    this.smokeMat.opacity = this.planet.id === "moon" ? 0.35 : 0.68;
  }

  update(dt: number): void {
    if (!this.active) {
      return;
    }
    this.elapsed += dt;
    const progress = Math.min(1, this.elapsed / 5.5);

    // Volumetric GLSL Fireball growth + cooling
    const fbRadius = (10 + Math.pow(progress, 0.48) * 44) * this.blastScale;
    this.fireballMeshes.forEach((mesh, idx) => {
      const s = fbRadius * (idx === 0 ? 1.0 : 0.72);
      mesh.position.set(
        this.origin.x + (idx === 1 ? -8 * this.blastScale : idx === 2 ? 9 * this.blastScale : 0),
        this.origin.y + 8 + progress * 28 * this.blastScale,
        this.origin.z + (idx === 1 ? 6 * this.blastScale : idx === 2 ? -6 * this.blastScale : 0)
      );
      mesh.scale.setScalar(s);
      mesh.visible = progress < 1.0;
      this.fireballMats[idx].uniforms.uTime.value = this.elapsed;
      this.fireballMats[idx].uniforms.uProgress.value = progress;
    });

    // Expanding shockwave ring
    const shockProg = Math.min(1, this.elapsed / 1.85);
    this.shockwaveMesh.visible = shockProg < 1.0;
    const shockR = (8 + shockProg * 165) * this.blastScale;
    this.shockwaveMesh.scale.set(shockR, 1, shockR);
    this.shockwaveMat.uniforms.uProgress.value = shockProg;

    // Flash point light decay
    const lightFade = Math.max(0, 1 - this.elapsed / 3.4);
    const flicker = 0.85 + 0.15 * Math.sin(this.elapsed * 32);
    this.flashLight.intensity = 95 * this.blastScale * lightFade * lightFade * flicker;

    // Cooling embers on debris
    this.debrisMat.emissiveIntensity = Math.max(0.05, 1.6 * (1 - progress * 1.2));

    // Ballistic debris integration with planet gravity & terrain bounce
    const g = this.planet.physics.gravityMps2;
    const drag = this.planet.physics.airDensityKgM3 * 0.22;
    const dummy = new THREE.Object3D();
    const count = this.debrisMesh.count;
    for (let i = 0; i < count; i++) {
      this.debrisVel[i * 3] *= Math.max(0, 1 - drag * dt);
      this.debrisVel[i * 3 + 1] -= g * dt;
      this.debrisVel[i * 3 + 2] *= Math.max(0, 1 - drag * dt);

      let x = this.debrisPos[i * 3] + this.debrisVel[i * 3] * dt;
      let y = this.debrisPos[i * 3 + 1] + this.debrisVel[i * 3 + 1] * dt;
      let z = this.debrisPos[i * 3 + 2] + this.debrisVel[i * 3 + 2] * dt;

      const groundY =
        Math.hypot(x, z) <= 65
          ? 0.2
          : samplePlanetTerrainHeight(x, z, this.planet, this.noise) + 0.2;
      if (y <= groundY) {
        y = groundY;
        this.debrisVel[i * 3] *= 0.62;
        this.debrisVel[i * 3 + 1] = Math.abs(this.debrisVel[i * 3 + 1]) * 0.34;
        this.debrisVel[i * 3 + 2] *= 0.62;
        this.debrisSpin[i * 3] *= 0.55;
        this.debrisSpin[i * 3 + 1] *= 0.55;
        this.debrisSpin[i * 3 + 2] *= 0.55;
      }

      this.debrisPos[i * 3] = x;
      this.debrisPos[i * 3 + 1] = y;
      this.debrisPos[i * 3 + 2] = z;

      this.debrisRot[i * 3] += this.debrisSpin[i * 3] * dt;
      this.debrisRot[i * 3 + 1] += this.debrisSpin[i * 3 + 1] * dt;
      this.debrisRot[i * 3 + 2] += this.debrisSpin[i * 3 + 2] * dt;

      dummy.position.set(x, y, z);
      dummy.rotation.set(
        this.debrisRot[i * 3],
        this.debrisRot[i * 3 + 1],
        this.debrisRot[i * 3 + 2]
      );
      dummy.scale.set(
        this.debrisScale[i * 3],
        this.debrisScale[i * 3 + 1],
        this.debrisScale[i * 3 + 2]
      );
      dummy.updateMatrix();
      this.debrisMesh.setMatrixAt(i, dummy.matrix);
    }
    this.debrisMesh.instanceMatrix.needsUpdate = true;

    // Rising carbon smoke column
    const smokeBudget = this.quality === "low" ? 80 : this.quality === "med" ? 160 : 240;
    const smokeGrav = this.planet.id === "moon" ? -g * 0.45 : 1.6;
    for (let i = 0; i < smokeBudget; i++) {
      this.smokeVel[i * 3] *= Math.max(0, 1 - 0.35 * dt);
      this.smokeVel[i * 3 + 1] += smokeGrav * dt;
      this.smokeVel[i * 3 + 2] *= Math.max(0, 1 - 0.35 * dt);

      this.smokePos[i * 3] += this.smokeVel[i * 3] * dt;
      this.smokePos[i * 3 + 1] += this.smokeVel[i * 3 + 1] * dt;
      this.smokePos[i * 3 + 2] += this.smokeVel[i * 3 + 2] * dt;
    }
    this.smokeGeom.attributes.position.needsUpdate = true;
    this.smokeMat.opacity = Math.max(0, (1 - this.elapsed / 9.5) * (this.planet.id === "moon" ? 0.35 : 0.68));
  }

  getCameraShakeOffset(out: THREE.Vector3): THREE.Vector3 {
    if (!this.active || this.elapsed > 2.4) {
      return out.set(0, 0, 0);
    }
    const env = Math.pow(1 - this.elapsed / 2.4, 2.0) * 1.45 * this.blastScale;
    out.set(
      Math.sin(this.elapsed * 57.0) * env,
      Math.cos(this.elapsed * 43.0) * env * 0.85,
      Math.sin(this.elapsed * 69.0) * env
    );
    return out;
  }

  dispose(): void {
    this.fireballGeom.dispose();
    for (const mat of this.fireballMats) {
      mat.dispose();
    }
    this.shockwaveGeom.dispose();
    this.shockwaveMat.dispose();
    this.debrisGeom.dispose();
    this.debrisMat.dispose();
    this.smokeSprite.dispose();
    this.smokeGeom.dispose();
    this.smokeMat.dispose();
  }
}
