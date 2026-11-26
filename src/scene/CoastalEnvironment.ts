import * as THREE from "three";
import { type LaunchSiteConfig, getDefaultLaunchSiteForPlanet } from "../config/launchSites";
import { type PlanetConfig, getPlanetConfig } from "../config/planets";
import type { QualityPreset } from "../effects/PropulsionEffects";
import { createGulfOceanMaterial } from "../shaders/oceanShader";
import type { FlightTelemetry } from "../sim/FlightController";
import {
  SeededNoise2D,
  computeCurvedSurfaceDrop,
  computeEarthShorelineX,
  samplePlanetTerrainHeight,
  smoothstep,
} from "../utils/noise";
import { loadPbrTextureSet } from "./PbrTextureLoader";

interface VehicleSpec {
  laneZ: number;
  dir: 1 | -1;
  posX: number;
  speedMps: number;
  baseSpeedMps: number;
  holdX: number;
  isTruck: boolean;
}

const MAX_SCRUB_COUNT = 260;
const MAX_GRASS_COUNT = 180;
const MAX_PALM_COUNT = 78;

function buildCurvedGulfOceanGeometry(
  config: PlanetConfig,
  noise: SeededNoise2D,
  nx: number,
  nz: number
): THREE.BufferGeometry {
  const cols = nx + 1;
  const rows = nz + 1;
  const count = cols * rows;

  const positions = new Float32Array(count * 3);
  const coastDist = new Float32Array(count);
  const indices: number[] = [];

  const xMin = 305;
  const xSpan = 35_000;
  const zHalf = 35_000;
  const simR = config.scale.simRadiusM;

  for (let r = 0; r < rows; r++) {
    const v = r / nz;
    const sv = v * 2 - 1;
    const z = Math.sign(sv) * Math.pow(Math.abs(sv), 2.15) * zHalf;
    const xShore = computeEarthShorelineX(z, noise);

    for (let c = 0; c < cols; c++) {
      const u = c / nx;
      const x = xMin + Math.pow(u, 2.35) * xSpan;
      const idx = r * cols + c;
      const drop = computeCurvedSurfaceDrop(Math.hypot(x, z), simR);

      positions[idx * 3] = x;
      positions[idx * 3 + 1] = drop;
      positions[idx * 3 + 2] = z;
      coastDist[idx] = x - xShore;
    }
  }

  for (let r = 0; r < nz; r++) {
    for (let c = 0; c < nx; c++) {
      const a = r * cols + c;
      const b = r * cols + (c + 1);
      const d = (r + 1) * cols + c;
      const e = (r + 1) * cols + (c + 1);
      indices.push(a, b, d);
      indices.push(b, e, d);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("aCoastDist", new THREE.BufferAttribute(coastDist, 1));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Earth-only living spaceport & regional biome environment across all 6 world sites:
 * Starbase, KSC LC-39A (with 160 m VAB & Crawlerway), Satish Dhawan SHAR (palm island),
 * CSG Kourou (equatorial coast), Tanegashima (Pacific bluff), and Baikonur (steppe rail, zero ocean).
 */
export class CoastalEnvironment {
  public readonly group = new THREE.Group();

  private readonly earthConfig: PlanetConfig;
  private currentSite: LaunchSiteConfig;
  private readonly noise: SeededNoise2D;
  private readonly disposables: Array<{ dispose(): void }> = [];

  private oceanMesh: THREE.Mesh | null = null;
  private oceanMat: THREE.ShaderMaterial | null = null;
  private radarPivot: THREE.Group | null = null;
  private strobeMat: THREE.MeshStandardMaterial | null = null;

  private asphaltMat: THREE.MeshStandardMaterial | null = null;
  private concreteMat: THREE.MeshStandardMaterial | null = null;
  private factoryWallMat: THREE.MeshStandardMaterial | null = null;
  private bayRibMat: THREE.MeshStandardMaterial | null = null;
  private pbrTextures: THREE.Texture[] = [];
  private maxAnisotropy = 4;
  private pbrLoadSeq = 0;

  private scrubMesh: THREE.InstancedMesh | null = null;
  private grassMesh: THREE.InstancedMesh | null = null;
  private palmTrunkMesh: THREE.InstancedMesh | null = null;
  private palmCrownMesh: THREE.InstancedMesh | null = null;
  private activePalmCount = 54;

  private vehicleCabMesh: THREE.InstancedMesh | null = null;
  private vehicleBodyMesh: THREE.InstancedMesh | null = null;
  private readonly vehicles: VehicleSpec[] = [];

  private isEarthActive = true;
  private quality: QualityPreset;
  private readonly dummy = new THREE.Object3D();

  constructor(
    initialConfig: PlanetConfig,
    quality: QualityPreset,
    maxAnisotropy = 4,
    initialSite: LaunchSiteConfig = getDefaultLaunchSiteForPlanet("earth")
  ) {
    this.earthConfig = getPlanetConfig("earth");
    this.currentSite = initialSite;
    this.quality = quality;
    this.maxAnisotropy = maxAnisotropy;
    this.noise = new SeededNoise2D(this.earthConfig.terrain.seed);
    this.buildEarthWorld(this.earthConfig, initialSite);
    this.setPlanet(initialConfig, initialSite);
    this.setQuality(quality, maxAnisotropy);
  }

  private track<T extends { dispose(): void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private sampleGroundY(x: number, z: number): number {
    return samplePlanetTerrainHeight(x, z, this.earthConfig, this.noise, this.currentSite);
  }

  private clearSiteGeometry(): void {
    this.group.clear();
    this.oceanMesh = null;
    this.oceanMat = null;
    this.radarPivot = null;
    this.strobeMat = null;
    this.asphaltMat = null;
    this.concreteMat = null;
    this.factoryWallMat = null;
    this.bayRibMat = null;
    this.scrubMesh = null;
    this.grassMesh = null;
    this.palmTrunkMesh = null;
    this.palmCrownMesh = null;
    this.vehicleCabMesh = null;
    this.vehicleBodyMesh = null;
    this.vehicles.length = 0;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  private applyExistingPbrToSiteMaterials(): void {
    if (this.pbrTextures.length < 9) {
      return;
    }
    const [aDiff, aNor, aRough, cDiff, cNor, cRough, mDiff, mNor, mRough] = this.pbrTextures;
    if (this.asphaltMat && aDiff && aNor && aRough) {
      this.asphaltMat.map = aDiff;
      this.asphaltMat.normalMap = aNor;
      this.asphaltMat.roughnessMap = aRough;
      this.asphaltMat.needsUpdate = true;
    }
    if (this.concreteMat && cDiff && cNor && cRough) {
      this.concreteMat.map = cDiff;
      this.concreteMat.normalMap = cNor;
      this.concreteMat.roughnessMap = cRough;
      this.concreteMat.needsUpdate = true;
    }
    if (this.bayRibMat && this.factoryWallMat && mDiff && mNor && mRough) {
      for (const m of [this.bayRibMat, this.factoryWallMat]) {
        m.map = mDiff;
        m.normalMap = mNor;
        m.roughnessMap = mRough;
        m.needsUpdate = true;
      }
    }
  }

  private buildEarthWorld(config: PlanetConfig, site: LaunchSiteConfig): void {
    this.clearSiteGeometry();
    this.currentSite = site;

    const sunVec = new THREE.Vector3(
      config.atmosphere.sunDirection[0],
      config.atmosphere.sunDirection[1],
      config.atmosphere.sunDirection[2]
    ).normalize();

    // 1. Coastal Ocean mesh only for coastal sites (zero ocean on inland steppe Baikonur)
    if (site.hasOcean) {
      const horizonCol =
        site.biome === "tropical_coast"
          ? "#5ec4d6"
          : site.biome === "coastal_bluff"
            ? "#4fa8cf"
            : config.atmosphere.horizonColor;
      this.oceanMat = this.track(
        createGulfOceanMaterial(
          sunVec,
          config.lighting.sunLightColor,
          horizonCol,
          config.atmosphere.zenithColor
        )
      );
      const oceanGeom = this.track(buildCurvedGulfOceanGeometry(config, this.noise, 72, 72));
      this.oceanMesh = new THREE.Mesh(oceanGeom, this.oceanMat);
      this.oceanMesh.renderOrder = 1;
      this.oceanMesh.receiveShadow = false;
      this.oceanMesh.castShadow = false;
      const azDeg = site.coastAzimuthDeg ?? 90;
      this.oceanMesh.rotation.y = ((90 - azDeg) * Math.PI) / 180;
      this.group.add(this.oceanMesh);
    }

    // 2. Shared PBR materials
    const asphaltMat = this.track(
      new THREE.MeshStandardMaterial({
        color: site.biome === "atlantic_coast" ? "#c2c6cc" : "#b6bcc4",
        roughness: 0.9,
        metalness: 0.04,
      })
    );
    const roadStripeMat = this.track(
      new THREE.MeshStandardMaterial({ color: "#e5b842", roughness: 0.65, metalness: 0.05 })
    );
    const concreteMat = this.track(
      new THREE.MeshStandardMaterial({ color: "#d2d6dc", roughness: 0.86, metalness: 0.05 })
    );
    const steelDarkMat = this.track(
      new THREE.MeshStandardMaterial({ color: "#363d47", roughness: 0.48, metalness: 0.68 })
    );
    const factoryWallMat = this.track(
      new THREE.MeshStandardMaterial({
        color: site.id === "tanegashima" ? "#dce3ec" : "#cfd6de",
        roughness: 0.56,
        metalness: 0.34,
      })
    );
    const bayRibMat = this.track(
      new THREE.MeshStandardMaterial({
        color: site.id === "ksc_lc39a" ? "#b8c2ce" : "#76818f",
        roughness: 0.45,
        metalness: 0.68,
      })
    );
    const glassMat = this.track(
      new THREE.MeshStandardMaterial({
        color: "#6ba4d4",
        emissive: "#163554",
        emissiveIntensity: 0.25,
        roughness: 0.14,
        metalness: 0.85,
      })
    );
    const domeWhiteMat = this.track(
      new THREE.MeshStandardMaterial({ color: "#cfd6de", roughness: 0.52, metalness: 0.10 })
    );
    this.asphaltMat = asphaltMat;
    this.concreteMat = concreteMat;
    this.factoryWallMat = factoryWallMat;
    this.bayRibMat = bayRibMat;

    const warmLightMat = this.track(
      new THREE.MeshStandardMaterial({
        color: "#fff7dc",
        emissive: "#fbbf24",
        emissiveIntensity: 1.4,
        roughness: 0.3,
      })
    );
    this.strobeMat = this.track(
      new THREE.MeshStandardMaterial({
        color: "#ffd4d4",
        emissive: "#ef4444",
        emissiveIntensity: 2.2,
        roughness: 0.25,
      })
    );

    // 3. Corridor (Steppe Rail for Baikonur / Coastal Highway + Crawlerway elsewhere)
    const isSteppe = !site.hasOcean;
    const hwyX0 = -1850;
    const hwyX1 = isSteppe ? 650 : 300;
    const roadZ = isSteppe ? 84 : 78;
    const segCount = 18;
    const segLen = (hwyX1 - hwyX0) / segCount;
    const hwySegGeom = this.track(
      new THREE.BoxGeometry(segLen + 0.6, 0.28, isSteppe ? 8.5 : 13.0)
    );
    const hwyInst = new THREE.InstancedMesh(hwySegGeom, isSteppe ? concreteMat : asphaltMat, 19);
    hwyInst.receiveShadow = true;
    for (let i = 0; i < segCount; i++) {
      const cx = hwyX0 + (i + 0.5) * segLen;
      const y = this.sampleGroundY(cx, roadZ);
      this.dummy.position.set(cx, y + 0.08, roadZ);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      hwyInst.setMatrixAt(i, this.dummy.matrix);
    }
    this.dummy.position.set(hwyX1 - 2, this.sampleGroundY(hwyX1 - 2, roadZ) + 0.08, roadZ);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(0.28, 1.05, isSteppe ? 1.4 : 2.3);
    this.dummy.updateMatrix();
    hwyInst.setMatrixAt(18, this.dummy.matrix);
    hwyInst.instanceMatrix.needsUpdate = true;
    this.group.add(hwyInst);

    if (isSteppe) {
      // Twin steel railway tracks + sleepers on Baikonur corridor
      const railGeom = this.track(new THREE.BoxGeometry(hwyX1 - hwyX0, 0.16, 0.16));
      for (const rzOff of [-1.2, 1.2]) {
        const rail = new THREE.Mesh(railGeom, steelDarkMat);
        rail.position.set((hwyX0 + hwyX1) * 0.5, this.sampleGroundY(0, roadZ) + 0.26, roadZ + rzOff);
        this.group.add(rail);
      }
    } else {
      const dashCount = 72;
      const dashGeom = this.track(new THREE.BoxGeometry(8.0, 0.08, 0.32));
      const dashInst = new THREE.InstancedMesh(dashGeom, roadStripeMat, dashCount);
      for (let i = 0; i < dashCount; i++) {
        const dx = hwyX0 + 20 + i * ((hwyX1 - hwyX0 - 45) / dashCount);
        const y = this.sampleGroundY(dx, roadZ);
        this.dummy.position.set(dx, y + 0.24, roadZ);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        dashInst.setMatrixAt(i, this.dummy.matrix);
      }
      dashInst.instanceMatrix.needsUpdate = true;
      this.group.add(dashInst);
    }

    // Light poles
    const poleCount = 24;
    const poleGeom = this.track(new THREE.CylinderGeometry(0.18, 0.26, 9.5, 6));
    const lampGeom = this.track(new THREE.BoxGeometry(1.1, 0.35, 0.65));
    const poleInst = new THREE.InstancedMesh(poleGeom, bayRibMat, poleCount);
    const lampInst = new THREE.InstancedMesh(lampGeom, warmLightMat, poleCount);
    for (let i = 0; i < poleCount; i++) {
      const px = -1450 + i * 74;
      const pz = roadZ - 8.5;
      const y = this.sampleGroundY(px, pz);
      this.dummy.position.set(px, y + 4.75, pz);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      poleInst.setMatrixAt(i, this.dummy.matrix);

      this.dummy.position.set(px, y + 9.55, pz + 0.55);
      this.dummy.updateMatrix();
      lampInst.setMatrixAt(i, this.dummy.matrix);
    }
    poleInst.instanceMatrix.needsUpdate = true;
    lampInst.instanceMatrix.needsUpdate = true;
    this.group.add(poleInst, lampInst);

    // Concrete slabs + Crawlerway on KSC LC-39A
    const slabGeom = this.track(new THREE.BoxGeometry(1, 1, 1));
    const slabSpecs: Array<[number, number, number, number, number, number, number]> = [
      [0, this.sampleGroundY(0, 64) + 0.06, 65, 11.5, 0.28, 28, 0],
      [-840, this.sampleGroundY(-840, -40) + 0.15, -40, 360, 0.35, 165, 0],
      [-365, this.sampleGroundY(-365, 148) + 0.25, 148, 58, 0.5, 42, 0],
      [-65, this.sampleGroundY(-65, 58) + 1.5, 58, 58, 3.6, 5.5, 0],
      [75, this.sampleGroundY(75, 56) + 1.5, 56, 58, 3.6, 5.5, 0],
      [115, this.sampleGroundY(115, -28) + 1.5, -28, 58, 3.6, 5.5, Math.PI * 0.5],
    ];
    if (site.id === "ksc_lc39a") {
      slabSpecs.push([-520, this.sampleGroundY(-520, 0) + 0.14, 0, 880, 0.32, 34, 0]);
    }
    const slabInst = new THREE.InstancedMesh(slabGeom, concreteMat, slabSpecs.length);
    slabInst.receiveShadow = true;
    slabSpecs.forEach(([sx, sy, sz, wx, wy, wz, ry], i) => {
      this.dummy.position.set(sx, sy, sz);
      this.dummy.rotation.set(0, ry, 0);
      this.dummy.scale.set(wx, wy, wz);
      this.dummy.updateMatrix();
      slabInst.setMatrixAt(i, this.dummy.matrix);
    });
    slabInst.instanceMatrix.needsUpdate = true;
    this.group.add(slabInst);

    // 4. Site-Specific Landmarks (Mega Bays / KSC VAB / SDSC SVAB / CSG BAF / Yoshinobu VAB / Baikonur MIK)
    const unitBox = this.track(new THREE.BoxGeometry(1, 1, 1));
    let strobeTargets: Array<{ x: number; y: number; z: number }> = [];

    if (site.id === "ksc_lc39a") {
      // Monumental NASA Vehicle Assembly Building (160 m tall x 157 m wide x 218 m long) + LCC
      const vabY = this.sampleGroundY(-1040, -35);
      const vabMain = new THREE.Mesh(this.track(new THREE.BoxGeometry(158, 160, 212)), bayRibMat);
      vabMain.position.set(-1040, vabY + 80, -35);
      const vabLowBay = new THREE.Mesh(this.track(new THREE.BoxGeometry(92, 64, 134)), factoryWallMat);
      vabLowBay.position.set(-925, vabY + 32, -35);
      const vabDoor = new THREE.Mesh(this.track(new THREE.BoxGeometry(8, 138, 48)), steelDarkMat);
      vabDoor.position.set(-960, vabY + 69, -35);
      const lccWing = new THREE.Mesh(this.track(new THREE.BoxGeometry(86, 22, 118)), glassMat);
      lccWing.position.set(-885, vabY + 11, 78);
      this.group.add(vabMain, vabLowBay, vabDoor, lccWing);
      strobeTargets = [
        { x: -965, y: vabY + 163, z: -135 },
        { x: -965, y: vabY + 163, z: 65 },
      ];
    } else if (site.id === "baikonur") {
      // Horizontal MIK Integration Hall (Roscosmos / Soyuz horizontal assembly)
      const mikY = this.sampleGroundY(-820, -45);
      const mikMain = new THREE.Mesh(this.track(new THREE.BoxGeometry(240, 28, 76)), factoryWallMat);
      mikMain.position.set(-820, mikY + 14, -45);
      const mikRoof = new THREE.Mesh(this.track(new THREE.BoxGeometry(246, 4, 80)), steelDarkMat);
      mikRoof.position.set(-820, mikY + 30, -45);
      const mikSide = new THREE.Mesh(this.track(new THREE.BoxGeometry(120, 20, 48)), bayRibMat);
      mikSide.position.set(-760, mikY + 10, 28);
      this.group.add(mikMain, mikRoof, mikSide);
      strobeTargets = [{ x: -700, y: mikY + 33, z: -82 }];
    } else if (site.id === "sriharikota" || site.id === "kourou" || site.id === "tanegashima") {
      const vabH = site.id === "sriharikota" ? 95 : site.id === "kourou" ? 90 : 78;
      const vabX = site.id === "tanegashima" ? -680 : -770;
      const gy = this.sampleGroundY(vabX, -48);
      const tallVab = new THREE.Mesh(this.track(new THREE.BoxGeometry(58, vabH, 68)), factoryWallMat);
      tallVab.position.set(vabX, gy + vabH * 0.5, -48);
      const trim = new THREE.Mesh(this.track(new THREE.BoxGeometry(60, 9, 70)), bayRibMat);
      trim.position.set(vabX, gy + vabH - 6, -48);
      const annex = new THREE.Mesh(this.track(new THREE.BoxGeometry(140, 24, 62)), bayRibMat);
      annex.position.set(vabX - 140, gy + 12, -55);
      this.group.add(tallVab, trim, annex);
      strobeTargets = [{ x: vabX + 26, y: gy + vabH + 3, z: -18 }];
    } else {
      // Starbase Mega Bay 1 & 2 + Starfactory
      const bayBodyInst = new THREE.InstancedMesh(unitBox, bayRibMat, 14);
      const baySpecs = [
        { bx: -560, bz: -48, h: 86, w: 44 },
        { bx: -672, bz: -48, h: 82, w: 42 },
      ];
      baySpecs.forEach((b, i) => {
        const gy = this.sampleGroundY(b.bx, b.bz);
        this.dummy.position.set(b.bx, gy + b.h * 0.5, b.bz);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(b.w, b.h, b.w * 0.9);
        this.dummy.updateMatrix();
        bayBodyInst.setMatrixAt(i, this.dummy.matrix);
      });
      const factoryGround = this.sampleGroundY(-980, -62);
      for (let i = 0; i < 12; i++) {
        const col = i % 6;
        const row = Math.floor(i / 6);
        this.dummy.position.set(-1080 + col * 40, factoryGround + 29.2, -82 + row * 40);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(8.5, 3.2, 6.5);
        this.dummy.updateMatrix();
        bayBodyInst.setMatrixAt(2 + i, this.dummy.matrix);
      }
      bayBodyInst.instanceMatrix.needsUpdate = true;

      const glassBandInst = new THREE.InstancedMesh(unitBox, glassMat, 3);
      const roofTrimInst = new THREE.InstancedMesh(unitBox, steelDarkMat, 3);
      baySpecs.forEach((b, i) => {
        const gy = this.sampleGroundY(b.bx, b.bz);
        this.dummy.position.set(b.bx, gy + b.h * 0.84, b.bz);
        this.dummy.scale.set(b.w + 0.9, 9.5, b.w * 0.9 + 0.9);
        this.dummy.updateMatrix();
        glassBandInst.setMatrixAt(i, this.dummy.matrix);

        this.dummy.position.set(b.bx, gy + b.h + 2.1, b.bz);
        this.dummy.scale.set(b.w + 3.0, 4.2, b.w * 0.9 + 2.4);
        this.dummy.updateMatrix();
        roofTrimInst.setMatrixAt(i, this.dummy.matrix);
        strobeTargets.push({ x: b.bx + b.w * 0.42, y: gy + b.h + 5.2, z: b.bz + b.w * 0.36 });
      });
      this.dummy.position.set(-980, factoryGround + 18.5, -62);
      this.dummy.scale.set(262, 5.2, 99.2);
      this.dummy.updateMatrix();
      glassBandInst.setMatrixAt(2, this.dummy.matrix);
      this.dummy.position.set(-980, factoryGround + 26.5, -62);
      this.dummy.scale.set(274, 3.0, 102);
      this.dummy.updateMatrix();
      roofTrimInst.setMatrixAt(2, this.dummy.matrix);
      glassBandInst.instanceMatrix.needsUpdate = true;
      roofTrimInst.instanceMatrix.needsUpdate = true;

      const factoryMain = new THREE.Mesh(this.track(new THREE.BoxGeometry(270, 26, 98)), factoryWallMat);
      factoryMain.position.set(-980, factoryGround + 13, -62);
      this.group.add(bayBodyInst, glassBandInst, roofTrimInst, factoryMain);
    }

    // Range Telemetry Station (present across all 6 global spaceports)
    const rangeY = this.sampleGroundY(-365, 148);
    const rangeGroup = new THREE.Group();
    rangeGroup.position.set(-365, rangeY, 148);

    const radomeBase = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(8.5, 9.8, 7.5, 16)),
      concreteMat
    );
    radomeBase.position.set(-12, 3.75, 0);
    const radomeSphere = new THREE.Mesh(
      this.track(new THREE.IcosahedronGeometry(9.6, 2)),
      domeWhiteMat
    );
    radomeSphere.position.set(-12, 13.5, 0);

    const radarPedestal = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(2.0, 2.8, 12.0, 10)),
      steelDarkMat
    );
    radarPedestal.position.set(14, 6.0, -4);
    this.radarPivot = new THREE.Group();
    this.radarPivot.position.set(14, 12.6, -4);
    const dish = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(5.6, 16, 10, 0, Math.PI * 2, 0, 1.05)),
      domeWhiteMat
    );
    dish.rotation.x = Math.PI * 0.34;
    const feedHorn = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.18, 0.32, 4.8, 8)),
      steelDarkMat
    );
    feedHorn.position.set(0, 3.6, 2.1);
    feedHorn.rotation.x = -0.35;
    this.radarPivot.add(dish, feedHorn);

    const weatherMast = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.28, 0.72, 44, 8)),
      domeWhiteMat
    );
    weatherMast.position.set(22, 22, 12);
    strobeTargets.push({ x: -343, y: rangeY + 44.5, z: 160 });

    const strobeInst = new THREE.InstancedMesh(
      this.track(new THREE.SphereGeometry(0.85, 8, 6)),
      this.strobeMat,
      strobeTargets.length
    );
    strobeTargets.forEach((st, i) => {
      this.dummy.position.set(st.x, st.y, st.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      strobeInst.setMatrixAt(i, this.dummy.matrix);
    });
    strobeInst.instanceMatrix.needsUpdate = true;

    rangeGroup.add(radomeBase, radomeSphere, radarPedestal, this.radarPivot, weatherMast);
    this.group.add(rangeGroup, strobeInst);

    this.buildInstancedVegetation(site);
    this.buildSupportVehicles(domeWhiteMat, steelDarkMat, roadZ);
    this.applyExistingPbrToSiteMaterials();
  }

  private buildInstancedVegetation(site: LaunchSiteConfig): void {
    const scrubMat = this.track(
      new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, metalness: 0.0 })
    );
    const grassMat = this.track(
      new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.88, metalness: 0.0 })
    );
    const trunkMat = this.track(
      new THREE.MeshStandardMaterial({ color: "#7d6952", roughness: 0.92, metalness: 0.0 })
    );
    const palmMat = this.track(
      new THREE.MeshStandardMaterial({ color: "#4e7a3b", roughness: 0.76, metalness: 0.02 })
    );

    const scrubGeo = this.track(new THREE.DodecahedronGeometry(1.0, 0));
    const grassGeo = this.track(new THREE.ConeGeometry(0.55, 1.5, 5));
    const trunkGeo = this.track(new THREE.CylinderGeometry(0.16, 0.28, 6.2, 6));
    const crownGeo = this.track(new THREE.ConeGeometry(2.4, 1.8, 7));

    this.scrubMesh = new THREE.InstancedMesh(scrubGeo, scrubMat, MAX_SCRUB_COUNT);
    this.grassMesh = new THREE.InstancedMesh(grassGeo, grassMat, MAX_GRASS_COUNT);
    this.palmTrunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, MAX_PALM_COUNT);
    this.palmCrownMesh = new THREE.InstancedMesh(crownGeo, palmMat, MAX_PALM_COUNT);

    let seed = 88421;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const azDeg = site.coastAzimuthDeg ?? 90;
    const azRad = (azDeg * Math.PI) / 180;
    const azSin = Math.sin(azRad);
    const azCos = Math.cos(azRad);

    const isClearGround = (x: number, z: number): boolean => {
      if (Math.hypot(x, z) < 92) return false;
      if (x > 30 && x < 125 && z > -48 && z < 26) return false;
      if (Math.abs(z - 78) < 20) return false;
      if (x < -460 && x > -1220 && z > -155 && z < 45) return false;
      if (x < -310 && x > -420 && z > 110 && z < 190) return false;
      if (site.hasOcean) {
        const coastU = Math.abs(azDeg - 90) > 0.1 ? x * azSin - z * azCos : x;
        const coastT = Math.abs(azDeg - 90) > 0.1 ? x * azCos + z * azSin : z;
        if (coastU > computeEarthShorelineX(coastT, this.noise) - 48) return false;
      }
      return true;
    };

    const col = new THREE.Color();
    const scrubPalette =
      !site.hasOcean
        ? ["#9b8e5a", "#8a7f4e", "#766f46", "#a89862"]
        : site.biome === "tropical_coast"
          ? ["#3d7a37", "#4f8d42", "#2f662b", "#659c4d"]
          : ["#647d48", "#7b8d55", "#51693b", "#8a8e58"];

    let placed = 0;
    let guard = 0;
    while (placed < MAX_SCRUB_COUNT && guard++ < 4000) {
      const x = -1400 + rand() * 1920;
      const z = (rand() - 0.5) * 1450;
      if (!isClearGround(x, z)) continue;
      const y = this.sampleGroundY(x, z);
      if (y < computeCurvedSurfaceDrop(Math.hypot(x, z), this.earthConfig.scale.simRadiusM) + 0.05) {
        continue;
      }
      const s = 0.8 + rand() * 1.9;
      this.dummy.position.set(x, y + s * 0.4, z);
      this.dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      this.dummy.scale.set(s * 1.25, s * 0.72, s * 1.1);
      this.dummy.updateMatrix();
      this.scrubMesh.setMatrixAt(placed, this.dummy.matrix);
      col.set(scrubPalette[placed % scrubPalette.length]);
      this.scrubMesh.setColorAt(placed, col);
      placed++;
    }
    this.scrubMesh.count = placed;
    this.scrubMesh.instanceMatrix.needsUpdate = true;
    if (this.scrubMesh.instanceColor) this.scrubMesh.instanceColor.needsUpdate = true;

    placed = 0;
    guard = 0;
    while (placed < MAX_GRASS_COUNT && guard++ < 3000) {
      const x = -900 + rand() * 1400;
      const z = (rand() - 0.5) * 1100;
      if (!isClearGround(x, z)) continue;
      const y = this.sampleGroundY(x, z);
      const s = 0.75 + rand() * 1.2;
      this.dummy.position.set(x, y + s * 0.65, z);
      this.dummy.rotation.set(0, rand() * Math.PI, 0);
      this.dummy.scale.set(s, s, s);
      this.dummy.updateMatrix();
      this.grassMesh.setMatrixAt(placed, this.dummy.matrix);
      col.set(site.biome === "arid_steppe" ? "#bda66a" : "#b8b06c");
      this.grassMesh.setColorAt(placed, col);
      placed++;
    }
    this.grassMesh.count = placed;
    this.grassMesh.instanceMatrix.needsUpdate = true;
    if (this.grassMesh.instanceColor) this.grassMesh.instanceColor.needsUpdate = true;

    const targetPalms =
      !site.hasOcean ? 0 : site.biome === "tropical_coast" ? MAX_PALM_COUNT : 54;
    placed = 0;
    guard = 0;
    while (placed < targetPalms && guard++ < 2500) {
      const alongRoad = rand() < 0.55;
      const x = alongRoad ? -1350 + rand() * 1600 : -950 + rand() * 1200;
      const z = alongRoad ? (rand() < 0.5 ? 58 + rand() * 6 : 92 + rand() * 8) : (rand() - 0.5) * 700;
      if (!isClearGround(x, z)) continue;
      const y = this.sampleGroundY(x, z);
      const hScale = 0.8 + rand() * 0.55;
      const tiltX = (rand() - 0.5) * 0.16;
      const tiltZ = (rand() - 0.5) * 0.16;
      this.dummy.position.set(x, y + 3.0 * hScale, z);
      this.dummy.rotation.set(tiltX, rand() * Math.PI * 2, tiltZ);
      this.dummy.scale.set(1, hScale, 1);
      this.dummy.updateMatrix();
      this.palmTrunkMesh.setMatrixAt(placed, this.dummy.matrix);

      this.dummy.position.set(x + tiltZ * 2.5, y + 6.1 * hScale, z - tiltX * 2.5);
      this.dummy.rotation.set(tiltX, rand() * Math.PI * 2, tiltZ);
      this.dummy.scale.set(hScale * 1.15, hScale, hScale * 1.15);
      this.dummy.updateMatrix();
      this.palmCrownMesh.setMatrixAt(placed, this.dummy.matrix);
      placed++;
    }
    this.activePalmCount = placed;
    this.palmTrunkMesh.count = placed;
    this.palmCrownMesh.count = placed;
    this.palmTrunkMesh.instanceMatrix.needsUpdate = true;
    this.palmCrownMesh.instanceMatrix.needsUpdate = true;

    this.group.add(this.scrubMesh, this.grassMesh, this.palmTrunkMesh, this.palmCrownMesh);
  }

  private buildSupportVehicles(
    whiteMat: THREE.MeshStandardMaterial,
    darkMat: THREE.MeshStandardMaterial,
    roadZ: number
  ): void {
    const cabGeo = this.track(new THREE.BoxGeometry(3.2, 2.2, 2.3));
    const bodyGeo = this.track(new THREE.BoxGeometry(5.6, 2.5, 2.5));
    const vCount = 8;

    this.vehicleCabMesh = new THREE.InstancedMesh(cabGeo, whiteMat, vCount);
    this.vehicleBodyMesh = new THREE.InstancedMesh(bodyGeo, darkMat, vCount);

    const accentWhite = new THREE.Color("#f8fafc");
    const accentOrange = new THREE.Color("#ea580c");
    for (let i = 0; i < vCount; i++) {
      const dir: 1 | -1 = i % 2 === 0 ? 1 : -1;
      const speed = 13 + (i % 4) * 3.5;
      this.vehicles.push({
        laneZ: dir === 1 ? roadZ + 3.2 : roadZ - 3.2,
        dir,
        posX: -1550 + i * 225,
        speedMps: speed,
        baseSpeedMps: speed,
        holdX: -320 - i * 24,
        isTruck: i % 3 === 0,
      });
      this.vehicleCabMesh.setColorAt(i, i % 3 === 0 ? accentOrange : accentWhite);
    }
    if (this.vehicleCabMesh.instanceColor) {
      this.vehicleCabMesh.instanceColor.needsUpdate = true;
    }
    this.group.add(this.vehicleCabMesh, this.vehicleBodyMesh);
  }

  setPlanet(config: PlanetConfig, site: LaunchSiteConfig = this.currentSite): void {
    this.isEarthActive = config.id === "earth";
    this.group.visible = this.isEarthActive;
    if (config.id === "earth" && site.id !== this.currentSite.id) {
      this.setLaunchSite(site);
    }
  }

  setLaunchSite(site: LaunchSiteConfig): void {
    if (site.planetId !== "earth" || site.id === this.currentSite.id) {
      return;
    }
    this.buildEarthWorld(this.earthConfig, site);
    this.setQuality(this.quality, this.maxAnisotropy);
  }

  setQuality(quality: QualityPreset, maxAnisotropy = this.maxAnisotropy): void {
    const needLoad = this.pbrTextures.length === 0 || (this.quality === "high") !== (quality === "high");
    this.quality = quality;
    this.maxAnisotropy = maxAnisotropy;

    const scale = quality === "low" ? 0.5 : 1.0;
    if (this.scrubMesh) this.scrubMesh.count = Math.floor(MAX_SCRUB_COUNT * scale);
    if (this.grassMesh) this.grassMesh.count = Math.floor(MAX_GRASS_COUNT * scale);
    if (this.palmTrunkMesh) this.palmTrunkMesh.count = Math.floor(this.activePalmCount * scale);
    if (this.palmCrownMesh) this.palmCrownMesh.count = Math.floor(this.activePalmCount * scale);

    if (needLoad) {
      this.loadCoastalPbrTextures();
    }
  }

  private loadCoastalPbrTextures(): void {
    const seq = ++this.pbrLoadSeq;
    const disposeList = (items: THREE.Texture[]): void => {
      for (const t of items) t.dispose();
    };
    void Promise.all([
      loadPbrTextureSet("asphalt", 8, 1, this.maxAnisotropy, this.quality),
      loadPbrTextureSet("concrete", 6, 4, this.maxAnisotropy, this.quality),
      loadPbrTextureSet("metal_wall", 4, 4, this.maxAnisotropy, this.quality),
    ]).then(([asphaltPbr, concretePbr, metalPbr]) => {
      const next: THREE.Texture[] = [];
      if (seq !== this.pbrLoadSeq) {
        if (asphaltPbr) next.push(asphaltPbr.albedoMap, asphaltPbr.normalMap, asphaltPbr.roughnessMap);
        if (concretePbr) next.push(concretePbr.albedoMap, concretePbr.normalMap, concretePbr.roughnessMap);
        if (metalPbr) next.push(metalPbr.albedoMap, metalPbr.normalMap, metalPbr.roughnessMap);
        disposeList(next);
        return;
      }
      disposeList(this.pbrTextures);
      this.pbrTextures = [];
      if (asphaltPbr) {
        this.pbrTextures.push(asphaltPbr.albedoMap, asphaltPbr.normalMap, asphaltPbr.roughnessMap);
      }
      if (concretePbr) {
        this.pbrTextures.push(concretePbr.albedoMap, concretePbr.normalMap, concretePbr.roughnessMap);
      }
      if (metalPbr) {
        this.pbrTextures.push(metalPbr.albedoMap, metalPbr.normalMap, metalPbr.roughnessMap);
      }
      this.applyExistingPbrToSiteMaterials();
    });
  }

  update(dt: number, elapsedSec: number, camAltM: number, tel: FlightTelemetry): void {
    if (!this.isEarthActive) {
      this.group.visible = false;
      return;
    }

    const coastalFade = 1 - smoothstep(4500, 12000, camAltM);
    if (coastalFade <= 0.004) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const showDetails = camAltM < 6000;
    if (this.scrubMesh) this.scrubMesh.visible = showDetails;
    if (this.grassMesh) this.grassMesh.visible = showDetails;
    if (this.palmTrunkMesh) this.palmTrunkMesh.visible = showDetails && this.activePalmCount > 0;
    if (this.palmCrownMesh) this.palmCrownMesh.visible = showDetails && this.activePalmCount > 0;
    if (this.vehicleCabMesh) this.vehicleCabMesh.visible = showDetails;
    if (this.vehicleBodyMesh) this.vehicleBodyMesh.visible = showDetails;

    if (this.oceanMat) {
      this.oceanMat.uniforms.uTime.value = elapsedSec;
      this.oceanMat.uniforms.uOpacity.value = coastalFade;
    }

    if (this.radarPivot) {
      this.radarPivot.rotation.y = elapsedSec * 0.42;
    }

    if (this.strobeMat) {
      const pulse = Math.sin(elapsedSec * 3.8) > 0.68 ? 2.8 : 0.25;
      this.strobeMat.emissiveIntensity = pulse;
    }

    if (this.vehicleCabMesh && this.vehicleBodyMesh) {
      const holdLaunch =
        tel.phase === "COUNTDOWN" || tel.phase === "LIFTOFF" || tel.phase === "ASCENT";
      const simDt = Math.min(0.05, dt);

      for (let i = 0; i < this.vehicles.length; i++) {
        const v = this.vehicles[i];
        const nearPadDanger = holdLaunch && v.posX > -420;
        const targetSpd = nearPadDanger ? 0 : v.baseSpeedMps;
        v.speedMps += (targetSpd - v.speedMps) * Math.min(1, simDt * 3.5);
        v.posX += v.dir * v.speedMps * simDt;

        if (v.posX > 275) {
          v.posX = -1680;
        } else if (v.posX < -1720) {
          v.posX = 260;
        }

        const groundY = this.sampleGroundY(v.posX, v.laneZ);
        const yaw = v.dir === 1 ? 0 : Math.PI;
        const bodyShift = v.isTruck ? -2.2 * v.dir : -0.9 * v.dir;

        this.dummy.position.set(v.posX + 1.5 * v.dir, groundY + 1.32, v.laneZ);
        this.dummy.rotation.set(0, yaw, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        this.vehicleCabMesh.setMatrixAt(i, this.dummy.matrix);

        this.dummy.position.set(v.posX + bodyShift, groundY + 1.45, v.laneZ);
        this.dummy.scale.set(v.isTruck ? 1.0 : 0.55, v.isTruck ? 1.0 : 0.78, 1);
        this.dummy.updateMatrix();
        this.vehicleBodyMesh.setMatrixAt(i, this.dummy.matrix);
      }
      this.vehicleCabMesh.instanceMatrix.needsUpdate = true;
      this.vehicleBodyMesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    this.clearSiteGeometry();
    for (const tex of this.pbrTextures) {
      tex.dispose();
    }
    this.pbrTextures.length = 0;
  }
}
