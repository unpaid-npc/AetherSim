import * as THREE from "three";
import type { PlanetConfig } from "../config/planets";
import { SeededNoise2D, samplePlanetTerrainHeight, smoothstep } from "../utils/noise";
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
  noise: SeededNoise2D
): THREE.BufferGeometry {
  const { innerRadius, outerRadius, thetaSegments, radialSegments } = spec;
  const cols = thetaSegments + 1;
  const rows = radialSegments + 1;
  const vertCount = cols * rows;

  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices: number[] = [];

  const localR = config.scale.localTerrainRadiusM;

  for (let rIdx = 0; rIdx < rows; rIdx++) {
    const t = rIdx / radialSegments;
    const radius =
      innerRadius === 0
        ? outerRadius * Math.pow(t, 1.32)
        : innerRadius + (outerRadius - innerRadius) * Math.pow(t, 1.24);

    // Gentle -32m outer rim tuck matching the globe's -35m recess so there is zero gap
    const rimTuck = smoothstep(localR * 0.82, localR, radius) * 32;

    for (let aIdx = 0; aIdx < cols; aIdx++) {
      const theta = (aIdx / thetaSegments) * Math.PI * 2;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;
      const y = samplePlanetTerrainHeight(x, z, config, noise) - rimTuck;

      const vIdx = rIdx * cols + aIdx;
      positions[vIdx * 3] = x;
      positions[vIdx * 3 + 1] = y;
      positions[vIdx * 3 + 2] = z;

      normals[vIdx * 3] = 0;
      normals[vIdx * 3 + 1] = 1;
      normals[vIdx * 3 + 2] = 0;

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
  geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
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
  };
  private terrainTextures: PbrTextureSet | null = null;

  private readonly boulderGeometry: THREE.DodecahedronGeometry;
  private readonly boulderMaterial: THREE.MeshStandardMaterial;
  private readonly boulderMesh: THREE.InstancedMesh;

  private activeConfig: PlanetConfig;
  private activeNoise: SeededNoise2D;

  constructor(initialConfig: PlanetConfig, maxAnisotropy: number) {
    this.activeConfig = initialConfig;
    this.activeNoise = new SeededNoise2D(initialConfig.terrain.seed);

    this.innerTerrainMaterial = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      metalness: 0.04,
      roughness: initialConfig.terrain.baseRoughness,
      normalScale: new THREE.Vector2(1.0, 1.0),
    });

    this.outerUniforms = {
      uSatelliteTint: { value: getDefaultSiteTintColor(initialConfig.id) },
      uFeatherInner: { value: 5000.0 },
      uFeatherOuter: { value: initialConfig.scale.localTerrainRadiusM * 0.96 },
    };

    this.outerTerrainMaterial = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      transparent: true,
      depthWrite: false,
      metalness: 0.04,
      roughness: initialConfig.terrain.baseRoughness,
      normalScale: new THREE.Vector2(1.0, 1.0),
    });
    this.outerTerrainMaterial.customProgramCacheKey = () => "aethersim-outer-terrain-feather-v1";
    this.outerTerrainMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uSatelliteTint = this.outerUniforms.uSatelliteTint;
      shader.uniforms.uFeatherInner = this.outerUniforms.uFeatherInner;
      shader.uniforms.uFeatherOuter = this.outerUniforms.uFeatherOuter;

      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying float vRadialDist;"
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvRadialDist = length(transformed.xz);"
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform vec3 uSatelliteTint;\nuniform float uFeatherInner;\nuniform float uFeatherOuter;\nvarying float vRadialDist;"
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          float radialTintT = smoothstep(uFeatherInner, uFeatherOuter * 0.80, vRadialDist);
          diffuseColor.rgb = mix(diffuseColor.rgb, uSatelliteTint, radialTintT * 0.88);
          float radialAlpha = 1.0 - smoothstep(uFeatherInner, uFeatherOuter, vRadialDist);
          diffuseColor.a *= radialAlpha;`
        );
    };

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
    return samplePlanetTerrainHeight(x, z, this.activeConfig, this.activeNoise);
  }

  /** Tints the outer feather skirt to match the real RGB sampled from the 4K satellite map. */
  setSatelliteSiteTint(color: THREE.Color): void {
    this.outerUniforms.uSatelliteTint.value.copy(color);
  }

  setVisibilityForCameraAltitude(camAltM: number, _simRadiusM: number): void {
    this.boulderMesh.visible = camAltM < 2800;
    const fade = 1 - smoothstep(2500, 10000, camAltM);
    if (fade <= 0.005) {
      for (const { mesh } of this.ringMeshes) {
        mesh.visible = false;
      }
      return;
    }

    const isBlending = fade < 0.995;
    this.innerTerrainMaterial.transparent = isBlending;
    this.innerTerrainMaterial.opacity = isBlending ? fade : 1.0;
    this.innerTerrainMaterial.depthWrite = !isBlending;

    this.outerTerrainMaterial.opacity = fade;

    for (const { mesh } of this.ringMeshes) {
      mesh.visible = true;
    }
  }

  updatePlanet(config: PlanetConfig, maxAnisotropy: number): void {
    this.activeConfig = config;
    const noise = new SeededNoise2D(config.terrain.seed);
    this.activeNoise = noise;

    this.outerUniforms.uSatelliteTint.value.copy(getDefaultSiteTintColor(config.id));
    this.outerUniforms.uFeatherInner.value = 5000.0;
    this.outerUniforms.uFeatherOuter.value = config.scale.localTerrainRadiusM * 0.96;

    for (const old of this.ringMeshes) {
      this.group.remove(old.mesh);
      old.mesh.geometry.dispose();
    }
    this.ringMeshes = [];

    const specs = getRingSpecs(config.scale.localTerrainRadiusM);
    for (const spec of specs) {
      const geom = buildRadialRingGeometry(spec, config, noise);
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

    this.updateBoulders(config, noise);
  }

  private updateBoulders(config: PlanetConfig, noise: SeededNoise2D): void {
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

    for (let i = 0; i < BOULDER_COUNT; i++) {
      const angle = rand() * Math.PI * 2;
      const radius = 78 + Math.pow(rand(), 1.2) * 1050;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const y = samplePlanetTerrainHeight(x, z, config, noise);

      const scaleBase = 0.6 + Math.pow(rand(), 2.2) * 4.5;
      dummy.position.set(x, y + scaleBase * 0.28, z);
      dummy.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
      dummy.scale.set(
        scaleBase * (0.8 + rand() * 0.6),
        scaleBase * (0.45 + rand() * 0.45),
        scaleBase * (0.8 + rand() * 0.6)
      );
      dummy.updateMatrix();
      this.boulderMesh.setMatrixAt(i, dummy.matrix);

      color.copy(c2).lerp(c0, rand() * 0.65);
      this.boulderMesh.setColorAt(i, color);
    }
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
    disposeTextureSet(this.terrainTextures);
    this.terrainTextures = null;

    this.boulderGeometry.dispose();
    this.boulderMaterial.dispose();
  }
}
