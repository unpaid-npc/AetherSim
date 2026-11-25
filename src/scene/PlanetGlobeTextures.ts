import * as THREE from "three";
import type { PlanetConfig, PlanetId } from "../config/planets";
import type { QualityPreset } from "../effects/PropulsionEffects";
import { SeededNoise2D, smoothstep } from "../utils/noise";
import { EARTH_CITY_CLUSTERS, EARTH_CONTINENT_POLYGONS } from "./earthGeography";

export interface PlanetGlobeTextureSet {
  readonly albedoMap: THREE.Texture;
  readonly roughnessMap: THREE.Texture;
  readonly specularMap: THREE.Texture;
  readonly bumpMap: THREE.Texture;
  readonly cloudMap: THREE.Texture | null;
  readonly nightLightsMap: THREE.Texture | null;
  readonly isExternal4K: boolean;
  readonly siteTintColor: THREE.Color;
}

const cached4KBundles = new Map<PlanetId, PlanetGlobeTextureSet>();
const inflight4KLoads = new Map<PlanetId, Promise<PlanetGlobeTextureSet | null>>();

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function mix3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number
): [number, number, number] {
  const k = clamp(t, 0, 1);
  return [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to acquire 2D canvas context for globe texture");
  }
  return [canvas, ctx];
}

function configureTextureParams(
  tex: THREE.Texture,
  colorSpace: THREE.ColorSpace,
  maxAnisotropy: number
): void {
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = Math.min(16, Math.max(1, maxAnisotropy));
  tex.needsUpdate = true;
}

function configureGlobeTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  maxAnisotropy: number
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  configureTextureParams(tex, colorSpace, maxAnisotropy);
  return tex;
}

function lonToX(lonDeg: number, w: number): number {
  return ((lonDeg + 180) / 360) * w;
}

function latToY(latDeg: number, h: number): number {
  return ((90 - latDeg) / 180) * h;
}

function buildSeamlessNoiseGrid(
  noise: SeededNoise2D,
  gw: number,
  gh: number,
  freq: number,
  octaves: number
): Float32Array {
  const grid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const latRad = (0.5 - (gy + 0.5) / gh) * Math.PI;
    const cosLat = Math.cos(latRad);
    const sinLat = Math.sin(latRad);
    for (let gx = 0; gx < gw; gx++) {
      const lonRad = (gx / gw) * Math.PI * 2;
      const sx = Math.cos(lonRad) * cosLat * freq;
      const sy = Math.sin(lonRad) * cosLat * freq;
      const sz = sinLat * freq;
      grid[gy * gw + gx] =
        noise.fbm(sx + sz * 0.67, sy - sz * 0.53, octaves, 2.05, 0.5) * 0.5 + 0.5;
    }
  }
  return grid;
}

function sampleGridBilinear(grid: Float32Array, gw: number, gh: number, u: number, v: number): number {
  const fx = ((u % 1 + 1) % 1) * gw;
  const fy = clamp(v * (gh - 1), 0, gh - 1.001);
  const x0 = Math.floor(fx) % gw;
  const x1 = (x0 + 1) % gw;
  const y0 = Math.floor(fy);
  const y1 = Math.min(gh - 1, y0 + 1);
  const tx = fx - Math.floor(fx);
  const ty = fy - y0;
  const a = grid[y0 * gw + x0] * (1 - tx) + grid[y0 * gw + x1] * tx;
  const b = grid[y1 * gw + x0] * (1 - tx) + grid[y1 * gw + x1] * tx;
  return a * (1 - ty) + b * ty;
}

function sampleChannelBilinear(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  u: number,
  v: number
): number {
  const fx = ((u % 1 + 1) % 1) * w;
  const fy = clamp(v * (h - 1), 0, h - 1.001);
  const x0 = Math.floor(fx) % w;
  const x1 = (x0 + 1) % w;
  const y0 = Math.floor(fy);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - Math.floor(fx);
  const ty = fy - y0;
  const c00 = data[(y0 * w + x0) * 4] / 255;
  const c10 = data[(y0 * w + x1) * 4] / 255;
  const c01 = data[(y1 * w + x0) * 4] / 255;
  const c11 = data[(y1 * w + x1) * 4] / 255;
  const a = c00 * (1 - tx) + c10 * tx;
  const b = c01 * (1 - tx) + c11 * tx;
  return a * (1 - ty) + b * ty;
}

function angularDegDist(lon1: number, lat1: number, lon2: number, lat2: number): number {
  let dLon = Math.abs(lon1 - lon2);
  if (dLon > 180) dLon = 360 - dLon;
  const meanLatCos = Math.max(0.2, Math.cos(((lat1 + lat2) * 0.5 * Math.PI) / 180));
  return Math.hypot(dLon * meanLatCos, lat1 - lat2);
}

export function getDefaultSiteTintColor(planetId: PlanetId): THREE.Color {
  if (planetId === "earth") return new THREE.Color("#6e7356");
  if (planetId === "mars") return new THREE.Color("#9e5939");
  return new THREE.Color("#888c92");
}

function sampleSiteRgbFromImage(
  img: HTMLImageElement | HTMLCanvasElement,
  latDeg: number,
  lonDeg: number
): THREE.Color {
  const w = img instanceof HTMLCanvasElement ? img.width : img.naturalWidth || img.width;
  const h = img instanceof HTMLCanvasElement ? img.height : img.naturalHeight || img.height;
  if (w < 8 || h < 8) {
    return new THREE.Color("#909090");
  }
  const u = (((lonDeg + 180) / 360) % 1 + 1) % 1;
  const v = clamp((90 - latDeg) / 180, 0.002, 0.998);
  const cx = Math.floor(u * w);
  const cy = Math.floor(v * h);
  const patch = 7;
  const half = Math.floor(patch / 2);

  const [c, ctx] = makeCanvas(patch, patch);
  const sx = clamp(cx - half, 0, Math.max(0, w - patch));
  const sy = clamp(cy - half, 0, Math.max(0, h - patch));
  ctx.drawImage(img, sx, sy, patch, patch, 0, 0, patch, patch);
  const data = ctx.getImageData(0, 0, patch, patch).data;

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  const pxCount = patch * patch;
  for (let i = 0; i < data.length; i += 4) {
    rSum += data[i];
    gSum += data[i + 1];
    bSum += data[i + 2];
  }
  c.width = 0;
  c.height = 0;

  const col = new THREE.Color();
  col.setRGB(rSum / (pxCount * 255), gSum / (pxCount * 255), bSum / (pxCount * 255), THREE.SRGBColorSpace);
  return col;
}

function generateEarthPlaceholderTextures(
  albedoW: number,
  albedoH: number,
  auxW: number,
  auxH: number,
  maxAnisotropy: number,
  siteCoords: { latDeg: number; lonDeg: number }
): PlanetGlobeTextureSet {
  const noiseMacro = new SeededNoise2D(73091);

  const [, landCtx] = makeCanvas(albedoW, albedoH);
  landCtx.fillStyle = "#000000";
  landCtx.fillRect(0, 0, albedoW, albedoH);
  landCtx.fillStyle = "#ffffff";
  for (const poly of EARTH_CONTINENT_POLYGONS) {
    const pts = poly.points;
    landCtx.beginPath();
    pts.forEach(([lon, lat], idx) => {
      const px = lonToX(lon, albedoW);
      const py = latToY(lat, albedoH);
      if (idx === 0) landCtx.moveTo(px, py);
      else landCtx.lineTo(px, py);
    });
    landCtx.closePath();
    landCtx.fill();
  }
  const landPixels = landCtx.getImageData(0, 0, albedoW, albedoH).data;

  const macroGrid = buildSeamlessNoiseGrid(noiseMacro, 128, 64, 3.2, 3);
  const [albedoCanvas, albedoCtx] = makeCanvas(albedoW, albedoH);
  const albedoImg = albedoCtx.createImageData(albedoW, albedoH);
  const aData = albedoImg.data;

  const [specCanvas, specCtx] = makeCanvas(auxW, auxH);
  const specImg = specCtx.createImageData(auxW, auxH);
  const sData = specImg.data;

  const [bumpCanvas, bumpCtx] = makeCanvas(auxW, auxH);
  const bumpImg = bumpCtx.createImageData(auxW, auxH);
  const bData = bumpImg.data;

  const [nightCanvas, nightCtx] = makeCanvas(auxW, auxH);
  const nightImg = nightCtx.createImageData(auxW, auxH);
  const nData = nightImg.data;

  const [cloudCanvas, cloudCtx] = makeCanvas(auxW, auxH);
  const cloudImg = cloudCtx.createImageData(auxW, auxH);
  const cData = cloudImg.data;

  const oceanRgb: [number, number, number] = [14, 52, 98];
  const forestRgb: [number, number, number] = [44, 92, 48];
  const desertRgb: [number, number, number] = [180, 148, 102];
  const snowRgb: [number, number, number] = [236, 242, 248];

  for (let y = 0; y < albedoH; y++) {
    const v = y / albedoH;
    const latDeg = 90 - v * 180;
    const absLat = Math.abs(latDeg);
    for (let x = 0; x < albedoW; x++) {
      const u = x / albedoW;
      const off = (y * albedoW + x) * 4;
      const rawLand = landPixels[off] / 255;
      const nMacro = sampleGridBilinear(macroGrid, 128, 64, u, v);
      const landMask = smoothstep(0.35, 0.65, rawLand);
      const polar = smoothstep(70, 82, absLat);
      let landCol = mix3(forestRgb, desertRgb, smoothstep(0.45, 0.78, nMacro));
      landCol = mix3(landCol, snowRgb, polar);
      const rgb = mix3(oceanRgb, landCol, landMask);
      aData[off] = Math.round(rgb[0]);
      aData[off + 1] = Math.round(rgb[1]);
      aData[off + 2] = Math.round(rgb[2]);
      aData[off + 3] = 255;
    }
  }
  albedoCtx.putImageData(albedoImg, 0, 0);

  for (let y = 0; y < auxH; y++) {
    const v = y / auxH;
    const latDeg = 90 - v * 180;
    for (let x = 0; x < auxW; x++) {
      const u = x / auxW;
      const lonDeg = u * 360 - 180;
      const off = (y * auxW + x) * 4;
      const rawLand = sampleChannelBilinear(landPixels, albedoW, albedoH, u, v);
      const nMacro = sampleGridBilinear(macroGrid, 128, 64, u, v);
      const specByte = Math.round((1 - rawLand) * 240);
      sData[off] = specByte;
      sData[off + 1] = specByte;
      sData[off + 2] = specByte;
      sData[off + 3] = 255;

      const bumpByte = Math.round((0.15 + rawLand * 0.7) * 255);
      bData[off] = bumpByte;
      bData[off + 1] = bumpByte;
      bData[off + 2] = bumpByte;
      bData[off + 3] = 255;

      const cloudAlpha = smoothstep(0.55, 0.85, nMacro);
      cData[off] = Math.round(cloudAlpha * 235);
      cData[off + 1] = Math.round(cloudAlpha * 240);
      cData[off + 2] = Math.round(cloudAlpha * 245);
      cData[off + 3] = 255;

      let lightStr = 0;
      if (rawLand > 0.3 && Math.abs(latDeg) < 64) {
        for (const c of EARTH_CITY_CLUSTERS) {
          const d = angularDegDist(lonDeg, latDeg, c.lon, c.lat);
          if (d < c.radiusDeg) {
            const falloff = 1 - d / c.radiusDeg;
            lightStr = Math.max(lightStr, falloff * falloff * c.intensity);
          }
        }
      }
      const nLum = clamp(lightStr, 0, 1);
      nData[off] = Math.round(nLum * 255);
      nData[off + 1] = Math.round(nLum * 204);
      nData[off + 2] = Math.round(nLum * 112);
      nData[off + 3] = 255;
    }
  }
  specCtx.putImageData(specImg, 0, 0);
  bumpCtx.putImageData(bumpImg, 0, 0);
  cloudCtx.putImageData(cloudImg, 0, 0);
  nightCtx.putImageData(nightImg, 0, 0);

  return {
    albedoMap: configureGlobeTexture(albedoCanvas, THREE.SRGBColorSpace, maxAnisotropy),
    roughnessMap: configureGlobeTexture(specCanvas, THREE.NoColorSpace, maxAnisotropy),
    specularMap: configureGlobeTexture(specCanvas, THREE.NoColorSpace, maxAnisotropy),
    bumpMap: configureGlobeTexture(bumpCanvas, THREE.NoColorSpace, maxAnisotropy),
    cloudMap: configureGlobeTexture(cloudCanvas, THREE.SRGBColorSpace, maxAnisotropy),
    nightLightsMap: configureGlobeTexture(nightCanvas, THREE.SRGBColorSpace, maxAnisotropy),
    isExternal4K: false,
    siteTintColor: sampleSiteRgbFromImage(albedoCanvas, siteCoords.latDeg, siteCoords.lonDeg),
  };
}

function generateMarsPlaceholderTextures(
  albedoW: number,
  albedoH: number,
  auxW: number,
  auxH: number,
  maxAnisotropy: number,
  siteCoords: { latDeg: number; lonDeg: number }
): PlanetGlobeTextureSet {
  const noiseMacro = new SeededNoise2D(42011);
  const macroGrid = buildSeamlessNoiseGrid(noiseMacro, 128, 64, 3.6, 3);

  const [albedoCanvas, albedoCtx] = makeCanvas(albedoW, albedoH);
  const albedoImg = albedoCtx.createImageData(albedoW, albedoH);
  const aData = albedoImg.data;
  const [bumpCanvas, bumpCtx] = makeCanvas(auxW, auxH);
  const bumpImg = bumpCtx.createImageData(auxW, auxH);
  const bData = bumpImg.data;

  const dustOchre: [number, number, number] = [194, 108, 64];
  const highlandsRust: [number, number, number] = [148, 72, 42];
  const polarIce: [number, number, number] = [238, 232, 226];

  for (let y = 0; y < albedoH; y++) {
    const v = y / albedoH;
    const latDeg = 90 - v * 180;
    for (let x = 0; x < albedoW; x++) {
      const u = x / albedoW;
      const nMacro = sampleGridBilinear(macroGrid, 128, 64, u, v);
      let rgb = mix3(highlandsRust, dustOchre, nMacro);
      rgb = mix3(rgb, polarIce, smoothstep(76, 84, Math.abs(latDeg)));
      const off = (y * albedoW + x) * 4;
      aData[off] = Math.round(rgb[0]);
      aData[off + 1] = Math.round(rgb[1]);
      aData[off + 2] = Math.round(rgb[2]);
      aData[off + 3] = 255;
    }
  }
  albedoCtx.putImageData(albedoImg, 0, 0);

  for (let i = 0; i < bData.length; i += 4) {
    bData[i] = 128;
    bData[i + 1] = 128;
    bData[i + 2] = 128;
    bData[i + 3] = 255;
  }
  bumpCtx.putImageData(bumpImg, 0, 0);

  const albedoMap = configureGlobeTexture(albedoCanvas, THREE.SRGBColorSpace, maxAnisotropy);
  const bumpMap = configureGlobeTexture(bumpCanvas, THREE.NoColorSpace, maxAnisotropy);
  return {
    albedoMap,
    roughnessMap: bumpMap,
    specularMap: bumpMap,
    bumpMap,
    cloudMap: null,
    nightLightsMap: null,
    isExternal4K: false,
    siteTintColor: sampleSiteRgbFromImage(albedoCanvas, siteCoords.latDeg, siteCoords.lonDeg),
  };
}

function generateMoonPlaceholderTextures(
  albedoW: number,
  albedoH: number,
  auxW: number,
  auxH: number,
  maxAnisotropy: number,
  siteCoords: { latDeg: number; lonDeg: number }
): PlanetGlobeTextureSet {
  const noiseMacro = new SeededNoise2D(91031);
  const macroGrid = buildSeamlessNoiseGrid(noiseMacro, 128, 64, 4.0, 3);

  const [albedoCanvas, albedoCtx] = makeCanvas(albedoW, albedoH);
  const albedoImg = albedoCtx.createImageData(albedoW, albedoH);
  const aData = albedoImg.data;
  const [bumpCanvas, bumpCtx] = makeCanvas(auxW, auxH);
  const bumpImg = bumpCtx.createImageData(auxW, auxH);
  const bData = bumpImg.data;

  const highlandLight: [number, number, number] = [178, 182, 188];
  const regolithMid: [number, number, number] = [122, 126, 132];

  for (let y = 0; y < albedoH; y++) {
    const v = y / albedoH;
    for (let x = 0; x < albedoW; x++) {
      const u = x / albedoW;
      const nMacro = sampleGridBilinear(macroGrid, 128, 64, u, v);
      const rgb = mix3(regolithMid, highlandLight, nMacro);
      const off = (y * albedoW + x) * 4;
      aData[off] = Math.round(rgb[0]);
      aData[off + 1] = Math.round(rgb[1]);
      aData[off + 2] = Math.round(rgb[2]);
      aData[off + 3] = 255;
    }
  }
  albedoCtx.putImageData(albedoImg, 0, 0);

  for (let i = 0; i < bData.length; i += 4) {
    bData[i] = 128;
    bData[i + 1] = 128;
    bData[i + 2] = 128;
    bData[i + 3] = 255;
  }
  bumpCtx.putImageData(bumpImg, 0, 0);

  const albedoMap = configureGlobeTexture(albedoCanvas, THREE.SRGBColorSpace, maxAnisotropy);
  const bumpMap = configureGlobeTexture(bumpCanvas, THREE.NoColorSpace, maxAnisotropy);
  return {
    albedoMap,
    roughnessMap: bumpMap,
    specularMap: bumpMap,
    bumpMap,
    cloudMap: null,
    nightLightsMap: null,
    isExternal4K: false,
    siteTintColor: sampleSiteRgbFromImage(albedoCanvas, siteCoords.latDeg, siteCoords.lonDeg),
  };
}

/** Generates instant fast procedural placeholder maps so startup never blocks waiting for 4K images. */
export function generatePlanetGlobeTextures(
  config: PlanetConfig,
  _quality: QualityPreset,
  maxAnisotropy: number
): PlanetGlobeTextureSet {
  const albedoW = 256;
  const albedoH = 128;
  const auxW = 128;
  const auxH = 64;

  if (config.id === "earth") {
    return generateEarthPlaceholderTextures(
      albedoW,
      albedoH,
      auxW,
      auxH,
      maxAnisotropy,
      config.scale.launchSiteCoords
    );
  }
  if (config.id === "mars") {
    return generateMarsPlaceholderTextures(
      albedoW,
      albedoH,
      auxW,
      auxH,
      maxAnisotropy,
      config.scale.launchSiteCoords
    );
  }
  return generateMoonPlaceholderTextures(
    albedoW,
    albedoH,
    auxW,
    auxH,
    maxAnisotropy,
    config.scale.launchSiteCoords
  );
}

function loadTextureUrl(
  loader: THREE.TextureLoader,
  url: string,
  colorSpace: THREE.ColorSpace,
  maxAnisotropy: number
): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (tex) => {
        configureTextureParams(tex, colorSpace, maxAnisotropy);
        resolve(tex);
      },
      undefined,
      (err) => reject(err)
    );
  });
}

/**
 * Asynchronously loads and caches the real 4K NASA-derived planetary satellite maps from
 * `./textures/planets/` (relative path works identically under Vite dev & Electron `file://`).
 */
export async function loadPlanet4KTextures(
  config: PlanetConfig,
  maxAnisotropy: number
): Promise<PlanetGlobeTextureSet | null> {
  const cached = cached4KBundles.get(config.id);
  if (cached) {
    return cached;
  }
  const existing = inflight4KLoads.get(config.id);
  if (existing) {
    return existing;
  }

  const job = (async (): Promise<PlanetGlobeTextureSet | null> => {
    try {
      const loader = new THREE.TextureLoader();
      if (config.id === "earth") {
        const [albedoMap, cloudMap, nightLightsMap, specularMap] = await Promise.all([
          loadTextureUrl(loader, "./textures/planets/earth_day_4k.jpg", THREE.SRGBColorSpace, maxAnisotropy),
          loadTextureUrl(loader, "./textures/planets/earth_clouds_4k.jpg", THREE.SRGBColorSpace, maxAnisotropy),
          loadTextureUrl(loader, "./textures/planets/earth_night_4k.jpg", THREE.SRGBColorSpace, maxAnisotropy),
          loadTextureUrl(loader, "./textures/planets/earth_specular_4k.jpg", THREE.NoColorSpace, maxAnisotropy),
        ]);
        const siteTintColor = sampleSiteRgbFromImage(
          albedoMap.image as HTMLImageElement,
          config.scale.launchSiteCoords.latDeg,
          config.scale.launchSiteCoords.lonDeg
        );
        const bundle: PlanetGlobeTextureSet = {
          albedoMap,
          roughnessMap: specularMap,
          specularMap,
          bumpMap: specularMap,
          cloudMap,
          nightLightsMap,
          isExternal4K: true,
          siteTintColor,
        };
        cached4KBundles.set(config.id, bundle);
        return bundle;
      }

      const dayUrl =
        config.id === "mars" ? "./textures/planets/mars_4k.jpg" : "./textures/planets/moon_4k.jpg";
      const albedoMap = await loadTextureUrl(loader, dayUrl, THREE.SRGBColorSpace, maxAnisotropy);
      const siteTintColor = sampleSiteRgbFromImage(
        albedoMap.image as HTMLImageElement,
        config.scale.launchSiteCoords.latDeg,
        config.scale.launchSiteCoords.lonDeg
      );
      const bundle: PlanetGlobeTextureSet = {
        albedoMap,
        roughnessMap: albedoMap,
        specularMap: albedoMap,
        bumpMap: albedoMap,
        cloudMap: null,
        nightLightsMap: null,
        isExternal4K: true,
        siteTintColor,
      };
      cached4KBundles.set(config.id, bundle);
      return bundle;
    } catch {
      return null;
    } finally {
      inflight4KLoads.delete(config.id);
    }
  })();

  inflight4KLoads.set(config.id, job);
  return job;
}

export function disposeGlobeTextureSet(set: PlanetGlobeTextureSet | null): void {
  if (!set || set.isExternal4K) {
    // External 4K texture sets remain cached across rapid planet switches.
    return;
  }
  set.albedoMap.dispose();
  set.roughnessMap.dispose();
  if (set.specularMap !== set.roughnessMap) {
    set.specularMap.dispose();
  }
  if (set.bumpMap !== set.roughnessMap && set.bumpMap !== set.albedoMap) {
    set.bumpMap.dispose();
  }
  set.cloudMap?.dispose();
  set.nightLightsMap?.dispose();
}
