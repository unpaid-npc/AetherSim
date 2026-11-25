import * as THREE from "three";
import type { PlanetConfig } from "../config/planets";

const SKY_VERTEX_SHADER = /* glsl */ `
varying vec3 vWorldDir;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldDir = normalize(position);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uSunDirection;
uniform vec3 uRayleighCoeff;
uniform float uMieCoeff;
uniform float uMieG;
uniform float uAtmosphereStrength;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uStarIntensity;
uniform float uCameraAltitude;
uniform float uAtmosphereTop;

varying vec3 vWorldDir;

float hash31(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p.zxy, p.yxz + 19.19);
  return fract(p.x * p.y * p.z);
}

float starLayer(vec3 dir, float scale, float threshold) {
  vec3 grid = dir * scale;
  vec3 cell = floor(grid);
  vec3 f = fract(grid) - 0.5;
  float rnd = hash31(cell);
  if (rnd < threshold) {
    return 0.0;
  }
  vec3 offset = vec3(
    hash31(cell + 1.13),
    hash31(cell + 2.71),
    hash31(cell + 4.37)
  ) - 0.5;
  float dist = length(f - offset * 0.55);
  float intensity = smoothstep(0.24, 0.02, dist);
  float twinkle = 0.55 + 0.45 * fract(rnd * 37.0);
  return intensity * twinkle;
}

void main() {
  vec3 dir = normalize(vWorldDir);
  vec3 sunDir = normalize(uSunDirection);

  float spaceT = uAtmosphereTop > 1.0
    ? smoothstep(0.0, uAtmosphereTop, uCameraAltitude)
    : 1.0;
  float effAtmo = uAtmosphereStrength * pow(1.0 - spaceT, 1.45);
  float effStarIntensity = mix(uStarIntensity, 1.0, smoothstep(0.15, 0.72, spaceT));

  float elevation = clamp(dir.y, -0.15, 1.0);
  float up = max(elevation, 0.0);
  float horizonFactor = pow(1.0 - up, 3.2);
  float zenithFactor = smoothstep(0.0, 0.78, up);

  // Base atmospheric gradient + Rayleigh-inspired wavelength balance
  vec3 skyBase = mix(uZenithColor, uHorizonColor, horizonFactor);
  vec3 rayleighScatter = uRayleighCoeff * (0.28 + 0.72 * horizonFactor) * (1.0 - 0.45 * zenithFactor);
  vec3 atmosphereCol = mix(skyBase, skyBase + rayleighScatter * 0.55, effAtmo);

  // Henyey-Greenstein Mie forward scattering
  float cosTheta = clamp(dot(dir, sunDir), -1.0, 1.0);
  float g2 = uMieG * uMieG;
  float phase = (1.0 - g2) / (4.0 * 3.14159265 * pow(max(0.001, 1.0 + g2 - 2.0 * uMieG * cosTheta), 1.5));
  vec3 mieScatter = uSunColor * (uMieCoeff * phase * effAtmo * (0.35 + 0.65 * horizonFactor));

  // Crisp solar disc + subtle corona glare
  float sunCos = max(cosTheta, 0.0);
  float sunDisc = smoothstep(0.99935, 0.99982, cosTheta);
  float sunHalo = pow(sunCos, 96.0) * 0.35 + pow(sunCos, 8.0) * (0.04 + 0.14 * effAtmo);
  vec3 sunLight = uSunColor * (sunDisc * uSunIntensity + sunHalo);

  // 360-degree starfield in deep space; suppressed near bright daytime ground horizon
  float skyLuma = dot(atmosphereCol, vec3(0.299, 0.587, 0.114)) * (1.0 - spaceT * 0.92);
  float horizonStarMask = mix(smoothstep(-0.02, 0.25, dir.y), 1.0, smoothstep(0.15, 0.55, spaceT));
  float starMask = horizonStarMask * clamp(1.0 - skyLuma * 2.4, 0.0, 1.0) * effStarIntensity;
  float stars = 0.0;
  if (starMask > 0.005) {
    stars += starLayer(dir, 145.0, 0.986) * 1.15;
    stars += starLayer(dir, 260.0, 0.990) * 0.75;
  }
  vec3 starCol = vec3(0.92, 0.95, 1.0) * stars * starMask;

  vec3 spaceZenith = vec3(0.004, 0.006, 0.014);
  vec3 activeZenith = mix(uZenithColor, spaceZenith, spaceT);
  vec3 col = atmosphereCol * effAtmo + activeZenith * (1.0 - effAtmo) + mieScatter + sunLight + starCol;

  if (dir.y < 0.0) {
    float below = smoothstep(0.0, -0.15, dir.y) * (1.0 - spaceT);
    col = mix(col, uHorizonColor * (0.35 * effAtmo + 0.05), below);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

const CLOUD_VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;

void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CLOUD_FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
uniform vec3 uSunColor;
uniform float uCloudOpacity;
varying vec3 vDir;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * valueNoise(p);
    p *= 2.04;
    amp *= 0.5;
  }
  return sum;
}

void main() {
  if (vDir.y < 0.04 || uCloudOpacity <= 0.01) {
    discard;
  }
  vec2 uv = vDir.xz / (vDir.y + 0.22);
  vec2 drift = vec2(uTime * 0.012, uTime * 0.005);
  float n = fbm(uv * 1.45 + drift);
  float density = smoothstep(0.52, 0.78, n);
  float horizonFade = smoothstep(0.04, 0.28, vDir.y);
  float alpha = density * horizonFade * 0.42 * uCloudOpacity;
  if (alpha < 0.01) {
    discard;
  }
  vec3 cloudColor = mix(vec3(0.86, 0.91, 0.97), uSunColor, 0.18);
  gl_FragColor = vec4(cloudColor, alpha);
}
`;

/** Manages the altitude-responsive Rayleigh/Mie sky dome and local Earth cloud layer. */
export class AtmosphereDome {
  public readonly group = new THREE.Group();
  private readonly skyGeometry: THREE.SphereGeometry;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly skyMesh: THREE.Mesh;

  private readonly cloudGeometry: THREE.SphereGeometry;
  private readonly cloudMaterial: THREE.ShaderMaterial;
  private readonly cloudMesh: THREE.Mesh;

  private hasClouds = false;

  constructor(initialConfig: PlanetConfig) {
    this.skyGeometry = new THREE.SphereGeometry(5000, 48, 32);
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(0.6, 0.4, -0.7).normalize() },
        uRayleighCoeff: { value: new THREE.Vector3(0.2, 0.5, 1.0) },
        uMieCoeff: { value: 0.015 },
        uMieG: { value: 0.8 },
        uAtmosphereStrength: { value: 1.0 },
        uZenithColor: { value: new THREE.Color("#154994") },
        uHorizonColor: { value: new THREE.Color("#9fd0f2") },
        uSunColor: { value: new THREE.Color("#ffffff") },
        uSunIntensity: { value: 20.0 },
        uStarIntensity: { value: 0.0 },
        uCameraAltitude: { value: 0.0 },
        uAtmosphereTop: { value: 28000.0 },
      },
    });
    this.skyMesh = new THREE.Mesh(this.skyGeometry, this.skyMaterial);
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -100;

    this.cloudGeometry = new THREE.SphereGeometry(4200, 36, 20);
    this.cloudMaterial = new THREE.ShaderMaterial({
      vertexShader: CLOUD_VERTEX_SHADER,
      fragmentShader: CLOUD_FRAGMENT_SHADER,
      side: THREE.BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTime: { value: 0.0 },
        uSunColor: { value: new THREE.Color("#fff6e5") },
        uCloudOpacity: { value: 1.0 },
      },
    });
    this.cloudMesh = new THREE.Mesh(this.cloudGeometry, this.cloudMaterial);
    this.cloudMesh.frustumCulled = false;
    this.cloudMesh.renderOrder = -99;

    this.group.add(this.skyMesh, this.cloudMesh);
    this.updatePlanet(initialConfig);
  }

  updatePlanet(config: PlanetConfig): void {
    const { atmosphere, scale } = config;
    const u = this.skyMaterial.uniforms;
    (u.uSunDirection.value as THREE.Vector3)
      .set(atmosphere.sunDirection[0], atmosphere.sunDirection[1], atmosphere.sunDirection[2])
      .normalize();
    (u.uRayleighCoeff.value as THREE.Vector3).set(
      atmosphere.rayleighCoeff[0],
      atmosphere.rayleighCoeff[1],
      atmosphere.rayleighCoeff[2]
    );
    u.uMieCoeff.value = atmosphere.mieCoeff;
    u.uMieG.value = atmosphere.mieDirectionalG;
    u.uAtmosphereStrength.value = atmosphere.atmosphereStrength;
    (u.uZenithColor.value as THREE.Color).set(atmosphere.zenithColor);
    (u.uHorizonColor.value as THREE.Color).set(atmosphere.horizonColor);
    (u.uSunColor.value as THREE.Color).set(atmosphere.sunColor);
    u.uSunIntensity.value = atmosphere.sunIntensity;
    u.uStarIntensity.value = atmosphere.starIntensity;
    u.uAtmosphereTop.value = scale.atmosphereTopM;

    this.hasClouds = atmosphere.hasClouds;
    (this.cloudMaterial.uniforms.uSunColor.value as THREE.Color).set(atmosphere.sunColor);
    this.cloudMesh.visible = atmosphere.hasClouds;
  }

  update(
    dt: number,
    cameraPosition: THREE.Vector3,
    cameraAltitudeM = 0,
    atmosphereTopM = this.skyMaterial.uniforms.uAtmosphereTop.value as number
  ): void {
    this.group.position.copy(cameraPosition);
    this.skyMaterial.uniforms.uCameraAltitude.value = cameraAltitudeM;
    this.skyMaterial.uniforms.uAtmosphereTop.value = atmosphereTopM;

    if (this.hasClouds) {
      const t = Math.max(0, Math.min(1, (cameraAltitudeM - 1500) / 2300));
      const localCloudFade = 1 - t * t * (3 - 2 * t);
      this.cloudMaterial.uniforms.uCloudOpacity.value = localCloudFade;
      this.cloudMesh.visible = localCloudFade > 0.01;
      if (this.cloudMesh.visible) {
        this.cloudMaterial.uniforms.uTime.value =
          (this.cloudMaterial.uniforms.uTime.value as number) + dt;
      }
    } else {
      this.cloudMesh.visible = false;
    }
  }

  dispose(): void {
    this.skyGeometry.dispose();
    this.skyMaterial.dispose();
    this.cloudGeometry.dispose();
    this.cloudMaterial.dispose();
  }
}
