import * as THREE from "three";
import type { PlanetConfig } from "../config/planets";
import type { QualityPreset } from "../effects/PropulsionEffects";
import {
  createPlanetCloudMaterial,
  createPlanetSurfaceMaterial,
} from "../shaders/planetGlobeShader";
import { createPlanetLimbMaterial } from "../shaders/planetLimbShader";
import { computeLaunchSiteZenithQuaternion } from "./earthGeography";
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

    // Gentle -35m cap recess beneath local terrain so feathered outer rim blends without seams
    this.surfaceGeo = new THREE.IcosahedronGeometry(Math.max(1000, R - 35), surfDetail);
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

    this.applySurfaceTextures(placeholder);
    this.onSiteColorSampled?.(getDefaultSiteTintColor(config.id));

    this.surfaceMesh = new THREE.Mesh(this.surfaceGeo, this.surfaceMat);
    this.surfaceMesh.receiveShadow = false;
    this.surfaceMesh.castShadow = false;
    this.zenithAlignedGroup.add(this.surfaceMesh);

    if (config.id === "earth") {
      this.cloudGeo = new THREE.IcosahedronGeometry(R + 2400, auxDetail);
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
      const limbMult = config.id === "earth" ? 1.045 : 1.03;
      this.limbGeo = new THREE.IcosahedronGeometry(R * limbMult, auxDetail);
      (this.limbMat.uniforms.uSunDirection.value as THREE.Vector3).copy(sunVec);
      (this.limbMat.uniforms.uAtmosphereColor.value as THREE.Color).set(
        config.id === "earth" ? "#4ca8ff" : "#df864d"
      );
      (this.limbMat.uniforms.uHorizonColor.value as THREE.Color).set(
        config.id === "earth" ? "#9ed8ff" : "#f2b07a"
      );
      this.limbMat.uniforms.uStrength.value = config.id === "earth" ? 1.0 : 0.72;
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

  update(dt: number, cameraAltitudeM: number): void {
    this.surfaceMat.uniforms.uCameraAltitude.value = cameraAltitudeM;

    if (this.activeConfig.id === "earth") {
      const nightT = Math.max(0, Math.min(1, (cameraAltitudeM - 2500) / 15500));
      this.surfaceMat.uniforms.uNightOpacity.value = nightT * 0.95;
    }

    if (this.cloudMesh) {
      this.cloudMesh.rotation.y += dt * 0.0045;
      // Keep clouds strictly hidden below 4.5 km, then ramp smoothly up to 16 km
      const t = Math.max(0, Math.min(1, (cameraAltitudeM - 4500) / 11500));
      const cloudT = t * t * (3 - 2 * t);
      this.cloudMat.uniforms.uOpacity.value = cloudT * 0.86;
      this.cloudMesh.visible = cloudT > 0.004;
    }

    if (this.limbMesh) {
      this.limbMat.uniforms.uCameraAltitude.value = cameraAltitudeM;
      this.limbMesh.visible = cameraAltitudeM > 1500;
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
    disposeGlobeTextureSet(this.placeholderTextures);
    this.placeholderTextures = null;
    this.surfaceMat.dispose();
    this.cloudMat.dispose();
    this.limbMat.dispose();
  }
}
