import * as THREE from "three";
import {
  EARTH_LAUNCH_SITES,
  type LaunchSiteId,
} from "../config/launchSites";
import type { PlanetConfig } from "../config/planets";
import type { QualityPreset } from "../effects/PropulsionEffects";
import {
  createPlanetCloudMaterial,
  createPlanetSurfaceMaterial,
} from "../shaders/planetGlobeShader";
import { createPlanetLimbMaterial } from "../shaders/planetLimbShader";
import {
  computeLaunchSiteZenithQuaternion,
  geoToSphereUnitVector,
} from "./earthGeography";
import {
  type PlanetGlobeTextureSet,
  disposeGlobeTextureSet,
  generatePlanetGlobeTextures,
  getDefaultSiteTintColor,
  loadPlanet4KTextures,
} from "./PlanetGlobeTextures";

function getIcosaDetail(quality: QualityPreset, isSurface: boolean): number {
  if (isSurface) {
    if (quality === "low") return 32;
    if (quality === "med") return 48;
    return 64;
  }
  if (quality === "low") return 20;
  if (quality === "med") return 32;
  return 40;
}

interface SitePinSpriteEntry {
  readonly siteId: LaunchSiteId;
  readonly shortName: string;
  readonly sprite: THREE.Sprite;
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.SpriteMaterial;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly unitDir: THREE.Vector3;
  isActive: boolean;
}

function drawSitePinCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  shortName: string,
  active: boolean
): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const accent = active ? "#fbbf24" : "#38bdf8";
  const glow = active ? "rgba(251, 191, 36, 0.38)" : "rgba(56, 189, 248, 0.30)";

  // Subtle glowing 10–12 px circular pin dot on the left
  const cx = 18;
  const cy = canvas.height * 0.5;
  ctx.save();
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, active ? 13 : 10, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#060c18";
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.arc(cx, cy, active ? 6.5 : 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(cx, cy, 3.0, 0, Math.PI * 2);
  ctx.fill();

  // Compact crisp site tag pill
  ctx.font = "700 16px Consolas, 'Cascadia Mono', monospace";
  const textW = Math.min(138, Math.ceil(ctx.measureText(shortName).width));
  const pillX = 34;
  const pillY = 9;
  const pillW = textW + 14;
  const pillH = 26;

  ctx.fillStyle = "rgba(6, 12, 24, 0.80)";
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillW, pillH, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = active ? "#fef3c7" : "#e2e8f0";
  ctx.textBaseline = "middle";
  ctx.fillText(shortName, pillX + 7, cy + 0.5, 138);
  ctx.restore();
}

function createSitePinSprite(
  siteId: LaunchSiteId,
  shortName: string,
  unitDir: THREE.Vector3,
  active: boolean
): SitePinSpriteEntry {
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 44;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to acquire 2D canvas context for spaceport pin sprite");
  }
  drawSitePinCanvas(canvas, ctx, shortName, active);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0.92,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0.095, 0.5);
  sprite.renderOrder = 8;

  return {
    siteId,
    shortName,
    sprite,
    texture,
    material,
    canvas,
    ctx,
    unitDir,
    isActive: active,
  };
}

/**
 * Manages the full 3D curved planetary globe centered at (0, -simRadiusM, 0),
 * rotated so `launchSiteCoords` sits directly at zenith (0, 0, 0), using zero-pinch
 * icosahedral geometry + per-fragment 4K equirectangular sampling, Earth clouds,
 * ocean specular, night city lights, and atmospheric Fresnel limb glow.
 */
export class PlanetGlobe {
  public readonly group = new THREE.Group();

  private readonly globeCenterGroup = new THREE.Group();
  private readonly zenithAlignedGroup = new THREE.Group();

  private surfaceGeo: THREE.IcosahedronGeometry | null = null;
  private readonly surfaceMat: THREE.ShaderMaterial;
  private surfaceMesh: THREE.Mesh | null = null;

  private cloudGeo: THREE.IcosahedronGeometry | null = null;
  private readonly cloudMat: THREE.ShaderMaterial;
  private cloudMesh: THREE.Mesh | null = null;

  private limbGeo: THREE.IcosahedronGeometry | null = null;
  private readonly limbMat: THREE.ShaderMaterial;
  private limbMesh: THREE.Mesh | null = null;

  private readonly sitePinsGroup = new THREE.Group();
  private sitePinSprites: SitePinSpriteEntry[] = [];
  private activeSiteId: LaunchSiteId = "starbase";
  private readonly scratchPinWorld = new THREE.Vector3();
  private readonly scratchCenterWorld = new THREE.Vector3();
  private readonly scratchPinRadial = new THREE.Vector3();
  private readonly scratchCamRadial = new THREE.Vector3();

  private placeholderTextures: PlanetGlobeTextureSet | null = null;
  private activeConfig: PlanetConfig;
  private activeQuality: QualityPreset = "med";
  private loadSeq = 0;
  private onSiteColorSampled?: (color: THREE.Color) => void;

  constructor(
    initialConfig: PlanetConfig,
    quality: QualityPreset,
    maxAnisotropy: number,
    onSiteColorSampled?: (color: THREE.Color) => void
  ) {
    this.activeConfig = initialConfig;
    this.activeQuality = quality;
    this.onSiteColorSampled = onSiteColorSampled;

    this.surfaceMat = createPlanetSurfaceMaterial();
    this.cloudMat = createPlanetCloudMaterial();
    this.limbMat = createPlanetLimbMaterial();

    this.globeCenterGroup.add(this.zenithAlignedGroup);
    this.zenithAlignedGroup.add(this.sitePinsGroup);
    this.group.add(this.globeCenterGroup);
    this.rebuild(initialConfig, quality, maxAnisotropy);
  }

  private applySurfaceTextures(texSet: PlanetGlobeTextureSet): void {
    this.surfaceMat.uniforms.uDayMap.value = texSet.albedoMap;
    this.surfaceMat.uniforms.uSpecularMap.value = texSet.specularMap;
    this.surfaceMat.uniforms.uNightMap.value = texSet.nightLightsMap ?? texSet.albedoMap;
    if (texSet.cloudMap) {
      this.cloudMat.uniforms.uCloudMap.value = texSet.cloudMap;
    }
    this.onSiteColorSampled?.(texSet.siteTintColor);
  }

  private rebuild(
    config: PlanetConfig,
    quality: QualityPreset,
    maxAnisotropy: number
  ): void {
    this.clearGeometries();
    disposeGlobeTextureSet(this.placeholderTextures);
    this.placeholderTextures = null;

    this.activeConfig = config;
    this.activeQuality = quality;
    const seq = ++this.loadSeq;

    const R = config.scale.simRadiusM;
    this.globeCenterGroup.position.set(0, -R, 0);

    // Rotate sphere so config.scale.launchSiteCoords aligns with top zenith (0, 1, 0)
    const q = computeLaunchSiteZenithQuaternion(
      config.scale.launchSiteCoords.latDeg,
      config.scale.launchSiteCoords.lonDeg
    );
    this.zenithAlignedGroup.quaternion.copy(q);

    const sunVec = new THREE.Vector3(
      config.atmosphere.sunDirection[0],
      config.atmosphere.sunDirection[1],
      config.atmosphere.sunDirection[2]
    ).normalize();

    // Instant lightweight procedural placeholder so boot completes in < 400 ms
    const placeholder = generatePlanetGlobeTextures(config, quality, maxAnisotropy);
    this.placeholderTextures = placeholder;

    const surfDetail = getIcosaDetail(quality, true);
    const auxDetail = getIcosaDetail(quality, false);

    // -1800m cap recess + cutout keeps 6,371 km icosahedron facets strictly below local terrain & Sentinel-2 rings
    this.surfaceGeo = new THREE.IcosahedronGeometry(Math.max(1000, R - 1800), surfDetail);
    this.surfaceMat.uniforms.uSunDirection.value.copy(sunVec);
    this.surfaceMat.uniforms.uSunColor.value.set(config.lighting.sunLightColor);
    this.surfaceMat.uniforms.uSunIntensity.value = config.lighting.sunLightIntensity;
    this.surfaceMat.uniforms.uHemiSkyColor.value.set(config.lighting.hemiSkyColor);
    this.surfaceMat.uniforms.uHemiGroundColor.value.set(config.lighting.hemiGroundColor);
    this.surfaceMat.uniforms.uHemiIntensity.value = config.lighting.hemiIntensity;
    this.surfaceMat.uniforms.uIsEarth.value = config.id === "earth" ? 1.0 : 0.0;
    this.surfaceMat.uniforms.uIsMoon.value = config.id === "moon" ? 1.0 : 0.0;
    this.surfaceMat.uniforms.uMicroDetailStrength.value = config.id === "moon" ? 0.11 : 0.085;
    this.surfaceMat.uniforms.uNightOpacity.value = 0.0;
    this.surfaceMat.uniforms.uLocalTerrainCutoutRadius.value = Math.min(
      9500,
      config.scale.localTerrainRadiusM * 0.34
    );
    this.surfaceMat.uniforms.uSimRadius.value = R;

    this.applySurfaceTextures(placeholder);
    this.onSiteColorSampled?.(getDefaultSiteTintColor(config.id));

    this.surfaceMesh = new THREE.Mesh(this.surfaceGeo, this.surfaceMat);
    this.surfaceMesh.receiveShadow = false;
    this.surfaceMesh.castShadow = false;
    this.zenithAlignedGroup.add(this.surfaceMesh);

    if (config.id === "earth") {
      this.cloudGeo = new THREE.IcosahedronGeometry(R + 12_000, auxDetail);
      this.cloudMat.uniforms.uSunDirection.value.copy(sunVec);
      this.cloudMat.uniforms.uSunColor.value.set(config.lighting.sunLightColor);
      this.cloudMat.uniforms.uSunIntensity.value = config.lighting.sunLightIntensity;
      this.cloudMat.uniforms.uOpacity.value = 0.0;
      this.cloudMesh = new THREE.Mesh(this.cloudGeo, this.cloudMat);
      this.cloudMesh.renderOrder = 2;
      this.cloudMesh.visible = false;
      this.zenithAlignedGroup.add(this.cloudMesh);
    }

    if (config.id !== "moon") {
      const limbRadius = R + Math.max(20_000, config.scale.atmosphereTopM);
      this.limbGeo = new THREE.IcosahedronGeometry(limbRadius, auxDetail);
      (this.limbMat.uniforms.uSunDirection.value as THREE.Vector3).copy(sunVec);
      (this.limbMat.uniforms.uAtmosphereColor.value as THREE.Color).set(
        config.id === "earth" ? "#4ca8ff" : "#df864d"
      );
      (this.limbMat.uniforms.uHorizonColor.value as THREE.Color).set(
        config.id === "earth" ? "#9ed8ff" : "#f2b07a"
      );
      this.limbMat.uniforms.uStrength.value = config.id === "earth" ? 1.0 : 0.72;
      this.limbMat.uniforms.uAtmosphereTop.value = config.scale.atmosphereTopM;
      this.limbMesh = new THREE.Mesh(this.limbGeo, this.limbMat);
      this.limbMesh.renderOrder = 3;
      this.zenithAlignedGroup.add(this.limbMesh);
    }

    // Kick off non-blocking 4K satellite map fetch & sample launch-site RGB
    void loadPlanet4KTextures(config, maxAnisotropy).then((bundle) => {
      if (!bundle || seq !== this.loadSeq) {
        return;
      }
      this.applySurfaceTextures(bundle);
    });

    this.rebuildSitePins(R);
  }

  private clearSitePins(): void {
    for (const pin of this.sitePinSprites) {
      this.sitePinsGroup.remove(pin.sprite);
      pin.texture.dispose();
      pin.material.dispose();
    }
    this.sitePinSprites = [];
  }

  private rebuildSitePins(R: number): void {
    this.clearSitePins();

    if (this.activeConfig.id !== "earth") {
      this.sitePinsGroup.visible = false;
      return;
    }

    const pinAltR = R + 6_000;
    for (const s of EARTH_LAUNCH_SITES) {
      const [ux, uy, uz] = geoToSphereUnitVector(s.latDeg, s.lonDeg);
      const unitDir = new THREE.Vector3(ux, uy, uz).normalize();
      const entry = createSitePinSprite(
        s.id,
        s.shortName,
        unitDir,
        s.id === this.activeSiteId
      );
      entry.sprite.position.set(ux * pinAltR, uy * pinAltR, uz * pinAltR);
      this.sitePinsGroup.add(entry.sprite);
      this.sitePinSprites.push(entry);
    }
    this.sitePinsGroup.visible = false;
  }

  setLaunchSite(siteId: LaunchSiteId, latDeg: number, lonDeg: number): void {
    this.activeSiteId = siteId;
    const q = computeLaunchSiteZenithQuaternion(latDeg, lonDeg);
    this.zenithAlignedGroup.quaternion.copy(q);

    if (this.activeConfig.id === "earth") {
      for (const pin of this.sitePinSprites) {
        const nextActive = pin.siteId === siteId;
        if (pin.isActive !== nextActive) {
          pin.isActive = nextActive;
          drawSitePinCanvas(pin.canvas, pin.ctx, pin.shortName, nextActive);
          pin.texture.needsUpdate = true;
        }
      }
    }
  }

  updatePlanet(config: PlanetConfig, quality: QualityPreset, maxAnisotropy: number): void {
    this.rebuild(config, quality, maxAnisotropy);
  }

  setQuality(quality: QualityPreset, maxAnisotropy: number): void {
    if (this.activeQuality === quality) {
      return;
    }
    this.rebuild(this.activeConfig, quality, maxAnisotropy);
  }

  setRenderOrigin(origin: { readonly x: number; readonly y: number; readonly z: number }): void {
    const R = this.activeConfig.scale.simRadiusM;
    this.globeCenterGroup.position.set(-origin.x, -R - origin.y, -origin.z);
    (this.surfaceMat.uniforms.uPadRenderPos.value as THREE.Vector3).set(
      -origin.x,
      -origin.y,
      -origin.z
    );
  }

  update(dt: number, cameraAltitudeM: number, camera?: THREE.PerspectiveCamera): void {
    this.surfaceMat.uniforms.uCameraAltitude.value = cameraAltitudeM;

    if (this.activeConfig.id === "earth") {
      const nightT = Math.max(0, Math.min(1, (cameraAltitudeM - 15000) / 55000));
      this.surfaceMat.uniforms.uNightOpacity.value = nightT * 0.95;

      // Subtle screen-space spaceport pins strictly hidden below 450 km camera altitude
      const showPins = cameraAltitudeM >= 450_000 && this.sitePinSprites.length > 0;
      this.sitePinsGroup.visible = showPins;
      if (showPins && camera) {
        const vFovScale = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
        this.scratchCenterWorld.copy(this.globeCenterGroup.position);
        this.scratchCamRadial.copy(camera.position).sub(this.scratchCenterWorld).normalize();
        const pinAltR = this.activeConfig.scale.simRadiusM + 6_000;

        for (const pin of this.sitePinSprites) {
          this.scratchPinRadial
            .copy(pin.unitDir)
            .applyQuaternion(this.zenithAlignedGroup.quaternion);
          const facingCamera = this.scratchPinRadial.dot(this.scratchCamRadial) > 0.08;
          pin.sprite.visible = facingCamera;
          if (!facingCamera) {
            continue;
          }
          this.scratchPinWorld
            .copy(this.scratchCenterWorld)
            .addScaledVector(this.scratchPinRadial, pinAltR);
          const dist = Math.max(1000, camera.position.distanceTo(this.scratchPinWorld));
          // Strictly capped <= 0.014 * dist * tan(fov/2) height (crisp ~10-12 px dot + tag)
          const h = dist * vFovScale * (pin.isActive ? 0.0135 : 0.0115);
          pin.sprite.scale.set(h * (192 / 44), h, 1);
          pin.material.opacity = pin.isActive ? 0.96 : 0.78;
        }
      }
    } else {
      this.sitePinsGroup.visible = false;
    }

    if (this.cloudMesh) {
      this.cloudMesh.rotation.y += dt * 0.0022;
      // Keep global orbital cloud deck hidden near beach, fade smoothly in across 14..40 km
      const t = Math.max(0, Math.min(1, (cameraAltitudeM - 14000) / 26000));
      const cloudT = t * t * (3 - 2 * t);
      this.cloudMat.uniforms.uOpacity.value = cloudT * 0.84;
      this.cloudMesh.visible = cloudT > 0.004;
    }

    if (this.limbMesh) {
      this.limbMat.uniforms.uCameraAltitude.value = cameraAltitudeM;
      this.limbMesh.visible = cameraAltitudeM > 14000;
    }
  }

  private clearGeometries(): void {
    if (this.surfaceMesh) {
      this.zenithAlignedGroup.remove(this.surfaceMesh);
      this.surfaceMesh = null;
    }
    if (this.cloudMesh) {
      this.zenithAlignedGroup.remove(this.cloudMesh);
      this.cloudMesh = null;
    }
    if (this.limbMesh) {
      this.zenithAlignedGroup.remove(this.limbMesh);
      this.limbMesh = null;
    }
    this.surfaceGeo?.dispose();
    this.surfaceGeo = null;
    this.cloudGeo?.dispose();
    this.cloudGeo = null;
    this.limbGeo?.dispose();
    this.limbGeo = null;
  }

  dispose(): void {
    this.clearGeometries();
    this.clearSitePins();
    disposeGlobeTextureSet(this.placeholderTextures);
    this.placeholderTextures = null;
    this.surfaceMat.dispose();
    this.cloudMat.dispose();
    this.limbMat.dispose();
  }
}
