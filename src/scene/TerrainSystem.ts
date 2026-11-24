import * as THREE from "three";
import type { PlanetConfig } from "../config/planets";
import { SeededNoise2D, samplePlanetTerrainHeight } from "../utils/noise";
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
}

const RING_SPECS: readonly RingSpec[] = [
  { innerRadius: 0, outerRadius: 280, thetaSegments: 128, radialSegments: 48, receiveShadow: true },
  { innerRadius: 280, outerRadius: 1450, thetaSegments: 128, radialSegments: 40, receiveShadow: false },
  { innerRadius: 1450, outerRadius: 5000, thetaSegments: 128, radialSegments: 28, receiveShadow: false },
];

const BOULDER_COUNT = 220;

function buildRadialRingGeometry(spec: RingSpec): THREE.BufferGeometry {
  const { innerRadius, outerRadius, thetaSegments, radialSegments } = spec;
  const cols = thetaSegments + 1;
  const rows = radialSegments + 1;
  const vertCount = cols * rows;

  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices: number[] = [];

  for (let rIdx = 0; rIdx < rows; rIdx++) {
    const t = rIdx / radialSegments;
    // Slight quadratic bias concentrates vertices near the inner boundary of each ring
    const radius =
      innerRadius === 0
        ? outerRadius * Math.pow(t, 1.3)
        : innerRadius + (outerRadius - innerRadius) * Math.pow(t, 1.25);

    for (let aIdx = 0; aIdx < cols; aIdx++) {
      const theta = (aIdx / thetaSegments) * Math.PI * 2;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;

      const vIdx = rIdx * cols + aIdx;
      positions[vIdx * 3] = x;
      positions[vIdx * 3 + 1] = 0;
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
  return geom;
}

function buildHorizonSkirtGeometry(): THREE.BufferGeometry {
  // Sweeping planetary curvature apron extending from r=4950m out to r=38000m
  const innerR = 4950;
  const outerR = 38000;
  const thetaSegs = 128;
  const radialSegs = 14;
  const cols = thetaSegs + 1;
  const rows = radialSegs + 1;
  const positions = new Float32Array(cols * rows * 3);
  const normals = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const indices: number[] = [];

  for (let rIdx = 0; rIdx < rows; rIdx++) {
    const t = rIdx / radialSegs;
    const radius = innerR + (outerR - innerR) * Math.pow(t, 1.45);
    // Gentle planetary curvature drop (-0.000018 * r^2) so high altitude shows a curved horizon
    const dropY = -Math.pow(Math.max(0, radius - innerR), 1.42) * 0.00052;
    for (let aIdx = 0; aIdx < cols; aIdx++) {
      const theta = (aIdx / thetaSegs) * Math.PI * 2;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;
      const vIdx = rIdx * cols + aIdx;
      positions[vIdx * 3] = x;
      positions[vIdx * 3 + 1] = dropY;
      positions[vIdx * 3 + 2] = z;
      normals[vIdx * 3] = 0;
      normals[vIdx * 3 + 1] = 1;
      normals[vIdx * 3 + 2] = 0;
      uvs[vIdx * 2] = x / 450;
      uvs[vIdx * 2 + 1] = z / 450;
    }
  }
  for (let rIdx = 0; rIdx < radialSegs; rIdx++) {
    for (let aIdx = 0; aIdx < thetaSegs; aIdx++) {
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
  return geom;
}

/** Manages multi-ring procedural terrain, planetary horizon skirt, and instanced boulders. */
export class TerrainSystem {
  public readonly group = new THREE.Group();

  private readonly ringMeshes: THREE.Mesh[] = [];
  private readonly terrainMaterial: THREE.MeshStandardMaterial;
  private terrainTextures: PbrTextureSet | null = null;

  private readonly horizonGeom: THREE.BufferGeometry;
  private readonly horizonMat: THREE.MeshStandardMaterial;
  private readonly horizonMesh: THREE.Mesh;

  private readonly boulderGeometry: THREE.DodecahedronGeometry;
  private readonly boulderMaterial: THREE.MeshStandardMaterial;
  private readonly boulderMesh: THREE.InstancedMesh;

  constructor(initialConfig: PlanetConfig, maxAnisotropy: number) {
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      metalness: 0.04,
      roughness: initialConfig.terrain.baseRoughness,
      normalScale: new THREE.Vector2(1.0, 1.0),
    });

    for (const spec of RING_SPECS) {
      const geom = buildRadialRingGeometry(spec);
      const mesh = new THREE.Mesh(geom, this.terrainMaterial);
      mesh.receiveShadow = spec.receiveShadow;
      mesh.castShadow = false;
      this.ringMeshes.push(mesh);
      this.group.add(mesh);
    }

    this.horizonGeom = buildHorizonSkirtGeometry();
    this.horizonMat = new THREE.MeshStandardMaterial({
      color: initialConfig.terrain.soilPalette[0],
      roughness: initialConfig.terrain.baseRoughness,
      metalness: 0.03,
    });
    this.horizonMesh = new THREE.Mesh(this.horizonGeom, this.horizonMat);
    this.horizonMesh.castShadow = false;
    this.horizonMesh.receiveShadow = false;
    this.group.add(this.horizonMesh);

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

  updatePlanet(config: PlanetConfig, maxAnisotropy: number): void {
    const noise = new SeededNoise2D(config.terrain.seed);

    for (const mesh of this.ringMeshes) {
      const posAttr = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i);
        const z = posAttr.getZ(i);
        const y = samplePlanetTerrainHeight(x, z, config, noise);
        posAttr.setY(i, y);
      }
      posAttr.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    }

    const nextTerrainTex = generatePlanetTextureSet(config, maxAnisotropy);
    this.terrainMaterial.map = nextTerrainTex.albedoMap;
    this.terrainMaterial.normalMap = nextTerrainTex.normalMap;
    this.terrainMaterial.roughnessMap = nextTerrainTex.roughnessMap;
    this.terrainMaterial.roughness = config.terrain.baseRoughness;
    this.terrainMaterial.needsUpdate = true;
    disposeTextureSet(this.terrainTextures);
    this.terrainTextures = nextTerrainTex;

    this.horizonMat.color.set(config.terrain.soilPalette[0]);
    this.horizonMat.roughness = config.terrain.baseRoughness;

    this.updateBoulders(config, noise);
  }

  private updateBoulders(config: PlanetConfig, noise: SeededNoise2D): void {
    this.boulderMaterial.color.set(config.terrain.soilPalette[2]);
    this.boulderMaterial.roughness = config.terrain.baseRoughness;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const c0 = new THREE.Color(config.terrain.soilPalette[0]);
    const c2 = new THREE.Color(config.terrain.soilPalette[2]);

    // Deterministic boulder scatter outside r > 76 m
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
    for (const mesh of this.ringMeshes) {
      mesh.geometry.dispose();
    }
    this.terrainMaterial.dispose();
    disposeTextureSet(this.terrainTextures);
    this.terrainTextures = null;

    this.horizonGeom.dispose();
    this.horizonMat.dispose();

    this.boulderGeometry.dispose();
    this.boulderMaterial.dispose();
  }
}
