import * as THREE from "three";
import { type LaunchSiteConfig, getDefaultLaunchSiteForPlanet } from "../config/launchSites";
import type { PlanetConfig } from "../config/planets";
import type { QualityPreset } from "../effects/PropulsionEffects";
import { SeededNoise2D, computeSphereDrop, samplePlanetTerrainHeight } from "../utils/noise";
import { loadPbrTextureSet } from "./PbrTextureLoader";
import {
  type PbrTextureSet,
  disposeTextureSet,
  generatePadConcreteTextureSet,
} from "./ProceduralTextures";

interface OrbitalStationAnim {
  readonly group: THREE.Group;
  readonly strobes: THREE.Mesh[];
  readonly radiusX: number;
  readonly radiusZ: number;
  readonly altitudeY: number;
  readonly angularSpeed: number;
  readonly phaseOffset: number;
}

/**
 * Rewrites cylinder top/bottom cap UVs to world-space planar XZ coordinates (`u = x / tileSizeM`,
 * `v = z / tileSizeM`) so downward engine-cam views show crisp uniform slabs with zero radial streaking.
 */
function applyPlanarCapUVs<T extends THREE.BufferGeometry>(geom: T, tileSizeM = 18): T {
  const pos = geom.getAttribute("position");
  const norm = geom.getAttribute("normal");
  const uv = geom.getAttribute("uv");
  if (!pos || !norm || !uv) {
    return geom;
  }
  const invTile = 1 / Math.max(1, tileSizeM);
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(norm.getY(i)) > 0.7) {
      uv.setXY(i, pos.getX(i) * invTile, pos.getZ(i) * invTile);
    }
  }
  uv.needsUpdate = true;
  return geom;
}

/**
 * Builds and manages planet-specific launch pads, surface stations/outposts,
 * and orbiting space stations for Earth, Mars, and Moon.
 */
export class LaunchComplex {
  public readonly group = new THREE.Group();

  private activeGroup = new THREE.Group();
  private orbitalStationHost = new THREE.Group();
  private padTextures: PbrTextureSet | null = null;
  private padDeckTextures: PbrTextureSet | null = null;
  private disposables: Array<{ dispose(): void }> = [];

  private padDeckY = 18.0;
  private planetSimRadiusM = 6_371_000;
  private baseFocusTarget = new THREE.Vector3(0, 12, 0);
  private loadSeq = 0;
  private activeConfig: PlanetConfig;
  private activeSite: LaunchSiteConfig;

  private qdArmPivot: THREE.Group | null = null;
  private catchCarriageGroup: THREE.Group | null = null;
  private chopstickLeftPivot: THREE.Group | null = null;
  private chopstickRightPivot: THREE.Group | null = null;
  private tulipArmPivots: Array<{ pivot: THREE.Group; baseTilt: number }> = [];
  private orbitalAnim: OrbitalStationAnim | null = null;

  constructor(
    initialConfig: PlanetConfig,
    maxAnisotropy: number,
    quality: QualityPreset = "med",
    initialSite: LaunchSiteConfig = getDefaultLaunchSiteForPlanet(initialConfig.id)
  ) {
    this.activeConfig = initialConfig;
    this.activeSite = initialSite;
    this.group.add(this.activeGroup, this.orbitalStationHost);
    this.updatePlanet(initialConfig, maxAnisotropy, quality, initialSite);
  }

  /** Strict scale-honest space culling: hides pad, tower, tanks & surface bases before globe transition. */
  setVisibilityForCameraAltitude(camAltM: number): void {
    const cullAlt = this.activeConfig.id === "earth" ? 9_800 : 16_000;
    this.activeGroup.visible = camAltM < cullAlt;
  }

  getPadDeckY(): number {
    return this.padDeckY;
  }

  getBaseFocusTarget(): THREE.Vector3 {
    return this.baseFocusTarget.clone();
  }

  getOrbitalStationWorldPosition(out = new THREE.Vector3()): THREE.Vector3 | null {
    if (!this.orbitalAnim) {
      return null;
    }
    return out.copy(this.orbitalAnim.group.position);
  }

  setUmbilicalRetracted(t: number): void {
    if (!this.qdArmPivot) {
      return;
    }
    const clamped = Math.max(0, Math.min(1, t));
    this.qdArmPivot.rotation.y = clamped * 1.18;
  }

  setCatchArmsOpen(open: number): void {
    const clamped = Math.max(0, Math.min(1, open));
    if (this.chopstickLeftPivot && this.chopstickRightPivot) {
      const angle = 0.08 + clamped * 0.56;
      this.chopstickLeftPivot.rotation.y = angle;
      this.chopstickRightPivot.rotation.y = -angle;
    }
    if (this.tulipArmPivots.length > 0) {
      const openAngle = clamped * 0.85;
      for (const arm of this.tulipArmPivots) {
        arm.pivot.rotation.z = arm.baseTilt - openAngle;
      }
    }
  }

  setCatchCarriageHeight(yM: number): void {
    if (!this.catchCarriageGroup) {
      return;
    }
    this.catchCarriageGroup.position.y = Math.max(70, Math.min(118, yM));
  }

  update(elapsedSec: number): void {
    if (!this.orbitalAnim) {
      return;
    }
    const { group, strobes, radiusX, radiusZ, altitudeY, angularSpeed, phaseOffset } =
      this.orbitalAnim;
    const theta = phaseOffset + elapsedSec * angularSpeed;
    const x = Math.cos(theta) * radiusX;
    const z = Math.sin(theta) * radiusZ;
    const sphereDrop = computeSphereDrop(Math.hypot(x, z), this.planetSimRadiusM);
    group.position.set(x, altitudeY + sphereDrop, z);
    // Orient station nose along orbital tangent
    const dx = -Math.sin(theta) * radiusX;
    const dz = Math.cos(theta) * radiusZ;
    group.rotation.y = Math.atan2(dx, dz);

    const pulse = Math.sin(elapsedSec * 4.2) > 0.72 ? 2.4 : 0.35;
    for (const s of strobes) {
      const mat = s.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = pulse;
    }
  }

  getLaunchSite(): LaunchSiteConfig {
    return this.activeSite;
  }

  setLaunchSite(
    site: LaunchSiteConfig,
    maxAnisotropy: number,
    quality: QualityPreset = "med"
  ): void {
    this.activeSite = site;
    this.updatePlanet(this.activeConfig, maxAnisotropy, quality, site);
  }

  updatePlanet(
    config: PlanetConfig,
    maxAnisotropy: number,
    quality: QualityPreset = "med",
    site: LaunchSiteConfig = getDefaultLaunchSiteForPlanet(config.id)
  ): void {
    this.clearCurrent();
    this.activeConfig = config;
    this.activeSite = site;
    this.planetSimRadiusM = config.scale.simRadiusM;
    const seq = ++this.loadSeq;

    this.activeGroup = new THREE.Group();
    this.orbitalStationHost = new THREE.Group();
    this.group.add(this.activeGroup, this.orbitalStationHost);

    const padTex = generatePadConcreteTextureSet(config, maxAnisotropy);
    this.padTextures = padTex;
    // Dedicated 1:1 repeat texture set for planar world-space XZ top-cap UVs (u = x/18, v = z/18)
    const padDeckTex = generatePadConcreteTextureSet(config, maxAnisotropy);
    padDeckTex.albedoMap.repeat.set(1, 1);
    padDeckTex.normalMap.repeat.set(1, 1);
    padDeckTex.roughnessMap.repeat.set(1, 1);
    this.padDeckTextures = padDeckTex;

    // Cap pad deck & concrete luminance strictly < 0.68 on Moon/Mars to prevent white bloom halo
    const isEarth = config.id === "earth";
    const isMars = config.id === "mars";
    const deckColor = isEarth ? "#aeb4bc" : isMars ? "#8f7160" : "#787d84";
    const concreteColor = isEarth ? "#b6bcc4" : isMars ? "#947868" : "#7d828a";

    const padDeckMat = new THREE.MeshStandardMaterial({
      color: deckColor,
      map: padDeckTex.albedoMap,
      normalMap: padDeckTex.normalMap,
      roughnessMap: padDeckTex.roughnessMap,
      roughness: isEarth ? 0.88 : 0.94,
      metalness: 0.04,
      emissiveIntensity: 0,
    });
    const concreteMat = new THREE.MeshStandardMaterial({
      color: concreteColor,
      map: padTex.albedoMap,
      normalMap: padTex.normalMap,
      roughnessMap: padTex.roughnessMap,
      roughness: isEarth ? 0.88 : 0.93,
      metalness: 0.04,
      emissiveIntensity: 0,
    });
    const steelMat = new THREE.MeshStandardMaterial({
      color: "#4b5563",
      metalness: 0.82,
      roughness: 0.36,
    });
    const brightSteelMat = new THREE.MeshStandardMaterial({
      color: isEarth ? "#bcc6d4" : "#9aa4b2",
      metalness: 0.82,
      roughness: 0.30,
    });
    // Matte industrial tank/hab paint capped well below bloom threshold even under Moon 3.8 sun
    const whiteTankMat = new THREE.MeshStandardMaterial({
      color: isEarth ? "#c5cdd6" : isMars ? "#b2aaa2" : "#99a0a8",
      metalness: 0.12,
      roughness: 0.58,
    });
    const goldSolarMat = new THREE.MeshStandardMaterial({
      color: "#c58f2a",
      metalness: 0.65,
      roughness: 0.25,
    });
    const solarBlueMat = new THREE.MeshStandardMaterial({
      color: "#1e3a8a",
      metalness: 0.55,
      roughness: 0.22,
    });
    const beaconOrangeMat = new THREE.MeshStandardMaterial({
      color: "#ffedd5",
      emissive: "#f97316",
      emissiveIntensity: 1.9,
      roughness: 0.3,
    });
    const windowGlowMat = new THREE.MeshStandardMaterial({
      color: "#fef3c7",
      emissive: "#f59e0b",
      emissiveIntensity: 1.5,
      roughness: 0.25,
    });

    this.disposables.push(
      padDeckMat,
      concreteMat,
      steelMat,
      brightSteelMat,
      whiteTankMat,
      goldSolarMat,
      solarBlueMat,
      beaconOrangeMat,
      windowGlowMat
    );

    if (config.id === "earth") {
      if (site.padStyle === "starbase_olm") {
        this.buildEarthStarbase(
          padDeckMat,
          concreteMat,
          steelMat,
          brightSteelMat,
          whiteTankMat,
          beaconOrangeMat
        );
      } else {
        this.buildEarthGlobalPad(
          site,
          padDeckMat,
          concreteMat,
          steelMat,
          brightSteelMat,
          whiteTankMat,
          beaconOrangeMat
        );
      }
    } else if (config.id === "mars") {
      this.buildMarsSpaceport(
        config,
        padDeckMat,
        steelMat,
        brightSteelMat,
        whiteTankMat,
        solarBlueMat,
        beaconOrangeMat,
        windowGlowMat
      );
    } else {
      this.buildMoonSpaceport(
        config,
        padDeckMat,
        steelMat,
        brightSteelMat,
        whiteTankMat,
        goldSolarMat,
        beaconOrangeMat,
        windowGlowMat
      );
    }

    // Load real 4K Poly Haven PBR concrete maps asynchronously for Earth pad aprons & concrete legs
    if (isEarth) {
      void Promise.all([
        loadPbrTextureSet("concrete", 5, 5, maxAnisotropy, quality),
        loadPbrTextureSet("concrete", 1, 1, maxAnisotropy, quality),
      ]).then(([legPbr, deckPbr]) => {
        if (seq !== this.loadSeq) {
          if (legPbr) {
            legPbr.albedoMap.dispose();
            legPbr.normalMap.dispose();
            legPbr.roughnessMap.dispose();
          }
          if (deckPbr) {
            deckPbr.albedoMap.dispose();
            deckPbr.normalMap.dispose();
            deckPbr.roughnessMap.dispose();
          }
          return;
        }
        if (legPbr) {
          concreteMat.map = legPbr.albedoMap;
          concreteMat.normalMap = legPbr.normalMap;
          concreteMat.roughnessMap = legPbr.roughnessMap;
          concreteMat.needsUpdate = true;
          this.disposables.push(legPbr.albedoMap, legPbr.normalMap, legPbr.roughnessMap);
        }
        if (deckPbr) {
          padDeckMat.map = deckPbr.albedoMap;
          padDeckMat.normalMap = deckPbr.normalMap;
          padDeckMat.roughnessMap = deckPbr.roughnessMap;
          padDeckMat.needsUpdate = true;
          this.disposables.push(deckPbr.albedoMap, deckPbr.normalMap, deckPbr.roughnessMap);
        }
      });
    }
  }

  private trackGeom<T extends THREE.BufferGeometry>(geom: T): T {
    this.disposables.push(geom);
    return geom;
  }

  private buildEarthStarbase(
    padDeckMat: THREE.MeshStandardMaterial,
    concreteMat: THREE.MeshStandardMaterial,
    steelMat: THREE.MeshStandardMaterial,
    brightSteelMat: THREE.MeshStandardMaterial,
    whiteTankMat: THREE.MeshStandardMaterial,
    beaconMat: THREE.MeshStandardMaterial
  ): void {
    this.padDeckY = 18.0;
    this.baseFocusTarget.set(16, 22, 0);

    // Concrete apron (planar XZ top UVs -> zero radial streaking in F3 Engine) + flame deluge trench pit
    const apron = new THREE.Mesh(
      this.trackGeom(applyPlanarCapUVs(new THREE.CylinderGeometry(56, 60, 0.8, 48), 18)),
      padDeckMat
    );
    apron.position.y = -0.35;
    apron.receiveShadow = true;
    this.activeGroup.add(apron);

    const trenchMat = new THREE.MeshStandardMaterial({
      color: "#1f2937",
      metalness: 0.72,
      roughness: 0.55,
    });
    this.disposables.push(trenchMat);

    const flameTrench = new THREE.Mesh(
      this.trackGeom(new THREE.CylinderGeometry(13.5, 11.0, 1.2, 32)),
      trenchMat
    );
    flameTrench.position.y = 0.25;
    flameTrench.receiveShadow = true;
    this.activeGroup.add(flameTrench);

    // Subtle Raptor blast-scorch ring beneath OLM trench
    const scorchMat = new THREE.MeshStandardMaterial({
      color: "#1e2229",
      roughness: 0.96,
      metalness: 0.04,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
    });
    this.disposables.push(scorchMat);
    const scorchDecal = new THREE.Mesh(
      this.trackGeom(new THREE.RingGeometry(12.5, 29.0, 36)),
      scorchMat
    );
    scorchDecal.rotation.x = -Math.PI * 0.5;
    scorchDecal.position.y = 0.09;
    this.activeGroup.add(scorchDecal);

    // Elevated Orbital Launch Mount (OLM) table at y = 18.0m on 6 angled legs
    const olmRing = new THREE.Mesh(
      this.trackGeom(new THREE.CylinderGeometry(11.4, 12.6, 3.2, 18, 1, true)),
      steelMat
    );
    olmRing.position.y = 16.4;
    olmRing.castShadow = true;
    olmRing.receiveShadow = true;
    this.activeGroup.add(olmRing);

    const olmDeck = new THREE.Mesh(
      this.trackGeom(applyPlanarCapUVs(new THREE.CylinderGeometry(11.4, 11.4, 1.0, 24), 12)),
      steelMat
    );
    olmDeck.position.y = 17.5;
    olmDeck.castShadow = true;
    olmDeck.receiveShadow = true;
    this.activeGroup.add(olmDeck);

    // 6 heavy angled concrete/steel blast legs (instanced to keep draw calls lean)
    const legGeom = this.trackGeom(new THREE.CylinderGeometry(1.5, 2.3, 18.4, 12));
    const legsInst = new THREE.InstancedMesh(legGeom, concreteMat, 6);
    legsInst.castShadow = true;
    legsInst.receiveShadow = true;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * 11.8, 8.6, Math.sin(a) * 11.8);
      dummy.rotation.set(-Math.sin(a) * 0.22, 0, Math.cos(a) * 0.22);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      legsInst.setMatrixAt(i, dummy.matrix);
    }
    legsInst.instanceMatrix.needsUpdate = true;
    this.activeGroup.add(legsInst);

    // 20 instanced hold-down clamps around OLM rim
    const clampGeom = this.trackGeom(new THREE.BoxGeometry(0.9, 1.4, 1.5));
    const clamps = new THREE.InstancedMesh(clampGeom, brightSteelMat, 20);
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * 5.2, 18.4, Math.sin(a) * 5.2);
      dummy.rotation.set(0, -a, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      clamps.setMatrixAt(i, dummy.matrix);
    }
    clamps.instanceMatrix.needsUpdate = true;
    this.activeGroup.add(clamps);

    // Mechazilla Launch & Catch Tower (145m tall beside pad at x = -23m)
    const towerX = -23;
    const towerH = 145;
    const towerHalf = 4.6;
    const towerGroup = new THREE.Group();
    towerGroup.position.set(towerX, 0, 0);

    const colGeom = this.trackGeom(new THREE.BoxGeometry(1.4, towerH, 1.4));
    const colsInst = new THREE.InstancedMesh(colGeom, steelMat, 4);
    colsInst.castShadow = true;
    let cIdx = 0;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        dummy.position.set(sx * towerHalf, towerH * 0.5, sz * towerHalf);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        colsInst.setMatrixAt(cIdx++, dummy.matrix);
      }
    }
    colsInst.instanceMatrix.needsUpdate = true;
    towerGroup.add(colsInst);

    // Instanced horizontal & cross-bracing tower lattice bays (18 levels x 4 faces)
    const bayH = towerH / 18;
    const braceGeom = this.trackGeom(new THREE.BoxGeometry(towerHalf * 2, 0.48, 0.48));
    const braces = new THREE.InstancedMesh(braceGeom, steelMat, 18 * 4);
    let bIdx = 0;
    for (let lvl = 1; lvl <= 18; lvl++) {
      const y = lvl * bayH;
      for (let f = 0; f < 4; f++) {
        const isZ = f < 2;
        const s = f % 2 === 0 ? -1 : 1;
        dummy.position.set(isZ ? 0 : s * towerHalf, y, isZ ? s * towerHalf : 0);
        dummy.rotation.set(0, isZ ? 0 : Math.PI * 0.5, 0);
        dummy.updateMatrix();
        braces.setMatrixAt(bIdx++, dummy.matrix);
      }
    }
    braces.instanceMatrix.needsUpdate = true;
    towerGroup.add(braces);

    // Carriage & animated Chopstick Catch Arms inside vertically translating catchCarriageGroup
    this.catchCarriageGroup = new THREE.Group();
    this.catchCarriageGroup.position.set(0, 108, 0);

    const carriage = new THREE.Mesh(
      this.trackGeom(new THREE.BoxGeometry(11.4, 7.5, 11.4)),
      brightSteelMat
    );
    carriage.position.set(0, 0, 0);
    this.catchCarriageGroup.add(carriage);

    const armGeom = this.trackGeom(new THREE.BoxGeometry(24.0, 2.2, 1.4));
    this.chopstickLeftPivot = new THREE.Group();
    this.chopstickLeftPivot.position.set(5.2, 0, -4.6);
    const leftArm = new THREE.Mesh(armGeom, brightSteelMat);
    leftArm.position.set(12.0, 0, 0);
    leftArm.castShadow = true;
    this.chopstickLeftPivot.add(leftArm);

    this.chopstickRightPivot = new THREE.Group();
    this.chopstickRightPivot.position.set(5.2, 0, 4.6);
    const rightArm = new THREE.Mesh(armGeom, brightSteelMat);
    rightArm.position.set(12.0, 0, 0);
    rightArm.castShadow = true;
    this.chopstickRightPivot.add(rightArm);

    this.catchCarriageGroup.add(this.chopstickLeftPivot, this.chopstickRightPivot);
    towerGroup.add(this.catchCarriageGroup);
    this.setCatchArmsOpen(0.18);

    // Quick Disconnect (QD) Umbilical Arm
    this.qdArmPivot = new THREE.Group();
    this.qdArmPivot.position.set(4.8, 72, 0);
    const qdArm = new THREE.Mesh(
      this.trackGeom(new THREE.BoxGeometry(16.5, 1.3, 1.4)),
      brightSteelMat
    );
    qdArm.position.set(8.2, 0, 0);
    qdArm.castShadow = true;
    this.qdArmPivot.add(qdArm);
    towerGroup.add(this.qdArmPivot);

    // Lightning mast atop tower
    const mast = new THREE.Mesh(
      this.trackGeom(new THREE.CylinderGeometry(0.15, 0.45, 14, 8)),
      brightSteelMat
    );
    mast.position.set(0, towerH + 7, 0);
    const topStrobe = new THREE.Mesh(
      this.trackGeom(new THREE.SphereGeometry(0.55, 8, 8)),
      beaconMat
    );
    topStrobe.position.set(0, towerH + 14.2, 0);
    towerGroup.add(mast, topStrobe);
    this.activeGroup.add(towerGroup);

    // Cryogenic Tank Farm (6 LOX/CH4 vertical tanks + spherical deluge tank + pipeline)
    const farmGroup = new THREE.Group();
    farmGroup.position.set(74, 0, -14);
    const tankGeom = this.trackGeom(new THREE.CylinderGeometry(4.2, 4.2, 24, 20));
    const tankDomeGeom = this.trackGeom(new THREE.SphereGeometry(4.2, 20, 12));
    const tankCylInst = new THREE.InstancedMesh(tankGeom, whiteTankMat, 6);
    const tankDomeInst = new THREE.InstancedMesh(tankDomeGeom, whiteTankMat, 6);
    tankCylInst.castShadow = true;
    tankCylInst.receiveShadow = true;
    let tIdx = 0;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const tx = col * 12;
        const tz = row * 14;
        dummy.position.set(tx, 12, tz);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        tankCylInst.setMatrixAt(tIdx, dummy.matrix);

        dummy.position.set(tx, 24, tz);
        dummy.updateMatrix();
        tankDomeInst.setMatrixAt(tIdx, dummy.matrix);
        tIdx += 1;
      }
    }
    tankCylInst.instanceMatrix.needsUpdate = true;
    tankDomeInst.instanceMatrix.needsUpdate = true;
    farmGroup.add(tankCylInst, tankDomeInst);

    const sphereTank = new THREE.Mesh(
      this.trackGeom(new THREE.SphereGeometry(7.2, 24, 16)),
      whiteTankMat
    );
    sphereTank.position.set(12, 9.5, -15);
    sphereTank.castShadow = true;
    farmGroup.add(sphereTank);

    const pipe = new THREE.Mesh(
      this.trackGeom(new THREE.CylinderGeometry(0.65, 0.65, 62, 10)),
      brightSteelMat
    );
    pipe.rotation.z = Math.PI * 0.5;
    pipe.position.set(-34, 2.2, 14);
    farmGroup.add(pipe);
    this.activeGroup.add(farmGroup);

    // 4 Perimeter Stadium Floodlight Masts (instanced)
    const mastPoleGeom = this.trackGeom(new THREE.CylinderGeometry(0.35, 0.55, 34, 8));
    const floodHeadGeom = this.trackGeom(new THREE.BoxGeometry(3.2, 1.4, 0.9));
    const floodPoleInst = new THREE.InstancedMesh(mastPoleGeom, steelMat, 4);
    const floodHeadInst = new THREE.InstancedMesh(floodHeadGeom, beaconMat, 4);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
      const mx = Math.cos(a) * 51;
      const mz = Math.sin(a) * 51;
      dummy.position.set(mx, 17, mz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      floodPoleInst.setMatrixAt(i, dummy.matrix);

      dummy.position.set(mx, 34.2, mz);
      dummy.lookAt(0, 18, 0);
      dummy.updateMatrix();
      floodHeadInst.setMatrixAt(i, dummy.matrix);
    }
    floodPoleInst.instanceMatrix.needsUpdate = true;
    floodHeadInst.instanceMatrix.needsUpdate = true;
    this.activeGroup.add(floodPoleInst, floodHeadInst);
  }

  private buildEarthGlobalPad(
    site: LaunchSiteConfig,
    padDeckMat: THREE.MeshStandardMaterial,
    concreteMat: THREE.MeshStandardMaterial,
    steelMat: THREE.MeshStandardMaterial,
    brightSteelMat: THREE.MeshStandardMaterial,
    whiteTankMat: THREE.MeshStandardMaterial,
    beaconMat: THREE.MeshStandardMaterial
  ): void {
    const padDeckHeights: Record<string, number> = {
      ksc_fss_ramp: 12.0,
      shar_umbilical: 8.5,
      kourou_gantry: 9.0,
      tanegashima_bluff: 10.0,
      baikonur_tulip: 6.5,
    };
    const deckY = padDeckHeights[site.padStyle] ?? 9.0;
    this.padDeckY = deckY;
    this.baseFocusTarget.set(175, 16, -65);

    const earth = this.activeConfig;
    const noise = new SeededNoise2D(earth.terrain.seed);
    const gPad = samplePlanetTerrainHeight(0, 0, earth, noise, site);

    // Reinforced octagonal launch apron (planar XZ UVs eliminate Saturn V F3 radial streaking)
    const apron = new THREE.Mesh(
      this.trackGeom(applyPlanarCapUVs(new THREE.CylinderGeometry(42, 48, deckY + 2.0, 8), 18)),
      padDeckMat
    );
    apron.position.set(0, gPad + (deckY - 2.0) * 0.5, 0);
    apron.receiveShadow = true;
    this.activeGroup.add(apron);

    // Steel launch table ring & flame deflector trench
    const tableRing = new THREE.Mesh(
      this.trackGeom(new THREE.CylinderGeometry(11.5, 13.0, 2.2, 16)),
      steelMat
    );
    tableRing.position.set(0, deckY - 1.1, 0);
    tableRing.castShadow = true;
    tableRing.receiveShadow = true;
    this.activeGroup.add(tableRing);

    const flameTrench = new THREE.Mesh(
      this.trackGeom(new THREE.BoxGeometry(58, 2.8, 12.5)),
      steelMat
    );
    flameTrench.position.set(8, Math.max(gPad + 1.4, deckY - 3.6), 0);
    flameTrench.receiveShadow = true;
    this.activeGroup.add(flameTrench);

    const deflector = new THREE.Mesh(
      this.trackGeom(new THREE.ConeGeometry(8.5, 4.2, 4)),
      steelMat
    );
    deflector.position.set(0, Math.max(gPad + 2.1, deckY - 3.8), 0);
    deflector.rotation.y = Math.PI * 0.25;
    this.activeGroup.add(deflector);

    const beaconGeom = this.trackGeom(new THREE.SphereGeometry(0.65, 8, 8));

    if (site.padStyle === "baikonur_tulip") {
      // Classic Soviet-era Baikonur Soyuz/Proton tulip truss launch stand
      const armAngles = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
      this.tulipArmPivots = [];
      for (const ang of armAngles) {
        const pivot = new THREE.Group();
        pivot.position.set(Math.cos(ang) * 9.5, deckY, Math.sin(ang) * 9.5);
        pivot.rotation.y = -ang;
        const baseTilt = 0.08;
        pivot.rotation.z = baseTilt;

        const armBeam = new THREE.Mesh(
          this.trackGeom(new THREE.BoxGeometry(2.6, 28, 3.2)),
          brightSteelMat
        );
        armBeam.position.set(0, 14, 0);
        armBeam.castShadow = true;
        pivot.add(armBeam);

        const clampHead = new THREE.Mesh(
          this.trackGeom(new THREE.BoxGeometry(4.2, 2.4, 2.8)),
          steelMat
        );
        clampHead.position.set(-1.8, 25.5, 0);
        pivot.add(clampHead);

        this.tulipArmPivots.push({ pivot, baseTilt });
        this.activeGroup.add(pivot);
      }

      // Rail-mounted umbilical & cabling mast
      const mast = new THREE.Mesh(
        this.trackGeom(new THREE.BoxGeometry(5.5, 58, 5.5)),
        brightSteelMat
      );
      mast.position.set(-22, gPad + 29, 0);
      mast.castShadow = true;
      this.activeGroup.add(mast);

      this.qdArmPivot = new THREE.Group();
      this.qdArmPivot.position.set(-19, 36, 0);
      const qdArm = new THREE.Mesh(
        this.trackGeom(new THREE.BoxGeometry(14, 2.0, 2.4)),
        steelMat
      );
      qdArm.position.set(7, 0, 0);
      this.qdArmPivot.add(qdArm);
      this.activeGroup.add(this.qdArmPivot);

      const b = new THREE.Mesh(beaconGeom, beaconMat);
      b.position.set(-22, gPad + 59, 0);
      this.activeGroup.add(b);
    } else {
      // Tall Fixed Service Structure (FSS) / Umbilical Tower + swing arm + lightning masts
      const isKsc = site.padStyle === "ksc_fss_ramp";
      const isShar = site.padStyle === "shar_umbilical";
      const isKourou = site.padStyle === "kourou_gantry";
      const towerH = isKsc ? 108 : isKourou ? 82 : 76;
      const towerX = -24;

      const towerMat = isShar || isKourou ? brightSteelMat : steelMat;
      const tower = new THREE.Mesh(
        this.trackGeom(new THREE.BoxGeometry(11.5, towerH, 11.5)),
        towerMat
      );
      tower.position.set(towerX, deckY + towerH * 0.5, 0);
      tower.castShadow = true;
      tower.receiveShadow = true;
      this.activeGroup.add(tower);

      // Exterior structural ribs & elevator shaft contrast
      const ribGeom = this.trackGeom(new THREE.BoxGeometry(12.2, 1.1, 12.2));
      for (let ry = deckY + 12; ry < deckY + towerH - 4; ry += 14) {
        const rib = new THREE.Mesh(ribGeom, isKsc ? brightSteelMat : steelMat);
        rib.position.set(towerX, ry, 0);
        this.activeGroup.add(rib);
      }

      // Crew access / umbilical swing arm
      this.qdArmPivot = new THREE.Group();
      this.qdArmPivot.position.set(towerX + 5.5, deckY + Math.min(towerH - 12, 58), 0);
      const armLen = isKsc ? 18 : 15;
      const swingArm = new THREE.Mesh(
        this.trackGeom(new THREE.BoxGeometry(armLen, 2.6, 3.4)),
        isKsc ? whiteTankMat : brightSteelMat
      );
      swingArm.position.set(armLen * 0.5, 0, 0);
      swingArm.castShadow = true;
      this.qdArmPivot.add(swingArm);
      this.activeGroup.add(this.qdArmPivot);

      // Mobile service structure / acoustic water-deluge tank next to apron
      const waterTank = new THREE.Mesh(
        this.trackGeom(new THREE.CylinderGeometry(5.8, 5.8, 22, 16)),
        whiteTankMat
      );
      waterTank.position.set(-34, gPad + 11, 24);
      waterTank.castShadow = true;
      this.activeGroup.add(waterTank);

      // 4 perimeter lightning protection towers
      const mastGeom = this.trackGeom(new THREE.CylinderGeometry(0.45, 1.35, 86, 8));
      const mastOffsets: Array<[number, number]> = [
        [-48, -48],
        [48, -48],
        [-48, 48],
        [48, 48],
      ];
      for (const [mx, mz] of mastOffsets) {
        const gy = samplePlanetTerrainHeight(mx, mz, earth, noise, site);
        const mast = new THREE.Mesh(mastGeom, brightSteelMat);
        mast.position.set(mx, gy + 43, mz);
        mast.castShadow = true;
        const b = new THREE.Mesh(beaconGeom, beaconMat);
        b.position.set(mx, gy + 86.5, mz);
        this.activeGroup.add(mast, b);
      }

      const topBeacon = new THREE.Mesh(beaconGeom, beaconMat);
      topBeacon.position.set(towerX, deckY + towerH + 1.5, 0);
      this.activeGroup.add(topBeacon);
    }

    // Dual spherical cryogenic LOX / LH2 storage spheres set back West of pad
    const sphereGeom = this.trackGeom(new THREE.SphereGeometry(7.2, 18, 14));
    for (const [sx, sz] of [
      [-68, -28],
      [-68, 28],
    ] as Array<[number, number]>) {
      const gy = samplePlanetTerrainHeight(sx, sz, earth, noise, site);
      const sph = new THREE.Mesh(sphereGeom, whiteTankMat);
      sph.position.set(sx, gy + 9.5, sz);
      sph.castShadow = true;
      sph.receiveShadow = true;
      const plinth = new THREE.Mesh(
        this.trackGeom(new THREE.CylinderGeometry(5.5, 6.2, 4.5, 12)),
        concreteMat
      );
      plinth.position.set(sx, gy + 2.25, sz);
      this.activeGroup.add(sph, plinth);
    }

    // Perimeter pad floodlight poles
    const floodPoleGeom = this.trackGeom(new THREE.CylinderGeometry(0.28, 0.42, 34, 6));
    const floodHeadGeom = this.trackGeom(new THREE.BoxGeometry(2.6, 1.1, 1.4));
    const floodPoleInst = new THREE.InstancedMesh(floodPoleGeom, steelMat, 6);
    const floodHeadInst = new THREE.InstancedMesh(floodHeadGeom, beaconMat, 6);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      const mx = Math.cos(ang) * 62;
      const mz = Math.sin(ang) * 62;
      const gy = samplePlanetTerrainHeight(mx, mz, earth, noise, site);
      dummy.position.set(mx, gy + 17, mz);
      dummy.rotation.set(0, -ang, 0);
      dummy.updateMatrix();
      floodPoleInst.setMatrixAt(i, dummy.matrix);

      dummy.position.set(mx, gy + 34.2, mz);
      dummy.lookAt(0, deckY + 12, 0);
      dummy.updateMatrix();
      floodHeadInst.setMatrixAt(i, dummy.matrix);
    }
    floodPoleInst.instanceMatrix.needsUpdate = true;
    floodHeadInst.instanceMatrix.needsUpdate = true;
    this.activeGroup.add(floodPoleInst, floodHeadInst);
  }

  private buildMarsSpaceport(
    config: PlanetConfig,
    padDeckMat: THREE.MeshStandardMaterial,
    steelMat: THREE.MeshStandardMaterial,
    brightSteelMat: THREE.MeshStandardMaterial,
    whiteTankMat: THREE.MeshStandardMaterial,
    solarMat: THREE.MeshStandardMaterial,
    beaconMat: THREE.MeshStandardMaterial,
    windowGlowMat: THREE.MeshStandardMaterial
  ): void {
    this.padDeckY = 2.2;
    this.baseFocusTarget.set(175, 10, -80);

    // Sintered-regolith octagonal blast deck (matte capped albedo + planar XZ UVs)
    const deck = new THREE.Mesh(
      this.trackGeom(applyPlanarCapUVs(new THREE.CylinderGeometry(42, 48, 2.2, 8), 18)),
      padDeckMat
    );
    deck.position.y = 1.1;
    deck.receiveShadow = true;
    this.activeGroup.add(deck);

    const cone = new THREE.Mesh(
      this.trackGeom(new THREE.ConeGeometry(8.5, 2.0, 16)),
      steelMat
    );
    cone.position.y = 1.2;
    cone.receiveShadow = true;
    this.activeGroup.add(cone);

    const trenchGeom = this.trackGeom(new THREE.BoxGeometry(82, 0.5, 3.6));
    for (let i = 0; i < 2; i++) {
      const trench = new THREE.Mesh(trenchGeom, steelMat);
      trench.position.y = 2.05;
      trench.rotation.y = i * Math.PI * 0.5;
      this.activeGroup.add(trench);
    }

    // Compact servicing gantry + retracting umbilical arm
    const gantry = new THREE.Group();
    gantry.position.set(-19, 0, 0);
    const tower = new THREE.Mesh(
      this.trackGeom(new THREE.BoxGeometry(5.6, 84, 5.6)),
      steelMat
    );
    tower.position.y = 42;
    tower.castShadow = true;
    gantry.add(tower);

    this.qdArmPivot = new THREE.Group();
    this.qdArmPivot.position.set(2.8, 54, 0);
    const arm = new THREE.Mesh(
      this.trackGeom(new THREE.BoxGeometry(14.5, 1.1, 1.1)),
      brightSteelMat
    );
    arm.position.set(7.2, 0, 0);
    this.qdArmPivot.add(arm);
    gantry.add(this.qdArmPivot);
    this.activeGroup.add(gantry);

    // Amber pad perimeter beacons
    const beaconGeom = this.trackGeom(new THREE.SphereGeometry(0.45, 10, 8));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const b = new THREE.Mesh(beaconGeom, beaconMat);
      b.position.set(Math.cos(a) * 39, 2.45, Math.sin(a) * 39);
      this.activeGroup.add(b);
    }

    // Mars Surface Habitat Base & ISRU Sabatier Plant (~180 m away, seated on terrain)
    const noise = new SeededNoise2D(config.terrain.seed);
    const baseCenter = new THREE.Vector3(175, 0, -80);
    const groundY = samplePlanetTerrainHeight(baseCenter.x, baseCenter.z, config, noise);
    const habGroup = new THREE.Group();
    habGroup.position.set(baseCenter.x, groundY, baseCenter.z);

    // Foundation slab piercing slightly below terrain slope so modules never float
    const foundation = new THREE.Mesh(
      this.trackGeom(applyPlanarCapUVs(new THREE.CylinderGeometry(42, 46, 8, 12), 18)),
      padDeckMat
    );
    foundation.position.y = -3.4;
    foundation.receiveShadow = true;
    habGroup.add(foundation);

    // 3 Geodesic pressurized habitat domes with glowing viewports
    const domeConfigs = [
      { x: 0, z: 0, r: 10.5 },
      { x: -21, z: 10, r: 7.5 },
      { x: 19, z: 13, r: 7.0 },
    ];
    for (const d of domeConfigs) {
      const dome = new THREE.Mesh(
        this.trackGeom(new THREE.SphereGeometry(d.r, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55)),
        whiteTankMat
      );
      dome.position.set(d.x, 0.2, d.z);
      dome.castShadow = true;
      dome.receiveShadow = true;
      habGroup.add(dome);

      const viewport = new THREE.Mesh(
        this.trackGeom(new THREE.CylinderGeometry(d.r * 0.88, d.r * 0.88, 1.0, 18)),
        windowGlowMat
      );
      viewport.position.set(d.x, 1.9, d.z);
      habGroup.add(viewport);
    }

    // Connecting airlock tunnels
    const tunnelGeom = this.trackGeom(new THREE.CylinderGeometry(1.8, 1.8, 18, 12));
    for (const ang of [-0.45, 0.62]) {
      const tunnel = new THREE.Mesh(tunnelGeom, brightSteelMat);
      tunnel.rotation.z = Math.PI * 0.5;
      tunnel.rotation.y = ang;
      tunnel.position.set(ang < 0 ? -10 : 9, 2.2, 6);
      habGroup.add(tunnel);
    }

    // ISRU Sabatier CH4/O2 Cryo Spheres & Processor Racks
    const isruSphereGeom = this.trackGeom(new THREE.SphereGeometry(4.2, 16, 12));
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.Mesh(isruSphereGeom, whiteTankMat);
      sp.position.set(-14 + i * 11, 4.4, -22);
      sp.castShadow = true;
      habGroup.add(sp);
    }

    // 12 Instanced Martian Solar Farm Panels
    const panelGeom = this.trackGeom(new THREE.BoxGeometry(7.2, 0.22, 3.8));
    const panels = new THREE.InstancedMesh(panelGeom, solarMat, 12);
    const dummy = new THREE.Object3D();
    let pIdx = 0;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        dummy.position.set(28 + c * 9.5, 2.2, -24 + r * 8);
        dummy.rotation.set(0.42, 0, 0);
        dummy.updateMatrix();
        panels.setMatrixAt(pIdx++, dummy.matrix);
      }
    }
    panels.instanceMatrix.needsUpdate = true;
    habGroup.add(panels);

    // High-gain deep-space comms dish
    const dishPole = new THREE.Mesh(
      this.trackGeom(new THREE.CylinderGeometry(0.4, 0.6, 11, 10)),
      brightSteelMat
    );
    dishPole.position.set(24, 5.5, 24);
    const dish = new THREE.Mesh(
      this.trackGeom(new THREE.SphereGeometry(4.4, 18, 10, 0, Math.PI * 2, 0, 0.65)),
      whiteTankMat
    );
    dish.position.set(24, 11.4, 24);
    dish.rotation.x = Math.PI * 0.72;
    habGroup.add(dishPole, dish);
    this.activeGroup.add(habGroup);
  }

  private buildMoonSpaceport(
    config: PlanetConfig,
    padDeckMat: THREE.MeshStandardMaterial,
    steelMat: THREE.MeshStandardMaterial,
    brightSteelMat: THREE.MeshStandardMaterial,
    whiteTankMat: THREE.MeshStandardMaterial,
    goldSolarMat: THREE.MeshStandardMaterial,
    beaconMat: THREE.MeshStandardMaterial,
    windowGlowMat: THREE.MeshStandardMaterial
  ): void {
    this.padDeckY = 1.6;
    this.baseFocusTarget.set(-180, 10, -85);

    // Sintered lunar regolith landing pad (matte capped albedo + planar XZ UVs, zero white bloom halo)
    const deck = new THREE.Mesh(
      this.trackGeom(applyPlanarCapUVs(new THREE.CylinderGeometry(40, 44, 1.6, 36), 18)),
      padDeckMat
    );
    deck.position.y = 0.8;
    deck.receiveShadow = true;
    this.activeGroup.add(deck);

    // Raised 360° regolith blast-shield berm protecting outpost from vacuum ejecta
    const bermMat = new THREE.MeshStandardMaterial({
      color: config.terrain.soilPalette[0],
      roughness: 0.94,
      metalness: 0.04,
    });
    this.disposables.push(bermMat);

    const bermPts = [
      new THREE.Vector2(43.5, 0),
      new THREE.Vector2(47.2, 4.6),
      new THREE.Vector2(49.5, 4.6),
      new THREE.Vector2(54.5, 0),
    ];
    const berm = new THREE.Mesh(
      this.trackGeom(new THREE.LatheGeometry(bermPts, 36)),
      bermMat
    );
    berm.receiveShadow = true;
    berm.castShadow = true;
    this.activeGroup.add(berm);

    // Low-profile lunar servicing gantry + retracting umbilical
    const gantry = new THREE.Group();
    gantry.position.set(-18, 0, 0);
    const tower = new THREE.Mesh(
      this.trackGeom(new THREE.BoxGeometry(4.4, 62, 4.4)),
      steelMat
    );
    tower.position.y = 31;
    tower.castShadow = true;
    gantry.add(tower);

    this.qdArmPivot = new THREE.Group();
    this.qdArmPivot.position.set(2.2, 42, 0);
    const arm = new THREE.Mesh(
      this.trackGeom(new THREE.BoxGeometry(13.5, 0.95, 0.95)),
      brightSteelMat
    );
    arm.position.set(6.8, 0, 0);
    this.qdArmPivot.add(arm);
    gantry.add(this.qdArmPivot);
    this.activeGroup.add(gantry);

    // Crisp LED approach guide lights
    const ledGeom = this.trackGeom(new THREE.SphereGeometry(0.42, 8, 8));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const led = new THREE.Mesh(ledGeom, beaconMat);
      led.position.set(Math.cos(a) * 37, 1.8, Math.sin(a) * 37);
      this.activeGroup.add(led);
    }

    // Lunar Surface Outpost (~185 m away, seated on sampled Shackleton terrain)
    const noise = new SeededNoise2D(config.terrain.seed);
    const baseCenter = new THREE.Vector3(-180, 0, -85);
    const groundY = samplePlanetTerrainHeight(baseCenter.x, baseCenter.z, config, noise);
    const outpost = new THREE.Group();
    outpost.position.set(baseCenter.x, groundY, baseCenter.z);

    const padSlab = new THREE.Mesh(
      this.trackGeom(applyPlanarCapUVs(new THREE.CylinderGeometry(38, 42, 8, 12), 18)),
      padDeckMat
    );
    padSlab.position.y = -3.4;
    padSlab.receiveShadow = true;
    outpost.add(padSlab);

    // 3 Artemis-style pressurized cylindrical modules with landing struts & lit viewports
    const modGeom = this.trackGeom(new THREE.CylinderGeometry(3.8, 3.8, 16, 16));
    modGeom.rotateZ(Math.PI * 0.5);
    for (let i = 0; i < 3; i++) {
      const mz = -12 + i * 12;
      const mod = new THREE.Mesh(modGeom, whiteTankMat);
      mod.position.set(0, 4.6, mz);
      mod.castShadow = true;
      mod.receiveShadow = true;
      outpost.add(mod);

      const win = new THREE.Mesh(
        this.trackGeom(new THREE.BoxGeometry(5.5, 1.1, 7.8)),
        windowGlowMat
      );
      win.position.set(0, 4.9, mz);
      outpost.add(win);
    }

    // 4 Vertical Polar Solar-Array Towers (catching low-angle Shackleton sunlight)
    const mastGeom = this.trackGeom(new THREE.CylinderGeometry(0.35, 0.5, 22, 8));
    const wingGeom = this.trackGeom(new THREE.BoxGeometry(8.5, 14, 0.25));
    for (let i = 0; i < 4; i++) {
      const tx = -24 + i * 16;
      const tz = -26;
      const mast = new THREE.Mesh(mastGeom, brightSteelMat);
      mast.position.set(tx, 11, tz);
      const wing = new THREE.Mesh(wingGeom, goldSolarMat);
      wing.position.set(tx, 15, tz);
      outpost.add(mast, wing);
    }

    // Radiator fins & cryogenic depot
    const radGeom = this.trackGeom(new THREE.BoxGeometry(10, 5.5, 0.2));
    const rad = new THREE.Mesh(radGeom, brightSteelMat);
    rad.position.set(18, 4.5, 8);
    const depot = new THREE.Mesh(
      this.trackGeom(new THREE.CylinderGeometry(3.4, 3.4, 10, 16)),
      whiteTankMat
    );
    depot.position.set(-18, 5, 12);
    outpost.add(rad, depot);
    this.activeGroup.add(outpost);
  }

  private clearCurrent(): void {
    this.group.remove(this.activeGroup, this.orbitalStationHost);
    for (const item of this.disposables) {
      item.dispose();
    }
    this.disposables = [];
    disposeTextureSet(this.padTextures);
    this.padTextures = null;
    disposeTextureSet(this.padDeckTextures);
    this.padDeckTextures = null;
    this.qdArmPivot = null;
    this.catchCarriageGroup = null;
    this.chopstickLeftPivot = null;
    this.chopstickRightPivot = null;
    this.tulipArmPivots = [];
    this.orbitalAnim = null;
  }

  dispose(): void {
    this.clearCurrent();
  }
}
