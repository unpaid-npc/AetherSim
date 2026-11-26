import * as THREE from "three";
import { type LaunchSiteConfig, getDefaultLaunchSiteForPlanet } from "../config/launchSites";
import type { PlanetConfig } from "../config/planets";
import type { QualityPreset } from "../effects/PropulsionEffects";
import {
  SeededNoise2D,
  computeEarthShorelineX,
  samplePlanetTerrainHeight,
  smoothstep,
} from "../utils/noise";
import { loadPbrTextureSet } from "./PbrTextureLoader";
import { getDefaultSiteTintColor } from "./PlanetGlobeTextures";
import {
  type PbrTextureSet,
  disposeTextureSet,
  generatePlanetTextureSet,
} from "./ProceduralTextures";

interface RingSpec {
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly thetaSegments: number;
  readonly radialSegments: number;
  readonly receiveShadow: boolean;
  readonly isOuterFeather: boolean;
}

const BOULDER_COUNT = 220;

function getRingSpecs(localTerrainRadiusM: number): readonly RingSpec[] {
  return [
    {
      innerRadius: 0,
      outerRadius: 300,
      thetaSegments: 128,
      radialSegments: 44,
      receiveShadow: true,
      isOuterFeather: false,
    },
    {
      innerRadius: 300,
      outerRadius: 1800,
      thetaSegments: 128,
      radialSegments: 36,
      receiveShadow: false,
      isOuterFeather: false,
    },
    {
      innerRadius: 1800,
      outerRadius: 5000,
      thetaSegments: 128,
      radialSegments: 26,
      receiveShadow: false,
      isOuterFeather: false,
    },
    {
      innerRadius: 5000,
      outerRadius: Math.max(9000, localTerrainRadiusM),
      thetaSegments: 128,
      radialSegments: 28,
      receiveShadow: false,
      isOuterFeather: true,
    },
  ];
}

function buildRadialRingGeometry(
  spec: RingSpec,
  config: PlanetConfig,
  noise: SeededNoise2D,
  site?: LaunchSiteConfig
): THREE.BufferGeometry {
  const { innerRadius, outerRadius, thetaSegments, radialSegments } = spec;
  const cols = thetaSegments + 1;
  const rows = radialSegments + 1;
  const vertCount = cols * rows;

  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices: number[] = [];

  const localR = config.scale.localTerrainRadiusM;
  const isEarth = config.id === "earth";
  const hasOcean = isEarth ? (site ? site.hasOcean : true) : false;
  const azDeg = site?.coastAzimuthDeg ?? 90;
  const azRad = (azDeg * Math.PI) / 180;
  const azSin = Math.sin(azRad);
  const azCos = Math.cos(azRad);

  for (let rIdx = 0; rIdx < rows; rIdx++) {
    const t = rIdx / radialSegments;
    const radius =
      innerRadius === 0
        ? outerRadius * Math.pow(t, 1.32)
        : innerRadius + (outerRadius - innerRadius) * Math.pow(t, 1.24);

    // Gentle outer rim tuck matching the globe recess so there is zero gap without dark fold on Moon
    const tuckDepth = config.id === "moon" ? 14 : 24;
    const rimTuck = smoothstep(localR * 0.84, localR, radius) * tuckDepth;

    for (let aIdx = 0; aIdx < cols; aIdx++) {
      const theta = (aIdx / thetaSegments) * Math.PI * 2;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;
      const y = samplePlanetTerrainHeight(x, z, config, noise, site) - rimTuck;

      const vIdx = rIdx * cols + aIdx;
      positions[vIdx * 3] = x;
      positions[vIdx * 3 + 1] = y;
      positions[vIdx * 3 + 2] = z;

      normals[vIdx * 3] = 0;
      normals[vIdx * 3 + 1] = 1;
      normals[vIdx * 3 + 2] = 0;

      if (isEarth && !hasOcean) {
        // Arid Kazakh steppe palette (Baikonur)
        const dryVar = noise.fbm(x * 0.0025 + 1.4, z * 0.0025 - 2.1, 2) * 0.5 + 0.5;
        colors[vIdx * 3] = 0.78 + dryVar * 0.12;
        colors[vIdx * 3 + 1] = 0.70 + dryVar * 0.10;
        colors[vIdx * 3 + 2] = 0.54 + dryVar * 0.08;
      } else if (isEarth) {
        const coastU = Math.abs(azDeg - 90) > 0.1 ? x * azSin - z * azCos : x;
        const coastT = Math.abs(azDeg - 90) > 0.1 ? x * azCos + z * azSin : z;
        const dShore = coastU - computeEarthShorelineX(coastT, noise);
        const isTropical = site?.biome === "tropical_coast";
        const isBluff = site?.biome === "coastal_bluff";
        let cr = 0.88;
        let cg = 0.89;
        let cb = 0.78;
        if (dShore < -65) {
          if (isTropical) {
            cr = 0.44;
            cg = 0.68;
            cb = 0.36;
          } else if (isBluff) {
            cr = 0.48;
            cg = 0.70;
            cb = 0.40;
          } else {
            const marshT = smoothstep(-220, -480, coastU) * smoothstep(-60, -280, coastT);
            cr = 0.84 - marshT * 0.24;
            cg = 0.90 - marshT * 0.22;
            cb = 0.76 - marshT * 0.16;
          }
        } else if (dShore <= 22) {
          const beachT = smoothstep(-65, 5, dShore);
          cr = (isTropical ? 0.54 : isBluff ? 0.60 : 0.86) + beachT * 0.36;
          cg = (isTropical ? 0.72 : isBluff ? 0.74 : 0.89) + beachT * 0.20;
          cb = (isTropical ? 0.48 : isBluff ? 0.52 : 0.76) + beachT * 0.16;
        } else {
          const wetT = smoothstep(22, 160, dShore);
          const deepT = smoothstep(140, 760, dShore);
          cr = 0.92 * (1 - wetT) + (0.28 * (1 - deepT) + 0.08 * deepT) * wetT;
          cg = 0.86 * (1 - wetT) + (0.64 * (1 - deepT) + 0.28 * deepT) * wetT;
          cb = 0.70 * (1 - wetT) + (0.64 * (1 - deepT) + 0.42 * deepT) * wetT;
        }
        colors[vIdx * 3] = cr;
        colors[vIdx * 3 + 1] = cg;
        colors[vIdx * 3 + 2] = cb;
      } else {
        colors[vIdx * 3] = 1.0;
        colors[vIdx * 3 + 1] = 1.0;
        colors[vIdx * 3 + 2] = 1.0;
      }

      uvs[vIdx * 2] = x / 180;
      uvs[vIdx * 2 + 1] = z / 180;
    }
  }

  for (let rIdx = 0; rIdx < radialSegments; rIdx++) {
    for (let aIdx = 0; aIdx < thetaSegments; aIdx++) {
      const a = rIdx * cols + aIdx;
      const b = (rIdx + 1) * cols + aIdx;
      const c = (rIdx + 1) * cols + (aIdx + 1);
      const d = rIdx * cols + (aIdx + 1);
      indices.push(a, d, b);
      indices.push(b, d, c);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  // Eliminate degenerate zero-area pole normals at r=0 (prevents radial normal-map vortex at center)
  if (innerRadius === 0) {
    const nAttr = geom.getAttribute("normal") as THREE.BufferAttribute;
    for (let aIdx = 0; aIdx < cols; aIdx++) {
      nAttr.setXYZ(aIdx, 0, 1, 0);
    }
    nAttr.needsUpdate = true;
  }
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Manages expansive spherically curved radial-LOD terrain with radial edge feathering
 * and satellite site-color tinting so it cross-fades invisibly into the 4K PlanetGlobe.
 */
export class TerrainSystem {
  public readonly group = new THREE.Group();

  private ringMeshes: Array<{ mesh: THREE.Mesh; isOuter: boolean }> = [];
  private readonly innerTerrainMaterial: THREE.MeshStandardMaterial;
  private readonly outerTerrainMaterial: THREE.MeshStandardMaterial;
  private readonly outerUniforms: {
    uSatelliteTint: { value: THREE.Color };
    uFeatherInner: { value: number };
    uFeatherOuter: { value: number };
    uTintInner: { value: number };
    uSoilMap: { value: THREE.Texture | null };
    uHasEarthPbr: { value: number };
    uIsEarth: { value: number };
  };
  private terrainTextures: PbrTextureSet | null = null;
  private earthPbrTextures: THREE.Texture[] = [];
  private loadSeq = 0;

  private readonly boulderGeometry: THREE.DodecahedronGeometry;
  private readonly boulderMaterial: THREE.MeshStandardMaterial;
  private readonly boulderMesh: THREE.InstancedMesh;

  private activeConfig: PlanetConfig;
  private activeSite: LaunchSiteConfig;
  private activeNoise: SeededNoise2D;
  private activeQuality: QualityPreset = "med";

  constructor(
    initialConfig: PlanetConfig,
    maxAnisotropy: number,
    quality: QualityPreset = "med",
    initialSite: LaunchSiteConfig = getDefaultLaunchSiteForPlanet(initialConfig.id)
  ) {
    this.activeConfig = initialConfig;
    this.activeSite = initialSite;
    this.activeNoise = new SeededNoise2D(initialConfig.terrain.seed);
    this.activeQuality = quality;

    this.outerUniforms = {
      uSatelliteTint: { value: getDefaultSiteTintColor(initialConfig.id) },
      uFeatherInner: { value: initialConfig.scale.localTerrainRadiusM * 0.42 },
      uFeatherOuter: { value: initialConfig.scale.localTerrainRadiusM * 0.95 },
      uTintInner: { value: initialConfig.scale.localTerrainRadiusM * 0.28 },
      uSoilMap: { value: null },
      uHasEarthPbr: { value: 0.0 },
      uIsEarth: { value: initialConfig.id === "earth" ? 1.0 : 0.0 },
    };

    const injectTerrainPbr = (
      mat: THREE.MeshStandardMaterial,
      isOuterFeather: boolean
    ): void => {
      mat.customProgramCacheKey = () =>
        isOuterFeather ? "aethersim-outer-terrain-pbr-v3" : "aethersim-inner-terrain-pbr-v3";
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uSatelliteTint = this.outerUniforms.uSatelliteTint;
        shader.uniforms.uFeatherInner = this.outerUniforms.uFeatherInner;
        shader.uniforms.uFeatherOuter = this.outerUniforms.uFeatherOuter;
        shader.uniforms.uTintInner = this.outerUniforms.uTintInner;
        shader.uniforms.uSoilMap = this.outerUniforms.uSoilMap;
        shader.uniforms.uHasEarthPbr = this.outerUniforms.uHasEarthPbr;
        shader.uniforms.uIsEarth = this.outerUniforms.uIsEarth;

        shader.vertexShader = shader.vertexShader
          .replace(
            "#include <common>",
            "#include <common>\nvarying float vRadialDist;\nvarying vec2 vLocalGroundXZ;"
          )
          .replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvRadialDist = length(transformed.xz);\nvLocalGroundXZ = transformed.xz;"
          );

        const commonHeader = `#include <common>
uniform vec3 uSatelliteTint;
uniform float uFeatherInner;
uniform float uFeatherOuter;
uniform float uTintInner;
uniform sampler2D uSoilMap;
uniform float uHasEarthPbr;
uniform float uIsEarth;
varying float vRadialDist;
varying vec2 vLocalGroundXZ;

float aetherHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float aetherNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = aetherHash21(i);
  float b = aetherHash21(i + vec2(1.0, 0.0));
  float c = aetherHash21(i + vec2(0.0, 1.0));
  float d = aetherHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float aetherFbm2(vec2 p) {
  float v = 0.0;
  v += 0.55 * aetherNoise2(p);
  v += 0.30 * aetherNoise2(p * 2.13 + vec2(17.1, 31.7));
  v += 0.15 * aetherNoise2(p * 4.41 + vec2(53.3, 11.9));
  return v;
}`;

        // Dual-scale 37-degree rotated UV sampling eliminates checkerboard tiling on all planets
        const mapReplacement = `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  mat2 aetherRot37 = mat2(0.7986355, -0.6018150, 0.6018150, 0.7986355);
  vec2 aetherRotUv = aetherRot37 * (vMapUv * 0.23) + vec2(0.37, 0.71);
  vec4 sampledRotColor = texture2D( map, aetherRotUv );
  float aetherTileMacro = aetherFbm2(vLocalGroundXZ * 0.0026);
  sampledDiffuseColor.rgb = mix(
    sampledDiffuseColor.rgb,
    sampledRotColor.rgb,
    clamp(0.30 + 0.42 * aetherTileMacro, 0.0, 0.78)
  );
  diffuseColor *= sampledDiffuseColor;
#endif`;

        const earthSoilBlock = `
          if (uHasEarthPbr > 0.5) {
            mat2 soilRot37 = mat2(0.7986355, -0.6018150, 0.6018150, 0.7986355);
            float macro = aetherFbm2(vLocalGroundXZ * 0.0022);
            float beachMask = smoothstep(-75.0, 20.0, vLocalGroundXZ.x - 385.0);
            vec3 soilNear = texture2D(uSoilMap, vLocalGroundXZ * 0.028).rgb;
            vec3 soilFar = texture2D(uSoilMap, soilRot37 * (vLocalGroundXZ * 0.0064) + vec2(0.41, 0.19)).rgb;
            vec3 soilCol = mix(soilNear, soilFar, clamp(0.32 + 0.45 * macro, 0.0, 0.80));
            vec3 dualCol = mix(soilCol, diffuseColor.rgb, clamp(0.38 + 0.62 * beachMask, 0.0, 1.0));
            diffuseColor.rgb = mix(diffuseColor.rgb, dualCol * (0.88 + macro * 0.24), 0.70);
          }`;

        const fragSnippet = isOuterFeather
          ? `#include <color_fragment>
          ${earthSoilBlock}
          float radialTintT = smoothstep(uTintInner, uFeatherOuter * 0.84, vRadialDist);
          float tintWeight = uIsEarth > 0.5 ? 0.88 : 0.94;
          diffuseColor.rgb = mix(diffuseColor.rgb, uSatelliteTint, radialTintT * tintWeight);
          float radialAlpha = 1.0 - smoothstep(uFeatherInner, uFeatherOuter, vRadialDist);
          diffuseColor.a *= radialAlpha;`
          : `#include <color_fragment>
          ${earthSoilBlock}
          if (uIsEarth < 0.5) {
            float innerTintT = smoothstep(uTintInner, uFeatherOuter * 0.84, vRadialDist);
            diffuseColor.rgb = mix(diffuseColor.rgb, uSatelliteTint, innerTintT * 0.94);
          }`;

        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", commonHeader)
          .replace("#include <map_fragment>", mapReplacement)
          .replace("#include <color_fragment>", fragSnippet);
      };
    };

    this.innerTerrainMaterial = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      vertexColors: true,
      metalness: 0.03,
      roughness: initialConfig.terrain.baseRoughness,
      normalScale: new THREE.Vector2(1.0, 1.0),
    });
    injectTerrainPbr(this.innerTerrainMaterial, false);

    this.outerTerrainMaterial = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      metalness: 0.03,
      roughness: initialConfig.terrain.baseRoughness,
      normalScale: new THREE.Vector2(1.0, 1.0),
    });
    injectTerrainPbr(this.outerTerrainMaterial, true);

    this.boulderGeometry = new THREE.DodecahedronGeometry(1.0, 0);
    this.boulderMaterial = new THREE.MeshStandardMaterial({
      color: initialConfig.terrain.soilPalette[2],
      roughness: 0.92,
      metalness: 0.06,
      flatShading: true,
    });
    this.boulderMesh = new THREE.InstancedMesh(
      this.boulderGeometry,
      this.boulderMaterial,
      BOULDER_COUNT
    );
    this.boulderMesh.castShadow = true;
    this.boulderMesh.receiveShadow = true;
    this.group.add(this.boulderMesh);

    this.updatePlanet(initialConfig, maxAnisotropy);
  }

  getTerrainHeight(x: number, z: number): number {
    return samplePlanetTerrainHeight(x, z, this.activeConfig, this.activeNoise, this.activeSite);
  }

  /** Tints the outer feather skirt to match the real RGB sampled from the 4K satellite map. */
  setSatelliteSiteTint(color: THREE.Color): void {
    this.outerUniforms.uSatelliteTint.value.copy(color);
  }

  setVisibilityForCameraAltitude(camAltM: number, _simRadiusM: number): void {
    this.boulderMesh.visible = camAltM < 4500;
    // Complete fade-out strictly before 10 km on Earth and 18 km on Moon/Mars (zero floating discs)
    const isEarth = this.activeConfig.id === "earth";
    const fadeStart = isEarth ? 3800 : 7500;
    const fadeEnd = isEarth ? 9800 : 17500;
    const fade = 1 - smoothstep(fadeStart, fadeEnd, camAltM);
    if (fade <= 0.005) {
      for (const { mesh } of this.ringMeshes) {
        mesh.visible = false;
      }
      return;
    }

    // Attenuate normal-map bump contrast smoothly during zoom-out (eliminates Moon swirling aliasing)
    const baseNormal =
      this.activeConfig.id === "moon" ? 0.48 : this.activeConfig.id === "mars" ? 0.76 : 0.90;
    const normStrength = baseNormal * (1 - smoothstep(1000, fadeStart * 1.4, camAltM));
    this.innerTerrainMaterial.normalScale.set(normStrength, normStrength);
    this.outerTerrainMaterial.normalScale.set(normStrength * 0.65, normStrength * 0.65);

    const isBlending = fade < 0.995;
    this.innerTerrainMaterial.transparent = isBlending;
    this.innerTerrainMaterial.opacity = isBlending ? fade : 1.0;
    this.innerTerrainMaterial.depthWrite = !isBlending;

    this.outerTerrainMaterial.opacity = fade;

    for (const { mesh } of this.ringMeshes) {
      mesh.visible = true;
    }
  }

  setQuality(quality: QualityPreset, maxAnisotropy: number): void {
    if (this.activeQuality === quality) {
      return;
    }
    this.activeQuality = quality;
    if (this.activeConfig.id === "earth") {
      this.updatePlanet(this.activeConfig, maxAnisotropy, quality, this.activeSite);
    }
  }

  setLaunchSite(
    site: LaunchSiteConfig,
    maxAnisotropy: number,
    quality: QualityPreset = this.activeQuality
  ): void {
    if (this.activeSite.id === site.id && this.activeConfig.id === site.planetId) {
      return;
    }
    this.activeSite = site;
    this.updatePlanet(this.activeConfig, maxAnisotropy, quality, site);
  }

  private disposeEarthPbr(): void {
    for (const tex of this.earthPbrTextures) {
      tex.dispose();
    }
    this.earthPbrTextures = [];
    this.outerUniforms.uSoilMap.value = null;
    this.outerUniforms.uHasEarthPbr.value = 0.0;
  }

  updatePlanet(
    config: PlanetConfig,
    maxAnisotropy: number,
    quality: QualityPreset = this.activeQuality,
    site: LaunchSiteConfig = getDefaultLaunchSiteForPlanet(config.id)
  ): void {
    this.activeConfig = config;
    this.activeSite = site;
    this.activeQuality = quality;
    const seq = ++this.loadSeq;
    const noise = new SeededNoise2D(config.terrain.seed);
    this.activeNoise = noise;

    this.disposeEarthPbr();

    this.outerUniforms.uSatelliteTint.value.copy(getDefaultSiteTintColor(config.id));
    this.outerUniforms.uFeatherInner.value = config.scale.localTerrainRadiusM * 0.42;
    this.outerUniforms.uFeatherOuter.value = config.scale.localTerrainRadiusM * 0.95;
    this.outerUniforms.uTintInner.value = config.scale.localTerrainRadiusM * 0.26;
    this.outerUniforms.uIsEarth.value = config.id === "earth" ? 1.0 : 0.0;

    for (const old of this.ringMeshes) {
      this.group.remove(old.mesh);
      old.mesh.geometry.dispose();
    }
    this.ringMeshes = [];

    const specs = getRingSpecs(config.scale.localTerrainRadiusM);
    for (const spec of specs) {
      const geom = buildRadialRingGeometry(spec, config, noise, site);
      const mat = spec.isOuterFeather ? this.outerTerrainMaterial : this.innerTerrainMaterial;
      const mesh = new THREE.Mesh(geom, mat);
      mesh.receiveShadow = spec.receiveShadow;
      mesh.castShadow = false;
      this.ringMeshes.push({ mesh, isOuter: spec.isOuterFeather });
      this.group.add(mesh);
    }

    const nextTerrainTex = generatePlanetTextureSet(config, maxAnisotropy);
    for (const mat of [this.innerTerrainMaterial, this.outerTerrainMaterial]) {
      mat.map = nextTerrainTex.albedoMap;
      mat.normalMap = nextTerrainTex.normalMap;
      mat.roughnessMap = nextTerrainTex.roughnessMap;
      mat.roughness = config.terrain.baseRoughness;
      mat.needsUpdate = true;
    }
    disposeTextureSet(this.terrainTextures);
    this.terrainTextures = nextTerrainTex;

    this.updateBoulders(config, noise, site);

    if (config.id === "earth") {
      void Promise.all([
        loadPbrTextureSet("sand", 24, 24, maxAnisotropy, quality),
        loadPbrTextureSet("soil", 16, 16, maxAnisotropy, quality),
      ]).then(([sandPbr, soilPbr]) => {
        if (!sandPbr || !soilPbr || seq !== this.loadSeq) {
          return;
        }
        for (const mat of [this.innerTerrainMaterial, this.outerTerrainMaterial]) {
          mat.map = sandPbr.albedoMap;
          mat.normalMap = sandPbr.normalMap;
          mat.roughnessMap = sandPbr.roughnessMap;
          mat.needsUpdate = true;
        }
        this.outerUniforms.uSoilMap.value = soilPbr.albedoMap;
        this.outerUniforms.uHasEarthPbr.value = 1.0;
        this.earthPbrTextures.push(
          sandPbr.albedoMap,
          sandPbr.normalMap,
          sandPbr.roughnessMap,
          soilPbr.albedoMap,
          soilPbr.normalMap,
          soilPbr.roughnessMap
        );
      });
    }
  }

  private updateBoulders(
    config: PlanetConfig,
    noise: SeededNoise2D,
    site: LaunchSiteConfig
  ): void {
    this.boulderMaterial.color.set(config.terrain.soilPalette[2]);
    this.boulderMaterial.roughness = config.terrain.baseRoughness;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const c0 = new THREE.Color(config.terrain.soilPalette[0]);
    const c2 = new THREE.Color(config.terrain.soilPalette[2]);

    let state = (config.terrain.seed ^ 0x9e3779b9) >>> 0;
    const rand = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const isEarth = config.id === "earth";
    const isSteppe = isEarth && !site.hasOcean;
    let activeCount = 0;

    for (let i = 0; i < BOULDER_COUNT; i++) {
      const angle = rand() * Math.PI * 2;
      const radius = 78 + Math.pow(rand(), 1.2) * 1050;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;

      if (isEarth) {
        if (Math.abs(z - 78) < 28 || i >= (isSteppe ? 72 : 48)) {
          continue;
        }
        if (!isSteppe && x > 250) {
          continue;
        }
      }

      const y = samplePlanetTerrainHeight(x, z, config, noise, site);
      const scaleBase = (0.6 + Math.pow(rand(), 2.2) * 4.5) * (isEarth ? 0.42 : 1.0);
      dummy.position.set(x, y + scaleBase * 0.28, z);
      dummy.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
      dummy.scale.set(
        scaleBase * (0.8 + rand() * 0.6),
        scaleBase * (0.45 + rand() * 0.45),
        scaleBase * (0.8 + rand() * 0.6)
      );
      dummy.updateMatrix();
      this.boulderMesh.setMatrixAt(activeCount, dummy.matrix);

      color.copy(c2).lerp(c0, rand() * 0.65);
      this.boulderMesh.setColorAt(activeCount, color);
      activeCount += 1;
    }
    this.boulderMesh.count = activeCount;
    this.boulderMesh.instanceMatrix.needsUpdate = true;
    if (this.boulderMesh.instanceColor) {
      this.boulderMesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const item of this.ringMeshes) {
      item.mesh.geometry.dispose();
    }
    this.ringMeshes = [];
    this.innerTerrainMaterial.dispose();
    this.outerTerrainMaterial.dispose();
    this.disposeEarthPbr();
    disposeTextureSet(this.terrainTextures);
    this.terrainTextures = null;

    this.boulderGeometry.dispose();
    this.boulderMaterial.dispose();
  }
}
