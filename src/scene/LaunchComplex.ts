import * as THREE from "three";
import type { PlanetConfig } from "../config/planets";
import { SeededNoise2D, samplePlanetTerrainHeight } from "../utils/noise";
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
 * Builds and manages planet-specific launch pads, surface stations/outposts,
 * and orbiting space stations for Earth, Mars, and Moon.
 */
export class LaunchComplex {
  public readonly group = new THREE.Group();

  private activeGroup = new THREE.Group();
  private padTextures: PbrTextureSet | null = null;
  private disposables: Array<{ dispose(): void }> = [];

  private padDeckY = 2.2;
  private baseFocusTarget = new THREE.Vector3(0, 12, 0);

  private qdArmPivot: THREE.Group | null = null;
  private chopstickLeftPivot: THREE.Group | null = null;
  private chopstickRightPivot: THREE.Group | null = null;
  private orbitalAnim: OrbitalStationAnim | null = null;

  constructor(initialConfig: PlanetConfig, maxAnisotropy: number) {
    this.group.add(this.activeGroup);
    this.updatePlanet(initialConfig, maxAnisotropy);
  }

  getPadDeckY(): number {
    return this.padDeckY;
  }

  getBaseFocusTarget(): THREE.Vector3 {
    return this.baseFocusTarget.clone();
  }

  setUmbilicalRetracted(t: number): void {
    if (!this.qdArmPivot) {
      return;
    }
    const clamped = Math.max(0, Math.min(1, t));
    this.qdArmPivot.rotation.y = clamped * 1.18;
  }

  setCatchArmsOpen(open: number): void {
    if (!this.chopstickLeftPivot || !this.chopstickRightPivot) {
      return;
    }
    const clamped = Math.max(0, Math.min(1, open));
    const angle = 0.08 + clamped * 0.56;
    this.chopstickLeftPivot.rotation.y = angle;
    this.chopstickRightPivot.rotation.y = -angle;
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
    group.position.set(x, altitudeY, z);
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

  updatePlanet(config: PlanetConfig, maxAnisotropy: number): void {
    this.clearCurrent();

    this.activeGroup = new THREE.Group();
    this.group.add(this.activeGroup);

    const padTex = generatePadConcreteTextureSet(config, maxAnisotropy);
    this.padTextures = padTex;

    const concreteMat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      map: padTex.albedoMap,
      normalMap: padTex.normalMap,
      roughnessMap: padTex.roughnessMap,
      roughness: 0.84,
      metalness: 0.06,
    });
    const steelMat = new THREE.MeshStandardMaterial({
      color: "#4b5563",
      metalness: 0.82,
      roughness: 0.36,
    });
    const brightSteelMat = new THREE.MeshStandardMaterial({
      color: "#cbd5e1",
      metalness: 0.86,
      roughness: 0.24,
    });
    const whiteTankMat = new THREE.MeshStandardMaterial({
      color: "#f1f5f9",
      metalness: 0.18,
      roughness: 0.38,
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
      this.buildEarthStarbase(
        concreteMat,
        steelMat,
        brightSteelMat,
        whiteTankMat,
        goldSolarMat,
        beaconOrangeMat
      );
    } else if (config.id === "mars") {
      this.buildMarsSpaceport(
        config,
        concreteMat,
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
        concreteMat,
        steelMat,
        brightSteelMat,
        whiteTankMat,
        goldSolarMat,
        beaconOrangeMat,
        windowGlowMat
      );
    }
  }

  private trackGeom<T extends THREE.BufferGeometry>(geom: T): T {
    this.disposables.push(geom);
    return geom;
  }

  private buildEarthStarbase(
    concreteMat: THREE.MeshStandardMaterial,
    steelMat: THREE.MeshStandardMaterial,
    brightSteelMat: THREE.MeshStandardMaterial,
    whiteTankMat: THREE.MeshStandardMaterial,
    goldSolarMat: THREE.MeshStandardMaterial,
    beaconMat: THREE.MeshStandardMaterial
  ): void {
    this.padDeckY = 18.0;
    this.baseFocusTarget.set(16, 22, 0);

    // Concrete apron + flame deluge trench pit
    const apron = new THREE.Mesh(
      this.trackGeom(new THREE.CylinderGeometry(56, 60, 0.8, 48)),
      concreteMat
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
      this.trackGeom(new THREE.CylinderGeometry(11.4, 11.4, 1.0, 24)),
      steelMat
    );
    olmDeck.position.y = 17.5;
    olmDeck.castShadow = true;
    olmDeck.receiveShadow = true;
    this.activeGroup.add(olmDeck);

    // 6 heavy angled concrete/steel blast legs
    const legGeom = this.trackGeom(new THREE.CylinderGeometry(1.5, 2.3, 18.4, 12));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const leg = new THREE.Mesh(legGeom, concreteMat);
      leg.position.set(Math.cos(a) * 11.8, 8.6, Math.sin(a) * 11.8);
      leg.rotation.z = Math.cos(a) * 0.22;
      leg.rotation.x = -Math.sin(a) * 0.22;
      leg.castShadow = true;
      leg.receiveShadow = true;
      this.activeGroup.add(leg);
    }

    // 20 instanced hold-down clamps around OLM rim
    const clampGeom = this.trackGeom(new THREE.BoxGeometry(0.9, 1.4, 1.5));
    const clamps = new THREE.InstancedMesh(clampGeom, brightSteelMat, 20);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * 5.2, 18.4, Math.sin(a) * 5.2);
      dummy.rotation.set(0, -a, 0);
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
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const col = new THREE.Mesh(colGeom, steelMat);
        col.position.set(sx * towerHalf, towerH * 0.5, sz * towerHalf);
        col.castShadow = true;
        towerGroup.add(col);
      }
    }

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

    // Carriage & animated Chopstick Catch Arms
    const carriage = new THREE.Mesh(
      this.trackGeom(new THREE.BoxGeometry(11.4, 7.5, 11.4)),
      brightSteelMat
    );
    carriage.position.set(0, 108, 0);
    towerGroup.add(carriage);

    const armGeom = this.trackGeom(new THREE.BoxGeometry(24.0, 2.2, 1.4));
    this.chopstickLeftPivot = new THREE.Group();
    this.chopstickLeftPivot.position.set(5.2, 108, -4.6);
    const leftArm = new THREE.Mesh(armGeom, brightSteelMat);
    leftArm.position.set(12.0, 0, 0);
    leftArm.castShadow = true;
    this.chopstickLeftPivot.add(leftArm);

    this.chopstickRightPivot = new THREE.Group();
    this.chopstickRightPivot.position.set(5.2, 108, 4.6);
    const rightArm = new THREE.Mesh(armGeom, brightSteelMat);
    rightArm.position.set(12.0, 0, 0);
    rightArm.castShadow = true;
    this.chopstickRightPivot.add(rightArm);

    towerGroup.add(this.chopstickLeftPivot, this.chopstickRightPivot);
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
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const tx = col * 12;
        const tz = row * 14;
        const cyl = new THREE.Mesh(tankGeom, whiteTankMat);
        cyl.position.set(tx, 12, tz);
        cyl.castShadow = true;
        cyl.receiveShadow = true;
        const dome = new THREE.Mesh(tankDomeGeom, whiteTankMat);
        dome.position.set(tx, 24, tz);
        farmGroup.add(cyl, dome);
      }
    }
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

    // 4 Perimeter Stadium Floodlight Masts
    const mastPoleGeom = this.trackGeom(new THREE.CylinderGeometry(0.35, 0.55, 34, 8));
    const floodHeadGeom = this.trackGeom(new THREE.BoxGeometry(3.2, 1.4, 0.9));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
      const mx = Math.cos(a) * 51;
      const mz = Math.sin(a) * 51;
      const pole = new THREE.Mesh(mastPoleGeom, steelMat);
      pole.position.set(mx, 17, mz);
      const head = new THREE.Mesh(floodHeadGeom, beaconMat);
      head.position.set(mx, 34.2, mz);
      head.lookAt(0, 18, 0);
      this.activeGroup.add(pole, head);
    }

    // ISS-inspired LEO Orbital Space Station
    this.buildOrbitalStation("earth", brightSteelMat, goldSolarMat, whiteTankMat);
  }

  private buildMarsSpaceport(
    config: PlanetConfig,
    concreteMat: THREE.MeshStandardMaterial,
    steelMat: THREE.MeshStandardMaterial,
    brightSteelMat: THREE.MeshStandardMaterial,
    whiteTankMat: THREE.MeshStandardMaterial,
    solarMat: THREE.MeshStandardMaterial,
    beaconMat: THREE.MeshStandardMaterial,
    windowGlowMat: THREE.MeshStandardMaterial
  ): void {
    this.padDeckY = 2.2;
    this.baseFocusTarget.set(175, 10, -80);

    // Sintered-regolith octagonal blast deck + radial flame trenches
    const deck = new THREE.Mesh(
      this.trackGeom(new THREE.CylinderGeometry(42, 48, 2.2, 8)),
      concreteMat
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
      this.trackGeom(new THREE.CylinderGeometry(42, 46, 8, 12)),
      concreteMat
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

    // Mars Orbital Transfer Station
    this.buildOrbitalStation("mars", brightSteelMat, solarMat, whiteTankMat);
  }

  private buildMoonSpaceport(
    config: PlanetConfig,
    concreteMat: THREE.MeshStandardMaterial,
    steelMat: THREE.MeshStandardMaterial,
    brightSteelMat: THREE.MeshStandardMaterial,
    whiteTankMat: THREE.MeshStandardMaterial,
    goldSolarMat: THREE.MeshStandardMaterial,
    beaconMat: THREE.MeshStandardMaterial,
    windowGlowMat: THREE.MeshStandardMaterial
  ): void {
    this.padDeckY = 1.6;
    this.baseFocusTarget.set(-180, 10, -85);

    // Sintered lunar regolith landing pad
    const deck = new THREE.Mesh(
      this.trackGeom(new THREE.CylinderGeometry(40, 44, 1.6, 36)),
      concreteMat
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
      this.trackGeom(new THREE.CylinderGeometry(38, 42, 8, 12)),
      concreteMat
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

    // Lunar Gateway Orbital Space Station
    this.buildOrbitalStation("moon", brightSteelMat, goldSolarMat, whiteTankMat);
  }

  private buildOrbitalStation(
    planetId: "earth" | "mars" | "moon",
    trussMat: THREE.MeshStandardMaterial,
    solarMat: THREE.MeshStandardMaterial,
    habMat: THREE.MeshStandardMaterial
  ): void {
    const station = new THREE.Group();
    // Large visible scale at high sky altitude (~1350..1650m) so it clearly glides overhead
    const scale = planetId === "earth" ? 2.6 : 2.3;
    station.scale.setScalar(scale);

    // Main central truss
    const truss = new THREE.Mesh(
      this.trackGeom(new THREE.BoxGeometry(44, 1.6, 1.6)),
      trussMat
    );
    station.add(truss);

    // Pressurized habitation / docking spine
    const spine = new THREE.Mesh(
      this.trackGeom(new THREE.CylinderGeometry(2.1, 2.1, 20, 12)),
      habMat
    );
    spine.rotation.x = Math.PI * 0.5;
    station.add(spine);

    if (planetId === "mars") {
      // Mars Transfer Station centrifugal ring
      const ring = new THREE.Mesh(
        this.trackGeom(new THREE.TorusGeometry(9.5, 1.0, 10, 28)),
        habMat
      );
      station.add(ring);
    }

    // Instanced solar wings
    const wingGeom = this.trackGeom(new THREE.BoxGeometry(5.2, 0.16, 16.5));
    const wingCount = planetId === "earth" ? 8 : 4;
    const wings = new THREE.InstancedMesh(wingGeom, solarMat, wingCount);
    const dummy = new THREE.Object3D();
    let idx = 0;
    const xs = planetId === "earth" ? [-19, -13, 13, 19] : [-16, 16];
    for (const wx of xs) {
      for (const sz of [-1, 1]) {
        dummy.position.set(wx, 0, sz * 10.5);
        dummy.rotation.set(0.25, 0, 0);
        dummy.updateMatrix();
        wings.setMatrixAt(idx++, dummy.matrix);
      }
    }
    wings.instanceMatrix.needsUpdate = true;
    station.add(wings);

    // Navigation strobes (no shadow casting on distant orbital station)
    const strobeGeom = this.trackGeom(new THREE.SphereGeometry(0.9, 8, 8));
    const strobeMatRed = new THREE.MeshStandardMaterial({
      color: "#fecaca",
      emissive: "#ef4444",
      emissiveIntensity: 2.0,
    });
    const strobeMatWhite = new THREE.MeshStandardMaterial({
      color: "#f8fafc",
      emissive: "#e0f2fe",
      emissiveIntensity: 2.0,
    });
    this.disposables.push(strobeMatRed, strobeMatWhite);

    const s1 = new THREE.Mesh(strobeGeom, strobeMatRed);
    s1.position.set(-22, 1.8, 0);
    const s2 = new THREE.Mesh(strobeGeom, strobeMatWhite);
    s2.position.set(22, 1.8, 0);
    station.add(s1, s2);

    this.activeGroup.add(station);
    this.orbitalAnim = {
      group: station,
      strobes: [s1, s2],
      radiusX: planetId === "earth" ? 1550 : 1450,
      radiusZ: planetId === "earth" ? 1200 : 1150,
      altitudeY: planetId === "earth" ? 1320 : 1180,
      angularSpeed: 0.028,
      phaseOffset: planetId === "mars" ? 0.55 : planetId === "earth" ? 0.85 : 0.4,
    };
    this.update(0);
  }

  private clearCurrent(): void {
    this.group.remove(this.activeGroup);
    for (const item of this.disposables) {
      item.dispose();
    }
    this.disposables = [];
    disposeTextureSet(this.padTextures);
    this.padTextures = null;
    this.qdArmPivot = null;
    this.chopstickLeftPivot = null;
    this.chopstickRightPivot = null;
    this.orbitalAnim = null;
  }

  dispose(): void {
    this.clearCurrent();
  }
}
