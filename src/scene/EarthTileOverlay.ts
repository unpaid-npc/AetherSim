import * as THREE from "three";
import { type PlanetConfig, getPlanetConfig } from "../config/planets";
import {
  computeLaunchSiteZenithQuaternion,
  geoToSphereUnitVector,
} from "./earthGeography";

const TILE_FETCH_TIMEOUT_MS = 3500;

interface TileRingSpec {
  readonly zoom: number;
  readonly gridSpan: number; // e.g. 5 => 5x5 (~45 km at z=12), 3 => 3x3 (~420 km at z=8)
  readonly compositePx: number;
  readonly recessM: number;
  readonly fadeInStartM: number;
  readonly fadeInEndM: number;
  readonly fadeOutStartM: number;
  readonly fadeOutEndM: number;
  readonly renderOrder: number;
}

const RING_SPECS: readonly TileRingSpec[] = [
  // Inner 10m Sentinel-2 Cloudless Boca Chica coast & Padre Island (~45 km)
  {
    zoom: 12,
    gridSpan: 5,
    compositePx: 1024,
    recessM: 120,
    fadeInStartM: 4_000,
    fadeInEndM: 9_000,
    fadeOutStartM: 35_000,
    fadeOutEndM: 65_000,
    renderOrder: 2,
  },
  // Outer regional Gulf Coast ring (~420 km) bridging coast into 4K NASA Earth globe
  {
    zoom: 8,
    gridSpan: 3,
    compositePx: 1024,
    recessM: 450,
    fadeInStartM: 22_000,
    fadeInEndM: 45_000,
    fadeOutStartM: 240_000,
    fadeOutEndM: 420_000,
    renderOrder: 1,
  },
];

function lonLatToTileXY(lonDeg: number, latDeg: number, zoom: number): [number, number] {
  const n = 1 << zoom;
  const x = Math.floor(((lonDeg + 180) / 360) * n);
  const latRad = (latDeg * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return [
    Math.max(0, Math.min(n - 1, x)),
    Math.max(0, Math.min(n - 1, y)),
  ];
}

function tileXYToLonLat(fx: number, fy: number, zoom: number): [number, number] {
  const n = 1 << zoom;
  const lonDeg = (fx / n) * 360 - 180;
  const nRad = Math.PI - (2 * Math.PI * fy) / n;
  const latDeg = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(nRad) - Math.exp(-nRad)));
  return [latDeg, lonDeg];
}

function buildCurvedTileCapGeometry(
  earthConfig: PlanetConfig,
  txMin: number,
  tyMin: number,
  zoom: number,
  gridSpan: number,
  recessM: number,
  segs = 32
): THREE.BufferGeometry {
  const cols = segs + 1;
  const rows = segs + 1;
  const count = cols * rows;

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const indices: number[] = [];

  const R = earthConfig.scale.simRadiusM;
  const capRadius = Math.max(1000, R - recessM);
  const { latDeg: siteLat, lonDeg: siteLon } = earthConfig.scale.launchSiteCoords;
  const zenithQ = computeLaunchSiteZenithQuaternion(siteLat, siteLon);
  const v = new THREE.Vector3();

  for (let row = 0; row < rows; row++) {
    const tv = row / segs;
    const fy = tyMin + tv * gridSpan;
    for (let col = 0; col < cols; col++) {
      const tu = col / segs;
      const fx = txMin + tu * gridSpan;

      const [lat, lon] = tileXYToLonLat(fx, fy, zoom);
      const [sx, sy, sz] = geoToSphereUnitVector(lat, lon);
      v.set(sx, sy, sz).normalize().applyQuaternion(zenithQ);

      const idx = row * cols + col;
      positions[idx * 3] = v.x * capRadius;
      positions[idx * 3 + 1] = v.y * capRadius - R;
      positions[idx * 3 + 2] = v.z * capRadius;

      normals[idx * 3] = v.x;
      normals[idx * 3 + 1] = v.y;
      normals[idx * 3 + 2] = v.z;

      uvs[idx * 2] = tu;
      uvs[idx * 2 + 1] = 1 - tv;
    }
  }

  for (let row = 0; row < segs; row++) {
    for (let col = 0; col < segs; col++) {
      const a = row * cols + col;
      const b = (row + 1) * cols + col;
      const c = (row + 1) * cols + (col + 1);
      const d = row * cols + (col + 1);
      indices.push(a, d, b);
      indices.push(b, d, c);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeBoundingSphere();
  return geom;
}

const TILE_VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec2 vUv;
varying vec3 vWorldNormal;

void main() {
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
  #include <logdepthbuf_vertex>
}
`;

const TILE_FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform sampler2D uTileMap;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uHemiSkyColor;
uniform vec3 uHemiGroundColor;
uniform float uHemiIntensity;
uniform float uOpacity;

varying vec2 vUv;
varying vec3 vWorldNormal;

void main() {
  #include <logdepthbuf_fragment>

  if (uOpacity <= 0.005) {
    discard;
  }

  float edgeX = smoothstep(0.0, 0.16, vUv.x) * smoothstep(0.0, 0.16, 1.0 - vUv.x);
  float edgeY = smoothstep(0.0, 0.16, vUv.y) * smoothstep(0.0, 0.16, 1.0 - vUv.y);
  float alpha = edgeX * edgeY * uOpacity;
  if (alpha < 0.004) {
    discard;
  }

  vec3 N = normalize(vWorldNormal);
  vec3 L = normalize(uSunDirection);
  float NdotL = dot(N, L);
  float wrapDiff = max(0.0, (NdotL + 0.06) / 1.06);

  vec3 directIrrad = uSunColor * (uSunIntensity * wrapDiff * 0.33);
  vec3 hemiIrrad = mix(uHemiGroundColor, uHemiSkyColor, clamp(N.y * 0.5 + 0.5, 0.0, 1.0)) *
                   (uHemiIntensity * 0.34);

  vec3 albedo = texture2D(uTileMap, vUv).rgb;
  vec3 color = albedo * (directIrrad + hemiIrrad);

  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface TileRingRuntime {
  readonly spec: TileRingSpec;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;
  canvasTex: THREE.CanvasTexture | null;
  loaded: boolean;
}

/**
 * Multi-ring regional Sentinel-2 Cloudless (10 m, EOX) + NASA GIBS fallback satellite LOD:
 * - Inner 10 m z=12 ring (~45 km) blends local PBR beach into Texas Gulf Coast imagery
 * - Outer regional z=8 ring (~420 km) bridges coastline seamlessly into the 4K NASA globe
 * 100% offline-resilient with silent zero-error fallback.
 */
export class EarthTileOverlay {
  public readonly group = new THREE.Group();

  private readonly earthConfig: PlanetConfig;
  private readonly rings: TileRingRuntime[] = [];

  private activeLatDeg: number;
  private activeLonDeg: number;
  private fetchSeq = 0;
  private isEarthActive = false;
  private disposed = false;

  constructor(initialConfig: PlanetConfig) {
    this.earthConfig = getPlanetConfig("earth");
    const { latDeg, lonDeg } = this.earthConfig.scale.launchSiteCoords;
    this.activeLatDeg = latDeg;
    this.activeLonDeg = lonDeg;
    this.buildRings(latDeg, lonDeg);
    this.setPlanet(initialConfig);
  }

  private clearRings(): void {
    for (const r of this.rings) {
      this.group.remove(r.mesh);
      r.geometry.dispose();
      r.material.dispose();
      r.canvasTex?.dispose();
      r.canvasTex = null;
    }
    this.rings.length = 0;
  }

  private buildRings(latDeg: number, lonDeg: number): void {
    this.clearRings();
    const seq = ++this.fetchSeq;
    const sunVec = new THREE.Vector3(
      this.earthConfig.atmosphere.sunDirection[0],
      this.earthConfig.atmosphere.sunDirection[1],
      this.earthConfig.atmosphere.sunDirection[2]
    ).normalize();

    for (const spec of RING_SPECS) {
      const [cx, cy] = lonLatToTileXY(lonDeg, latDeg, spec.zoom);
      const half = Math.floor(spec.gridSpan / 2);
      const txMin = Math.max(0, cx - half);
      const tyMin = Math.max(0, cy - half);

      const geometry = buildCurvedTileCapGeometry(
        this.earthConfig,
        txMin,
        tyMin,
        spec.zoom,
        spec.gridSpan,
        spec.recessM,
        32
      );
      const material = new THREE.ShaderMaterial({
        vertexShader: TILE_VERTEX_SHADER,
        fragmentShader: TILE_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        fog: false,
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 2,
        uniforms: {
          uTileMap: { value: null },
          uSunDirection: { value: sunVec.clone() },
          uSunColor: { value: new THREE.Color(this.earthConfig.lighting.sunLightColor) },
          uSunIntensity: { value: this.earthConfig.lighting.sunLightIntensity },
          uHemiSkyColor: { value: new THREE.Color(this.earthConfig.lighting.hemiSkyColor) },
          uHemiGroundColor: { value: new THREE.Color(this.earthConfig.lighting.hemiGroundColor) },
          uHemiIntensity: { value: this.earthConfig.lighting.hemiIntensity },
          uOpacity: { value: 0 },
        },
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = spec.renderOrder;
      this.group.add(mesh);

      const runtime: TileRingRuntime = {
        spec,
        geometry,
        material,
        mesh,
        canvasTex: null,
        loaded: false,
      };
      this.rings.push(runtime);
      void this.fetchRingTilesAsync(runtime, txMin, tyMin, seq);
    }
  }

  setSiteCoords(latDeg: number, lonDeg: number): void {
    if (
      Math.abs(this.activeLatDeg - latDeg) < 1e-4 &&
      Math.abs(this.activeLonDeg - lonDeg) < 1e-4
    ) {
      return;
    }
    this.activeLatDeg = latDeg;
    this.activeLonDeg = lonDeg;
    this.buildRings(latDeg, lonDeg);
  }

  private async fetchTileUrl(url: string): Promise<ImageBitmap | null> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), TILE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { mode: "cors", signal: controller.signal });
      if (!res.ok) {
        return null;
      }
      const blob = await res.blob();
      return await createImageBitmap(blob);
    } catch {
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }

  private async fetchSingleTile(zoom: number, tx: number, ty: number): Promise<ImageBitmap | null> {
    const eoxUrl = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/${zoom}/${ty}/${tx}.jpg`;
    const eoxBmp = await this.fetchTileUrl(eoxUrl);
    if (eoxBmp) {
      return eoxBmp;
    }
    if (zoom <= 8) {
      const gibsUrl =
        `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/` +
        `BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/${zoom}/${ty}/${tx}.jpg`;
      return this.fetchTileUrl(gibsUrl);
    }
    return null;
  }

  private async fetchRingTilesAsync(
    ring: TileRingRuntime,
    txMin: number,
    tyMin: number,
    seq: number
  ): Promise<void> {
    const span = ring.spec.gridSpan;
    const jobs: Array<{ dx: number; dy: number; promise: Promise<ImageBitmap | null> }> = [];
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        jobs.push({
          dx,
          dy,
          promise: this.fetchSingleTile(ring.spec.zoom, txMin + dx, tyMin + dy),
        });
      }
    }

    const bitmaps = await Promise.all(jobs.map((j) => j.promise));
    if (this.disposed || seq !== this.fetchSeq) {
      for (const b of bitmaps) {
        b?.close();
      }
      return;
    }

    const centerIdx = Math.floor((span * span) / 2);
    const successCount = bitmaps.filter(Boolean).length;
    const minNeeded = Math.ceil(span * span * 0.6);
    if (!bitmaps[centerIdx] || successCount < minNeeded) {
      for (const b of bitmaps) {
        b?.close();
      }
      return;
    }

    const px = ring.spec.compositePx;
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      for (const b of bitmaps) {
        b?.close();
      }
      return;
    }

    ctx.fillStyle = "#14345a";
    ctx.fillRect(0, 0, px, px);
    const tilePx = px / span;

    for (let i = 0; i < jobs.length; i++) {
      const bmp = bitmaps[i];
      if (!bmp) continue;
      const { dx, dy } = jobs[i];
      ctx.drawImage(bmp, dx * tilePx, dy * tilePx, tilePx + 0.5, tilePx + 0.5);
      bmp.close();
    }

    ring.canvasTex = new THREE.CanvasTexture(canvas);
    ring.canvasTex.colorSpace = THREE.SRGBColorSpace;
    ring.canvasTex.wrapS = THREE.ClampToEdgeWrapping;
    ring.canvasTex.wrapT = THREE.ClampToEdgeWrapping;
    ring.canvasTex.generateMipmaps = true;
    ring.canvasTex.minFilter = THREE.LinearMipmapLinearFilter;
    ring.canvasTex.magFilter = THREE.LinearFilter;
    ring.canvasTex.needsUpdate = true;

    ring.material.uniforms.uTileMap.value = ring.canvasTex;
    ring.loaded = true;
  }

  isLoaded(): boolean {
    return this.rings.some((r) => r.loaded);
  }

  setPlanet(config: PlanetConfig): void {
    this.isEarthActive = config.id === "earth";
    this.group.visible = this.isEarthActive;
  }

  update(camAltM: number): void {
    if (!this.isEarthActive) {
      return;
    }
    for (const r of this.rings) {
      if (!r.loaded) {
        r.mesh.visible = false;
        continue;
      }
      const { fadeInStartM, fadeInEndM, fadeOutStartM, fadeOutEndM } = r.spec;
      const tIn = Math.max(0, Math.min(1, (camAltM - fadeInStartM) / (fadeInEndM - fadeInStartM)));
      const tOut =
        1 - Math.max(0, Math.min(1, (camAltM - fadeOutStartM) / (fadeOutEndM - fadeOutStartM)));
      const smoothIn = tIn * tIn * (3 - 2 * tIn);
      const smoothOut = tOut * tOut * (3 - 2 * tOut);
      const opacity = smoothIn * smoothOut;
      r.material.uniforms.uOpacity.value = opacity;
      r.mesh.visible = opacity > 0.006;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearRings();
  }
}
