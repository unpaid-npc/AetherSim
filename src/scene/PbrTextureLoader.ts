import * as THREE from "three";
import type { QualityPreset } from "../effects/PropulsionEffects";

export type PbrSurfacePrefix = "asphalt" | "concrete" | "sand" | "soil" | "metal_wall";

export interface PbrLoadedSet {
  readonly albedoMap: THREE.Texture;
  readonly normalMap: THREE.Texture;
  readonly roughnessMap: THREE.Texture;
}

const rawImageCache = new Map<string, Promise<HTMLImageElement | null>>();

function getResolutionForQuality(quality: QualityPreset): 2048 | 4096 {
  return quality === "high" ? 4096 : 2048;
}

function loadHtmlImage(url: string): Promise<HTMLImageElement | null> {
  if (typeof window === "undefined" || typeof Image === "undefined") {
    return Promise.resolve(null);
  }
  const cached = rawImageCache.get(url);
  if (cached) {
    return cached;
  }
  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  rawImageCache.set(url, promise);
  return promise;
}

function createScaledTextureFromImage(
  img: HTMLImageElement,
  targetSize: number,
  colorSpace: THREE.ColorSpace,
  repeatX: number,
  repeatY: number,
  maxAnisotropy: number,
  quality: QualityPreset
): THREE.Texture {
  let tex: THREE.Texture;
  if (targetSize >= img.naturalWidth && targetSize >= img.naturalHeight) {
    tex = new THREE.Texture(img);
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(img, 0, 0, targetSize, targetSize);
      tex = new THREE.CanvasTexture(canvas);
    } else {
      tex = new THREE.Texture(img);
    }
  }
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const maxAnisoCap = quality === "high" ? 16 : quality === "med" ? 8 : 4;
  tex.anisotropy = Math.min(maxAnisoCap, Math.max(1, maxAnisotropy));
  tex.needsUpdate = true;
  return tex;
}

/**
 * Asynchronously loads genuine 4K Poly Haven CC0 PBR texture triples (`diff`, `nor`, `rough`)
 * from `public/textures/pbr/`, scaling gracefully to 2048 px on LOW/MED to stay within 4 GB VRAM
 * and 50-60 FPS budgets while using native 4096x4096 on HIGH.
 */
export async function loadPbrTextureSet(
  prefix: PbrSurfacePrefix,
  repeatX: number,
  repeatY: number,
  maxAnisotropy: number,
  quality: QualityPreset
): Promise<PbrLoadedSet | null> {
  if (typeof window === "undefined") {
    return null;
  }

  const baseHref = window.location.href;
  const diffUrl = new URL(`./textures/pbr/${prefix}_diff_4k.jpg`, baseHref).href;
  const norUrl = new URL(`./textures/pbr/${prefix}_nor_4k.jpg`, baseHref).href;
  const roughUrl = new URL(`./textures/pbr/${prefix}_rough_4k.jpg`, baseHref).href;

  const [diffImg, norImg, roughImg] = await Promise.all([
    loadHtmlImage(diffUrl),
    loadHtmlImage(norUrl),
    loadHtmlImage(roughUrl),
  ]);

  if (!diffImg || !norImg || !roughImg) {
    return null;
  }

  const targetRes = getResolutionForQuality(quality);
  return {
    albedoMap: createScaledTextureFromImage(
      diffImg,
      targetRes,
      THREE.SRGBColorSpace,
      repeatX,
      repeatY,
      maxAnisotropy,
      quality
    ),
    normalMap: createScaledTextureFromImage(
      norImg,
      targetRes,
      THREE.NoColorSpace,
      repeatX,
      repeatY,
      maxAnisotropy,
      quality
    ),
    roughnessMap: createScaledTextureFromImage(
      roughImg,
      targetRes,
      THREE.NoColorSpace,
      repeatX,
      repeatY,
      maxAnisotropy,
      quality
    ),
  };
}
