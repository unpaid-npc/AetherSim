import * as THREE from "three";
import {
  getCryoFrostTexture,
  getHeatShieldTextureSet,
  getStainlessSteelTextureSet,
} from "./ProceduralTextures";

export interface NozzleTransform {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  radius: number;
  throttle: number;
  kind: "booster" | "ship_sl" | "ship_vac";
}

const RADIUS = 4.5;
const BOOSTER_HEIGHT = 71.0;
const SHIP_BODY_HEIGHT = 33.0;
const SHIP_NOSE_HEIGHT = 17.0;

/**
 * Procedural 1:1 scale SpaceX Starship (50m) + Super Heavy Booster (71m) assembly.
 *
 * ``root`` origin (0, 0, 0) corresponds to the touchdown contact plane of the
 * active configuration (Super Heavy skirt in ``launch`` mode; Starship aft skirt /
 * deployed footpads in ``landing`` mode).
 */
export class StarshipVehicle {
  public readonly root = new THREE.Group();
  public readonly detachedBoosterRoot = new THREE.Group();

  private readonly boosterGroup = new THREE.Group();
  private readonly shipGroup = new THREE.Group();

  private readonly gridFinPivots: Array<{
    pivot: THREE.Group;
    axis: "x" | "z";
    sign: number;
  }> = [];

  private readonly forwardFlapPivots: Array<{ pivot: THREE.Group; side: -1 | 1 }> = [];
  private readonly aftFlapPivots: Array<{ pivot: THREE.Group; side: -1 | 1 }> = [];
  private readonly legAssemblies: Array<{
    pivot: THREE.Group;
    footPivot: THREE.Group;
    angle: number;
  }> = [];

  private readonly boosterGimbalGroup = new THREE.Group();
  private readonly shipGimbalGroup = new THREE.Group();

  private readonly boosterFrostMat: THREE.MeshStandardMaterial;
  private readonly shipFrostMat: THREE.MeshStandardMaterial;
  private readonly boosterGlowMat: THREE.MeshBasicMaterial;
  private readonly shipGlowMat: THREE.MeshBasicMaterial;
  private readonly boosterPlumeLight: THREE.PointLight;
  private readonly shipPlumeLight: THREE.PointLight;

  private readonly boosterGlowMeshes: THREE.Mesh[] = [];
  private readonly shipGlowMeshes: THREE.Mesh[] = [];

  private readonly boosterLocalNozzles: Array<{
    pos: THREE.Vector3;
    gimbals: boolean;
    radius: number;
  }> = [];
  private readonly shipLocalNozzles: Array<{
    pos: THREE.Vector3;
    gimbals: boolean;
    radius: number;
    kind: "ship_sl" | "ship_vac";
  }> = [];

  private readonly disposables: Array<{ dispose(): void }> = [];
  private mode: "launch" | "landing" = "launch";
  private separated = false;
  private boosterThrottle = 0;
  private shipThrottle = 0;

  constructor(maxAnisotropy: number) {
    this.root.rotation.order = "YXZ";
    this.detachedBoosterRoot.rotation.order = "YXZ";
    this.detachedBoosterRoot.visible = false;

    const steelTex = getStainlessSteelTextureSet(maxAnisotropy);
    const tpsTex = getHeatShieldTextureSet(maxAnisotropy);
    const frostTex = getCryoFrostTexture(maxAnisotropy);

    const steelMat = new THREE.MeshStandardMaterial({
      color: "#eef2f6",
      map: steelTex.albedoMap,
      normalMap: steelTex.normalMap,
      roughnessMap: steelTex.roughnessMap,
      metalness: 0.9,
      roughness: 0.28,
    });
    const darkSteelMat = new THREE.MeshStandardMaterial({
      color: "#525864",
      metalness: 0.86,
      roughness: 0.42,
    });
    const tpsMat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      map: tpsTex.albedoMap,
      normalMap: tpsTex.normalMap,
      roughnessMap: tpsTex.roughnessMap,
      metalness: 0.16,
      roughness: 0.88,
    });
    const nozzleMat = new THREE.MeshStandardMaterial({
      color: "#2b303a",
      metalness: 0.88,
      roughness: 0.34,
    });

    this.boosterFrostMat = new THREE.MeshStandardMaterial({
      color: "#f0f7ff",
      map: frostTex,
      transparent: true,
      opacity: 0.85,
      roughness: 0.72,
      metalness: 0.05,
      depthWrite: false,
    });
    this.shipFrostMat = this.boosterFrostMat.clone();

    this.boosterGlowMat = new THREE.MeshBasicMaterial({
      color: "#ff9b42",
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.shipGlowMat = new THREE.MeshBasicMaterial({
      color: "#a8d8ff",
      transparent: true,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.boosterPlumeLight = new THREE.PointLight("#ff8a3d", 0, 140, 1.5);
    this.boosterPlumeLight.position.set(0, -3.5, 0);
    this.boosterGroup.add(this.boosterPlumeLight);

    this.shipPlumeLight = new THREE.PointLight("#8ecaff", 0, 110, 1.5);
    this.shipPlumeLight.position.set(0, -2.5, 0);
    this.shipGroup.add(this.shipPlumeLight);

    this.disposables.push(
      steelMat,
      darkSteelMat,
      tpsMat,
      nozzleMat,
      this.boosterFrostMat,
      this.shipFrostMat,
      this.boosterGlowMat,
      this.shipGlowMat
    );

    this.buildSuperHeavyBooster(steelMat, darkSteelMat, nozzleMat);
    this.buildStarshipUpperStage(steelMat, darkSteelMat, tpsMat, nozzleMat);

    this.root.add(this.boosterGroup, this.shipGroup);
    this.configureMode("launch");
  }

  private buildSuperHeavyBooster(
    steelMat: THREE.MeshStandardMaterial,
    darkSteelMat: THREE.MeshStandardMaterial,
    nozzleMat: THREE.MeshStandardMaterial
  ): void {
    // Main booster stainless cylinder (y = 1.6..68.0, leaving room for engine skirt and interstage)
    const hullHeight = 66.4;
    const hullGeom = new THREE.CylinderGeometry(RADIUS, RADIUS, hullHeight, 40, 1);
    const hullMesh = new THREE.Mesh(hullGeom, steelMat);
    hullMesh.position.y = 1.6 + hullHeight * 0.5;
    hullMesh.castShadow = true;
    hullMesh.receiveShadow = true;
    this.boosterGroup.add(hullMesh);
    this.disposables.push(hullGeom);

    // Aft engine skirt flare
    const skirtGeom = new THREE.CylinderGeometry(RADIUS, RADIUS + 0.28, 2.2, 36);
    const skirtMesh = new THREE.Mesh(skirtGeom, darkSteelMat);
    skirtMesh.position.y = 1.1;
    skirtMesh.castShadow = true;
    this.boosterGroup.add(skirtMesh);
    this.disposables.push(skirtGeom);

    // Vertical aerodynamic raceway chines on sides
    const chineGeom = new THREE.BoxGeometry(0.45, 58.0, 0.35);
    this.disposables.push(chineGeom);
    for (const side of [-1, 1]) {
      const chine = new THREE.Mesh(chineGeom, darkSteelMat);
      chine.position.set(side * (RADIUS + 0.08), 34.0, 0);
      this.boosterGroup.add(chine);
    }

    // Dynamic cryogenic frost sleeve over booster LOX/CH4 tanks
    const frostGeom = new THREE.CylinderGeometry(RADIUS + 0.035, RADIUS + 0.035, 42.0, 32, 1, true);
    const frostMesh = new THREE.Mesh(frostGeom, this.boosterFrostMat);
    frostMesh.position.y = 33.0;
    this.boosterGroup.add(frostMesh);
    this.disposables.push(frostGeom);

    // Vented Hot-Staging Interstage Ring (y = 68.0 .. 71.0)
    const ringGeom = new THREE.CylinderGeometry(RADIUS + 0.02, RADIUS + 0.02, 0.42, 36);
    const botRing = new THREE.Mesh(ringGeom, darkSteelMat);
    botRing.position.y = 68.2;
    const topRing = new THREE.Mesh(ringGeom, darkSteelMat);
    topRing.position.y = 70.79;
    this.boosterGroup.add(botRing, topRing);
    this.disposables.push(ringGeom);

    // 24 instanced hot-staging vent struts
    const strutGeom = new THREE.BoxGeometry(0.2, 2.35, 0.24);
    const struts = new THREE.InstancedMesh(strutGeom, darkSteelMat, 24);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * (RADIUS - 0.14), 69.5, Math.sin(a) * (RADIUS - 0.14));
      dummy.rotation.set(0, -a, 0);
      dummy.updateMatrix();
      struts.setMatrixAt(i, dummy.matrix);
    }
    struts.instanceMatrix.needsUpdate = true;
    this.boosterGroup.add(struts);
    this.disposables.push(strutGeom);

    // 4 Actuated Waffle Grid Fins at top of booster (y = 65.5)
    const finFrameGeom = new THREE.BoxGeometry(2.7, 0.28, 3.6);
    const finRibGeom = new THREE.BoxGeometry(2.5, 0.34, 0.08);
    this.disposables.push(finFrameGeom, finRibGeom);

    const finSpecs: Array<{ angle: number; axis: "x" | "z"; sign: number }> = [
      { angle: Math.PI * 0.25, axis: "x", sign: 1 },
      { angle: Math.PI * 0.75, axis: "x", sign: -1 },
      { angle: Math.PI * 1.25, axis: "z", sign: -1 },
      { angle: Math.PI * 1.75, axis: "z", sign: 1 },
    ];
    for (const spec of finSpecs) {
      const mount = new THREE.Group();
      mount.position.set(Math.cos(spec.angle) * RADIUS, 65.4, Math.sin(spec.angle) * RADIUS);
      mount.rotation.y = -spec.angle + Math.PI * 0.5;

      const pivot = new THREE.Group();
      const finBase = new THREE.Mesh(finFrameGeom, darkSteelMat);
      finBase.position.set(0, 0, 1.9);
      finBase.castShadow = true;
      pivot.add(finBase);

      for (let r = 0; r < 5; r++) {
        const rib = new THREE.Mesh(finRibGeom, steelMat);
        rib.position.set(0, 0, 0.5 + r * 0.72);
        pivot.add(rib);
      }

      mount.add(pivot);
      this.boosterGroup.add(mount);
      this.gridFinPivots.push({ pivot, axis: spec.axis, sign: spec.sign });
    }

    // 33-Raptor Nozzle Cluster: 20 outer + 10 middle (InstancedMesh) + 3 gimbaling center
    const bellGeom = new THREE.CylinderGeometry(0.32, 0.62, 1.4, 14, 1, true);
    const glowConeGeom = new THREE.ConeGeometry(0.65, 5.2, 14, 1, true);
    glowConeGeom.translate(0, -2.6, 0);
    glowConeGeom.rotateX(Math.PI);
    this.disposables.push(bellGeom, glowConeGeom);

    const outerAndMid = new THREE.InstancedMesh(bellGeom, nozzleMat, 30);
    let idx = 0;
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const px = Math.cos(a) * 3.65;
      const pz = Math.sin(a) * 3.65;
      dummy.position.set(px, 0.72, pz);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      outerAndMid.setMatrixAt(idx++, dummy.matrix);
      this.boosterLocalNozzles.push({
        pos: new THREE.Vector3(px, 0.02, pz),
        gimbals: false,
        radius: 0.62,
      });
    }
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.15;
      const px = Math.cos(a) * 2.25;
      const pz = Math.sin(a) * 2.25;
      dummy.position.set(px, 0.72, pz);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      outerAndMid.setMatrixAt(idx++, dummy.matrix);
      this.boosterLocalNozzles.push({
        pos: new THREE.Vector3(px, 0.02, pz),
        gimbals: false,
        radius: 0.62,
      });
    }
    outerAndMid.instanceMatrix.needsUpdate = true;
    this.boosterGroup.add(outerAndMid);

    // Inner 3 gimbaling Raptor cluster + lightweight glow cones
    this.boosterGimbalGroup.position.set(0, 1.1, 0);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const px = Math.cos(a) * 0.85;
      const pz = Math.sin(a) * 0.85;
      const bell = new THREE.Mesh(bellGeom, nozzleMat);
      bell.position.set(px, -0.38, pz);
      this.boosterGimbalGroup.add(bell);

      const glow = new THREE.Mesh(glowConeGeom, this.boosterGlowMat);
      glow.position.set(px, -1.05, pz);
      this.boosterGimbalGroup.add(glow);
      this.boosterGlowMeshes.push(glow);

      this.boosterLocalNozzles.push({
        pos: new THREE.Vector3(px, 0.02, pz),
        gimbals: true,
        radius: 0.62,
      });
    }
    // Additional ring glow cones on 6 cardinal outer engines for vivid ignition feedback
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const glow = new THREE.Mesh(glowConeGeom, this.boosterGlowMat);
      glow.position.set(Math.cos(a) * 3.55, 0.02, Math.sin(a) * 3.55);
      this.boosterGroup.add(glow);
      this.boosterGlowMeshes.push(glow);
    }
    this.boosterGroup.add(this.boosterGimbalGroup);
  }

  private buildStarshipUpperStage(
    steelMat: THREE.MeshStandardMaterial,
    darkSteelMat: THREE.MeshStandardMaterial,
    tpsMat: THREE.MeshStandardMaterial,
    nozzleMat: THREE.MeshStandardMaterial
  ): void {
    // Split cylindrical hull (y = 0..SHIP_BODY_HEIGHT):
    // Windward (+Z -> theta = -PI/2..+PI/2 in Three CylinderGeometry) = Hexagonal TPS
    // Leeward (-Z) = Brushed Stainless Steel
    const tpsCylGeom = new THREE.CylinderGeometry(
      RADIUS,
      RADIUS,
      SHIP_BODY_HEIGHT,
      28,
      1,
      false,
      -Math.PI * 0.5,
      Math.PI
    );
    const tpsCyl = new THREE.Mesh(tpsCylGeom, tpsMat);
    tpsCyl.position.y = SHIP_BODY_HEIGHT * 0.5;
    tpsCyl.castShadow = true;
    tpsCyl.receiveShadow = true;

    const steelCylGeom = new THREE.CylinderGeometry(
      RADIUS,
      RADIUS,
      SHIP_BODY_HEIGHT,
      28,
      1,
      false,
      Math.PI * 0.5,
      Math.PI
    );
    const steelCyl = new THREE.Mesh(steelCylGeom, steelMat);
    steelCyl.position.y = SHIP_BODY_HEIGHT * 0.5;
    steelCyl.castShadow = true;
    steelCyl.receiveShadow = true;
    this.shipGroup.add(tpsCyl, steelCyl);
    this.disposables.push(tpsCylGeom, steelCylGeom);

    // Smooth ogive nosecone (y = 33..50) split into TPS windward and Steel leeward halves
    const ogivePts: THREE.Vector2[] = [];
    const steps = 16;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = t * SHIP_NOSE_HEIGHT;
      // Tangent-ogive profile tapering smoothly to rounded tip
      const r = Math.max(0.08, RADIUS * Math.pow(Math.cos(t * Math.PI * 0.5), 0.72));
      ogivePts.push(new THREE.Vector2(r, y));
    }

    const tpsNoseGeom = new THREE.LatheGeometry(ogivePts, 24, -Math.PI * 0.5, Math.PI);
    const tpsNose = new THREE.Mesh(tpsNoseGeom, tpsMat);
    tpsNose.position.y = SHIP_BODY_HEIGHT;
    tpsNose.castShadow = true;

    const steelNoseGeom = new THREE.LatheGeometry(ogivePts, 24, Math.PI * 0.5, Math.PI);
    const steelNose = new THREE.Mesh(steelNoseGeom, steelMat);
    steelNose.position.y = SHIP_BODY_HEIGHT;
    steelNose.castShadow = true;
    this.shipGroup.add(tpsNose, steelNose);
    this.disposables.push(tpsNoseGeom, steelNoseGeom);

    // Leeward cryo frost band
    const shipFrostGeom = new THREE.CylinderGeometry(
      RADIUS + 0.035,
      RADIUS + 0.035,
      20.0,
      24,
      1,
      true,
      Math.PI * 0.55,
      Math.PI * 0.9
    );
    const shipFrost = new THREE.Mesh(shipFrostGeom, this.shipFrostMat);
    shipFrost.position.y = 16.5;
    this.shipGroup.add(shipFrost);
    this.disposables.push(shipFrostGeom);

    // 2 Forward Flaps (y = 37.5)
    const fwdShape = new THREE.Shape();
    fwdShape.moveTo(0, -2.5);
    fwdShape.lineTo(2.4, -1.6);
    fwdShape.lineTo(1.7, 3.0);
    fwdShape.lineTo(0, 3.4);
    fwdShape.closePath();
    const fwdGeom = new THREE.ExtrudeGeometry(fwdShape, {
      depth: 0.24,
      bevelEnabled: true,
      bevelSize: 0.05,
      bevelThickness: 0.05,
      bevelSegments: 2,
    });
    fwdGeom.translate(0, 0, -0.12);
    this.disposables.push(fwdGeom);

    for (const side of [-1, 1] as const) {
      const mount = new THREE.Group();
      mount.position.set(side * 3.1, 38.0, 0.2);
      const pivot = new THREE.Group();
      const mesh = new THREE.Mesh(fwdGeom, tpsMat);
      if (side === -1) {
        mesh.scale.x = -1;
      }
      mesh.castShadow = true;
      pivot.add(mesh);
      mount.add(pivot);
      this.shipGroup.add(mount);
      this.forwardFlapPivots.push({ pivot, side });
    }

    // 2 Aft Flaps (y = 7.5)
    const aftShape = new THREE.Shape();
    aftShape.moveTo(0, -5.0);
    aftShape.lineTo(3.6, -4.4);
    aftShape.lineTo(2.6, 4.6);
    aftShape.lineTo(0, 5.2);
    aftShape.closePath();
    const aftGeom = new THREE.ExtrudeGeometry(aftShape, {
      depth: 0.28,
      bevelEnabled: true,
      bevelSize: 0.06,
      bevelThickness: 0.06,
      bevelSegments: 2,
    });
    aftGeom.translate(0, 0, -0.14);
    this.disposables.push(aftGeom);

    for (const side of [-1, 1] as const) {
      const mount = new THREE.Group();
      mount.position.set(side * (RADIUS - 0.15), 7.8, 0.25);
      const pivot = new THREE.Group();
      const mesh = new THREE.Mesh(aftGeom, tpsMat);
      if (side === -1) {
        mesh.scale.x = -1;
      }
      mesh.castShadow = true;
      pivot.add(mesh);
      mount.add(pivot);
      this.shipGroup.add(mount);
      this.aftFlapPivots.push({ pivot, side });
    }

    // 6-Raptor Aft Bay (3 large Vacuum Raptors + 3 gimbaling Sea-Level Raptors)
    const vacBellGeom = new THREE.CylinderGeometry(0.45, 1.15, 2.3, 16, 1, true);
    const slBellGeom = new THREE.CylinderGeometry(0.3, 0.62, 1.4, 14, 1, true);
    const shipGlowGeom = new THREE.ConeGeometry(0.85, 5.8, 14, 1, true);
    shipGlowGeom.translate(0, -2.9, 0);
    shipGlowGeom.rotateX(Math.PI);
    this.disposables.push(vacBellGeom, slBellGeom, shipGlowGeom);

    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const px = Math.cos(a) * 2.55;
      const pz = Math.sin(a) * 2.55;
      const vac = new THREE.Mesh(vacBellGeom, nozzleMat);
      vac.position.set(px, 0.9, pz);
      this.shipGroup.add(vac);

      const glow = new THREE.Mesh(shipGlowGeom, this.shipGlowMat);
      glow.position.set(px, -0.25, pz);
      this.shipGroup.add(glow);
      this.shipGlowMeshes.push(glow);

      this.shipLocalNozzles.push({
        pos: new THREE.Vector3(px, -0.25, pz),
        gimbals: false,
        radius: 1.15,
        kind: "ship_vac",
      });
    }

    this.shipGimbalGroup.position.set(0, 1.2, 0);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 - Math.PI / 6;
      const px = Math.cos(a) * 0.92;
      const pz = Math.sin(a) * 0.92;
      const sl = new THREE.Mesh(slBellGeom, nozzleMat);
      sl.position.set(px, -0.45, pz);
      this.shipGimbalGroup.add(sl);

      const glow = new THREE.Mesh(shipGlowGeom, this.shipGlowMat);
      glow.scale.set(0.75, 0.85, 0.75);
      glow.position.set(px, -1.15, pz);
      this.shipGimbalGroup.add(glow);
      this.shipGlowMeshes.push(glow);

      this.shipLocalNozzles.push({
        pos: new THREE.Vector3(px, -0.25, pz),
        gimbals: true,
        radius: 0.62,
        kind: "ship_sl",
      });
    }
    this.shipGroup.add(this.shipGimbalGroup);

    // 4 Deployable Landing Legs (pivoted inside lower skirt; deployed footpad touches y=0)
    const legStrutGeom = new THREE.BoxGeometry(0.32, 4.6, 0.42);
    const padGeom = new THREE.CylinderGeometry(0.65, 0.82, 0.28, 12);
    this.disposables.push(legStrutGeom, padGeom);

    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const mount = new THREE.Group();
      mount.position.set(Math.cos(angle) * (RADIUS - 0.15), 3.1, Math.sin(angle) * (RADIUS - 0.15));
      mount.rotation.y = -angle;

      const pivot = new THREE.Group();
      const strut = new THREE.Mesh(legStrutGeom, darkSteelMat);
      strut.position.set(0, -2.15, 0);
      strut.castShadow = true;
      pivot.add(strut);

      const footPivot = new THREE.Group();
      footPivot.position.set(0, -4.3, 0);
      const footPad = new THREE.Mesh(padGeom, darkSteelMat);
      footPivot.add(footPad);
      pivot.add(footPivot);

      mount.add(pivot);
      this.shipGroup.add(mount);
      this.legAssemblies.push({ pivot, footPivot, angle });
    }
  }

  configureMode(mode: "launch" | "landing"): void {
    this.mode = mode;
    this.separated = false;
    this.detachedBoosterRoot.visible = false;

    if (mode === "launch") {
      if (this.boosterGroup.parent !== this.root) {
        this.root.add(this.boosterGroup);
      }
      this.boosterGroup.visible = true;
      this.boosterGroup.position.set(0, 0, 0);
      this.boosterGroup.rotation.set(0, 0, 0);

      this.shipGroup.visible = true;
      this.shipGroup.position.set(0, BOOSTER_HEIGHT, 0);
      this.setLandingLegsDeployed(0.0);
    } else {
      this.boosterGroup.visible = false;
      this.shipGroup.visible = true;
      this.shipGroup.position.set(0, 0, 0);
    }
  }

  resetStack(mode: "launch" | "landing"): void {
    this.configureMode(mode);
    this.setFrostLevel(mode === "launch" ? 1.0 : 0.25);
    this.setFlapAngle(mode === "launch" ? 0.05 : 0.85);
    this.setGridFinDeflection(0, 0);
    this.setEngineVisualState(0, 0, 0, 0);
  }

  triggerStageSeparation(
    worldPos: THREE.Vector3,
    pitch: number,
    yaw: number,
    roll: number
  ): void {
    if (this.separated || this.mode !== "launch") {
      return;
    }
    this.separated = true;
    this.detachedBoosterRoot.add(this.boosterGroup);
    this.detachedBoosterRoot.visible = true;
    this.detachedBoosterRoot.position.copy(worldPos);
    this.detachedBoosterRoot.rotation.set(roll, yaw, -pitch);
    this.shipGroup.position.set(0, 0, 0);
  }

  setFrostLevel(level: number): void {
    const clamped = Math.max(0, Math.min(1, level));
    this.boosterFrostMat.opacity = clamped * 0.86;
    this.shipFrostMat.opacity = clamped * 0.82;
  }

  setFlapAngle(angleRad: number): void {
    const a = Math.max(-0.2, Math.min(1.35, angleRad));
    for (const item of this.forwardFlapPivots) {
      item.pivot.rotation.y = item.side * a * 0.72;
    }
    for (const item of this.aftFlapPivots) {
      item.pivot.rotation.y = item.side * a * 0.85;
    }
  }

  setGridFinDeflection(pitch: number, yaw: number): void {
    for (const item of this.gridFinPivots) {
      const cmd = item.axis === "x" ? pitch : yaw;
      item.pivot.rotation.z = item.sign * cmd * 0.65;
    }
  }

  setLandingLegsDeployed(deploy: number): void {
    const d = Math.max(0, Math.min(1, deploy));
    const swingAngle = d * 0.78;
    for (const leg of this.legAssemblies) {
      // Swing outward along local +X (radial direction)
      leg.pivot.rotation.z = swingAngle;
      leg.footPivot.rotation.z = -swingAngle;
    }
  }

  setIntactVisible(visible: boolean): void {
    this.root.visible = visible;
    if (!visible) {
      this.boosterPlumeLight.intensity = 0;
      this.shipPlumeLight.intensity = 0;
    }
  }

  getBoosterPlumeAnchor(): THREE.Group {
    return this.boosterGroup;
  }

  getShipPlumeAnchor(): THREE.Group {
    return this.shipGimbalGroup;
  }

  getRcsAnchorGroup(): THREE.Group {
    return this.shipGroup;
  }

  setEngineVisualState(
    boosterThrottle: number,
    shipThrottle: number,
    gimbalX: number,
    gimbalZ: number
  ): void {
    this.boosterThrottle = Math.max(0, Math.min(1, boosterThrottle));
    this.shipThrottle = Math.max(0, Math.min(1, shipThrottle));

    this.boosterGimbalGroup.rotation.set(gimbalZ * 0.55, 0, -gimbalX * 0.55);
    this.shipGimbalGroup.rotation.set(gimbalZ * 0.65, 0, -gimbalX * 0.65);

    const bVis = this.boosterThrottle > 0.02 && this.boosterGroup.visible && !this.separated;
    this.boosterGlowMat.opacity = 0;
    this.boosterPlumeLight.intensity = bVis ? 14.0 + this.boosterThrottle * 32.0 : 0;
    for (const glow of this.boosterGlowMeshes) {
      glow.visible = false;
    }

    const sVis = this.shipThrottle > 0.02 && this.shipGroup.visible;
    this.shipGlowMat.opacity = 0;
    this.shipPlumeLight.intensity = sVis ? 10.0 + this.shipThrottle * 24.0 : 0;
    for (const glow of this.shipGlowMeshes) {
      glow.visible = false;
    }
  }

  /** Returns active nozzle world transforms ready for Stage 3 shader exhaust plumes. */
  getActiveNozzleTransforms(): NozzleTransform[] {
    const out: NozzleTransform[] = [];
    this.root.updateMatrixWorld(true);
    const downDir = new THREE.Vector3(0, -1, 0);

    if (this.boosterThrottle > 0.02 && this.boosterGroup.visible && !this.separated) {
      const quat = new THREE.Quaternion();
      this.boosterGroup.getWorldQuaternion(quat);
      const dir = downDir.clone().applyQuaternion(quat).normalize();
      for (const n of this.boosterLocalNozzles) {
        const worldPos = n.pos.clone();
        this.boosterGroup.localToWorld(worldPos);
        out.push({
          position: worldPos,
          direction: dir.clone(),
          radius: n.radius,
          throttle: this.boosterThrottle,
          kind: "booster",
        });
      }
    }

    if (this.shipThrottle > 0.02 && this.shipGroup.visible) {
      const quat = new THREE.Quaternion();
      this.shipGroup.getWorldQuaternion(quat);
      const dir = downDir.clone().applyQuaternion(quat).normalize();
      for (const n of this.shipLocalNozzles) {
        const worldPos = n.pos.clone();
        this.shipGroup.localToWorld(worldPos);
        out.push({
          position: worldPos,
          direction: dir.clone(),
          radius: n.radius,
          throttle: this.shipThrottle,
          kind: n.kind,
        });
      }
    }

    return out;
  }

  getActiveNozzleWorldPositions(): THREE.Vector3[] {
    return this.getActiveNozzleTransforms().map((n) => n.position);
  }

  dispose(): void {
    for (const item of this.disposables) {
      item.dispose();
    }
    this.disposables.length = 0;
  }
}
