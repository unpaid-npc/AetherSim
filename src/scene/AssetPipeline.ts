import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

export interface AssetLoadOptions {
  maxAnisotropy?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

interface CachedAssetEntry {
  url: string;
  template: THREE.Group;
  vramBytes: number;
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
}

const TEXTURE_MAP_KEYS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "bumpMap",
  "alphaMap",
  "displacementMap",
] as const;

export function estimateGeometryBytes(geom: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const attr of Object.values(geom.attributes)) {
    if (attr && attr.array && typeof attr.array.byteLength === "number") {
      bytes += attr.array.byteLength;
    }
  }
  if (geom.index && geom.index.array && typeof geom.index.array.byteLength === "number") {
    bytes += geom.index.array.byteLength;
  }
  return bytes;
}

export function estimateTextureBytes(tex: THREE.Texture): number {
  const mipFactor = tex.generateMipmaps ? 1.334 : 1.0;
  if ("isCompressedTexture" in tex && (tex as THREE.CompressedTexture).isCompressedTexture) {
    const mipmaps = (tex as THREE.CompressedTexture).mipmaps;
    if (Array.isArray(mipmaps) && mipmaps.length > 0) {
      let sum = 0;
      for (const mip of mipmaps) {
        if (mip && mip.data && typeof mip.data.byteLength === "number") {
          sum += mip.data.byteLength;
        }
      }
      if (sum > 0) return sum;
    }
  }
  const img = tex.image as { width?: number; height?: number } | undefined;
  const w = typeof img?.width === "number" && img.width > 0 ? img.width : 0;
  const h = typeof img?.height === "number" && img.height > 0 ? img.height : 0;
  if (w === 0 || h === 0) {
    return 0;
  }
  return Math.round(w * h * 4 * mipFactor);
}

export function collectAndEstimateObjectResources(root: THREE.Object3D): {
  vramBytes: number;
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
} {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.geometry instanceof THREE.BufferGeometry) {
      geometries.add(obj.geometry);
    }
    const matList = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of matList) {
      if (!mat) continue;
      materials.add(mat);
      const record = mat as unknown as Record<string, unknown>;
      for (const key of TEXTURE_MAP_KEYS) {
        const maybeTex = record[key];
        if (maybeTex instanceof THREE.Texture) {
          textures.add(maybeTex);
        }
      }
    }
  });

  let vramBytes = 0;
  for (const g of geometries) {
    vramBytes += estimateGeometryBytes(g);
  }
  for (const t of textures) {
    vramBytes += estimateTextureBytes(t);
  }
  return { vramBytes, geometries, materials, textures };
}

/**
 * Offline-CSP-safe glTF/GLB + Draco + KTX2 asset pipeline with template caching,
 * anisotropy/shadow normalization, VRAM accounting, and deterministic disposal.
 */
export class AssetPipeline {
  private readonly gltfLoader: GLTFLoader;
  private readonly dracoLoader: DRACOLoader;
  private readonly ktx2Loader: KTX2Loader;
  private readonly cache = new Map<string, CachedAssetEntry>();
  private readonly inflight = new Map<string, Promise<CachedAssetEntry | null>>();
  private readonly defaultMaxAnisotropy: number;
  private disposed = false;

  constructor(
    renderer?: THREE.WebGLRenderer | null,
    decoderBasePath = "./decoders/"
  ) {
    const base = decoderBasePath.endsWith("/") ? decoderBasePath : `${decoderBasePath}/`;

    this.dracoLoader = new DRACOLoader();
    this.dracoLoader.setDecoderPath(`${base}draco/`);

    this.ktx2Loader = new KTX2Loader();
    this.ktx2Loader.setTranscoderPath(`${base}basis/`);
    if (renderer) {
      try {
        this.ktx2Loader.detectSupport(renderer);
      } catch {
        // Headless or restricted WebGL context — KTX2 support stays gracefully unavailable
      }
    }

    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setDRACOLoader(this.dracoLoader);
    this.gltfLoader.setKTX2Loader(this.ktx2Loader);

    this.defaultMaxAnisotropy = renderer
      ? Math.min(8, Math.max(1, renderer.capabilities.getMaxAnisotropy()))
      : 4;
  }

  /**
   * Registers an already-built Object3D template under a URL key (useful for
   * deterministic unit testing and procedural fallback caching).
   */
  registerTemplate(url: string, template: THREE.Group): void {
    if (this.disposed) return;
    const prev = this.cache.get(url);
    if (prev) {
      this.disposeEntry(prev);
    }
    const { vramBytes, geometries, materials, textures } =
      collectAndEstimateObjectResources(template);
    this.cache.set(url, {
      url,
      template,
      vramBytes,
      geometries,
      materials,
      textures,
    });
  }

  hasCachedAsset(url: string): boolean {
    return this.cache.has(url);
  }

  getLoadedAssetCount(): number {
    return this.cache.size;
  }

  getLoadedUrls(): string[] {
    return Array.from(this.cache.keys());
  }

  getEstimatedVramBytes(): number {
    let total = 0;
    for (const entry of this.cache.values()) {
      total += entry.vramBytes;
    }
    return total;
  }

  private normalizeInstance(
    instance: THREE.Group,
    options?: AssetLoadOptions
  ): THREE.Group {
    const aniso = Math.min(8, Math.max(1, options?.maxAnisotropy ?? this.defaultMaxAnisotropy));
    const castShadow = options?.castShadow ?? true;
    const receiveShadow = options?.receiveShadow ?? true;

    instance.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.castShadow = castShadow;
      obj.receiveShadow = receiveShadow;
      const matList = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of matList) {
        if (!mat) continue;
        const rec = mat as unknown as Record<string, unknown>;
        for (const key of TEXTURE_MAP_KEYS) {
          const tex = rec[key];
          if (tex instanceof THREE.Texture) {
            tex.anisotropy = Math.min(tex.anisotropy || aniso, aniso);
          }
        }
      }
    });
    return instance;
  }

  private loadTemplate(url: string): Promise<CachedAssetEntry | null> {
    if (this.disposed) {
      return Promise.resolve(null);
    }
    const cached = this.cache.get(url);
    if (cached) {
      return Promise.resolve(cached);
    }
    const pending = this.inflight.get(url);
    if (pending) {
      return pending;
    }

    // Headless Node/Vitest environments without browser fetch or relative URL support degrade cleanly
    if (typeof fetch !== "function" || typeof window === "undefined") {
      return Promise.resolve(null);
    }

    const promise = new Promise<CachedAssetEntry | null>((resolve) => {
      try {
        this.gltfLoader.load(
          url,
          (gltf) => {
            this.inflight.delete(url);
            if (this.disposed) {
              const res = collectAndEstimateObjectResources(gltf.scene);
              for (const g of res.geometries) g.dispose();
              for (const m of res.materials) m.dispose();
              for (const t of res.textures) t.dispose();
              resolve(null);
              return;
            }
            const template = gltf.scene;
            const { vramBytes, geometries, materials, textures } =
              collectAndEstimateObjectResources(template);
            const entry: CachedAssetEntry = {
              url,
              template,
              vramBytes,
              geometries,
              materials,
              textures,
            };
            this.cache.set(url, entry);
            resolve(entry);
          },
          undefined,
          () => {
            this.inflight.delete(url);
            resolve(null);
          }
        );
      } catch {
        this.inflight.delete(url);
        resolve(null);
      }
    });

    this.inflight.set(url, promise);
    return promise;
  }

  /**
   * Loads (or retrieves from cache) a glTF/GLB asset and returns a cleanly cloned
   * `THREE.Group` instance sharing the cached geometries/textures. Never rejects.
   */
  async loadModelInstance(
    url: string,
    options?: AssetLoadOptions
  ): Promise<THREE.Group | null> {
    const entry = await this.loadTemplate(url);
    if (!entry || this.disposed) {
      return null;
    }
    const clone = entry.template.clone(true);
    return this.normalizeInstance(clone, options);
  }

  private disposeEntry(entry: CachedAssetEntry): void {
    for (const g of entry.geometries) {
      g.dispose();
    }
    for (const m of entry.materials) {
      m.dispose();
    }
    for (const t of entry.textures) {
      t.dispose();
    }
  }

  disposeAll(): void {
    this.disposed = true;
    for (const entry of this.cache.values()) {
      this.disposeEntry(entry);
    }
    this.cache.clear();
    this.inflight.clear();
    this.dracoLoader.dispose();
    this.ktx2Loader.dispose();
  }
}
