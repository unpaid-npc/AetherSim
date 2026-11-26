import * as THREE from "three";
import type { PlumeStyle, VehicleId } from "../config/vehicles";
import {
  getCryoFrostTexture,
  getHeatShieldTextureSet,
  getStainlessSteelTextureSet,
} from "./ProceduralTextures";

export interface NozzleSocketSpec {
  readonly pos: THREE.Vector3;
  readonly gimbals: boolean;
  readonly radius: number;
  readonly kind: "booster" | "ship_sl" | "ship_vac";
  readonly plumeScale: number;
}

export interface SideBoosterMountSpec {
  readonly localPos: THREE.Vector3;
  readonly cantZ: number;
  readonly plumeScale: number;
}

export interface BuiltVehicleAssembly {
  readonly disposables: Array<{ dispose(): void }>;
  readonly boosterLocalNozzles: NozzleSocketSpec[];
  readonly shipLocalNozzles: NozzleSocketSpec[];
  readonly sideBoosterMounts: SideBoosterMountSpec[];
  readonly boosterPlumeStyle: PlumeStyle;
  readonly shipPlumeStyle: PlumeStyle;
  readonly sidePlumeStyle: PlumeStyle;
  readonly gridFinPivots: Array<{ pivot: THREE.Group; axis: "x" | "z"; sign: number }>;
  readonly forwardFlapPivots: Array<{ pivot: THREE.Group; side: -1 | 1 }>;
  readonly aftFlapPivots: Array<{ pivot: THREE.Group; side: -1 | 1 }>;
  readonly shipLegAssemblies: Array<{ pivot: THREE.Group; footPivot: THREE.Group }>;
  readonly boosterLegAssemblies: Array<{ pivot: THREE.Group; footPivot: THREE.Group }>;
  readonly boosterFrostMat: THREE.MeshStandardMaterial | null;
  readonly shipFrostMat: THREE.MeshStandardMaterial | null;
  readonly boosterPlumeLight: THREE.PointLight;
  readonly shipPlumeLight: THREE.PointLight;
}

function createSaturnRollTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#e6ebf0";
  ctx.fillRect(0, 0, w, h);

  // Iconic Saturn V S-IC black vertical roll-pattern stripes on white hull
  ctx.fillStyle = "#161a22";
  // Bottom black fairing skirt band
  ctx.fillRect(0, h * 0.78, w, h * 0.22);
  // Alternating vertical roll-pattern panels in lower S-IC thrust/LOX zone
  for (let i = 0; i < 4; i++) {
    if (i % 2 === 0) {
      ctx.fillRect((i / 4) * w, h * 0.48, w / 4, h * 0.30);
    }
  }
  // Upper forward intertank black ring & small roll tabs
  ctx.fillRect(0, h * 0.06, w, h * 0.08);
  for (let i = 0; i < 4; i++) {
    if (i % 2 === 1) {
      ctx.fillRect((i / 4) * w, h * 0.14, w / 4, h * 0.08);
    }
  }
  // Crisp red NASA/USA accent block
  ctx.fillStyle = "#c83228";
  ctx.fillRect(w * 0.10, h * 0.26, 22, 76);
  ctx.fillRect(w * 0.60, h * 0.26, 22, 76);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

function createLvm3FairingTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#e2e8f0";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#f97316";
  ctx.fillRect(0, h * 0.62, w, 12);
  ctx.fillStyle = "#16a34a";
  ctx.fillRect(0, h * 0.70, w, 12);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, h * 0.90, w, 18);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Builds procedural PBR 3D geometry & nozzle sockets for Starship, Falcon 9, LVM3, or Saturn V. */
export function buildRocketFleetAssembly(
  vehicleId: VehicleId,
  maxAnisotropy: number,
  boosterGroup: THREE.Group,
  shipGroup: THREE.Group,
  leftSideGroup: THREE.Group,
  rightSideGroup: THREE.Group,
  boosterGimbalGroup: THREE.Group,
  shipGimbalGroup: THREE.Group
): BuiltVehicleAssembly {
  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const steelTex = getStainlessSteelTextureSet(maxAnisotropy);
  const tpsTex = getHeatShieldTextureSet(maxAnisotropy);
  const frostTex = getCryoFrostTexture(maxAnisotropy);

  const steelMat = track(
    new THREE.MeshStandardMaterial({
      color: "#eef2f6",
      map: steelTex.albedoMap,
      normalMap: steelTex.normalMap,
      roughnessMap: steelTex.roughnessMap,
      metalness: 0.9,
      roughness: 0.28,
    })
  );
  const matteWhiteMat = track(
    new THREE.MeshStandardMaterial({
      color: "#d6dce4",
      normalMap: steelTex.normalMap,
      roughness: 0.52,
      metalness: 0.14,
    })
  );
  const carbonMat = track(
    new THREE.MeshStandardMaterial({
      color: "#222730",
      metalness: 0.35,
      roughness: 0.62,
    })
  );
  const darkSteelMat = track(
    new THREE.MeshStandardMaterial({
      color: "#525864",
      metalness: 0.86,
      roughness: 0.42,
    })
  );
  const tpsMat = track(
    new THREE.MeshStandardMaterial({
      color: "#ffffff",
      map: tpsTex.albedoMap,
      normalMap: tpsTex.normalMap,
      roughnessMap: tpsTex.roughnessMap,
      metalness: 0.16,
      roughness: 0.88,
    })
  );
  const nozzleMat = track(
    new THREE.MeshStandardMaterial({
      color: "#2b303a",
      metalness: 0.88,
      roughness: 0.34,
    })
  );
  const boosterFrostMat = track(
    new THREE.MeshStandardMaterial({
      color: "#f0f7ff",
      map: frostTex,
      transparent: true,
      opacity: 0.85,
      roughness: 0.72,
      metalness: 0.05,
      depthWrite: false,
    })
  );
  const shipFrostMat = track(boosterFrostMat.clone());

  const boosterPlumeLight = new THREE.PointLight("#ff8a3d", 0, 140, 1.5);
  boosterPlumeLight.position.set(0, -3.5, 0);
  boosterGroup.add(boosterPlumeLight);

  const shipPlumeLight = new THREE.PointLight("#8ecaff", 0, 110, 1.5);
  shipPlumeLight.position.set(0, -2.5, 0);
  shipGroup.add(shipPlumeLight);

  const boosterLocalNozzles: NozzleSocketSpec[] = [];
  const shipLocalNozzles: NozzleSocketSpec[] = [];
  const sideBoosterMounts: SideBoosterMountSpec[] = [];
  const gridFinPivots: Array<{ pivot: THREE.Group; axis: "x" | "z"; sign: number }> = [];
  const forwardFlapPivots: Array<{ pivot: THREE.Group; side: -1 | 1 }> = [];
  const aftFlapPivots: Array<{ pivot: THREE.Group; side: -1 | 1 }> = [];
  const shipLegAssemblies: Array<{ pivot: THREE.Group; footPivot: THREE.Group }> = [];
  const boosterLegAssemblies: Array<{ pivot: THREE.Group; footPivot: THREE.Group }> = [];

  const dummy = new THREE.Object3D();

  // =========================================================================
  // 1. STARSHIP + SUPER HEAVY (121 m, 9 m dia, stainless steel + black TPS)
  // =========================================================================
  if (vehicleId === "starship") {
    const R = 4.5;
    const SHIP_BODY_H = 33.0;
    const SHIP_NOSE_H = 17.0;

    const hullGeom = track(new THREE.CylinderGeometry(R, R, 66.4, 40, 1));
    const hull = new THREE.Mesh(hullGeom, steelMat);
    hull.position.y = 34.8;
    hull.castShadow = true;
    hull.receiveShadow = true;
    boosterGroup.add(hull);

    const skirt = new THREE.Mesh(
      track(new THREE.CylinderGeometry(R, R + 0.28, 2.2, 36)),
      darkSteelMat
    );
    skirt.position.y = 1.1;
    skirt.castShadow = true;
    boosterGroup.add(skirt);

    const chineGeom = track(new THREE.BoxGeometry(0.45, 58.0, 0.35));
    for (const side of [-1, 1]) {
      const chine = new THREE.Mesh(chineGeom, darkSteelMat);
      chine.position.set(side * (R + 0.08), 34.0, 0);
      boosterGroup.add(chine);
    }

    const frostGeom = track(new THREE.CylinderGeometry(R + 0.035, R + 0.035, 42.0, 32, 1, true));
    const bFrost = new THREE.Mesh(frostGeom, boosterFrostMat);
    bFrost.position.y = 33.0;
    boosterGroup.add(bFrost);

    const ringGeom = track(new THREE.CylinderGeometry(R + 0.02, R + 0.02, 0.42, 36));
    const botRing = new THREE.Mesh(ringGeom, darkSteelMat);
    botRing.position.y = 68.2;
    const topRing = new THREE.Mesh(ringGeom, darkSteelMat);
    topRing.position.y = 70.79;
    boosterGroup.add(botRing, topRing);

    const struts = new THREE.InstancedMesh(
      track(new THREE.BoxGeometry(0.2, 2.35, 0.24)),
      darkSteelMat,
      24
    );
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * (R - 0.14), 69.5, Math.sin(a) * (R - 0.14));
      dummy.rotation.set(0, -a, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      struts.setMatrixAt(i, dummy.matrix);
    }
    struts.instanceMatrix.needsUpdate = true;
    boosterGroup.add(struts);

    const finFrameGeom = track(new THREE.BoxGeometry(2.7, 0.28, 3.6));
    const finRibGeom = track(new THREE.BoxGeometry(2.5, 0.34, 0.08));
    (
      [
        { angle: Math.PI * 0.25, axis: "x", sign: 1 },
        { angle: Math.PI * 0.75, axis: "x", sign: -1 },
        { angle: Math.PI * 1.25, axis: "z", sign: -1 },
        { angle: Math.PI * 1.75, axis: "z", sign: 1 },
      ] as const
    ).forEach((spec) => {
      const mount = new THREE.Group();
      mount.position.set(Math.cos(spec.angle) * R, 65.4, Math.sin(spec.angle) * R);
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
      boosterGroup.add(mount);
      gridFinPivots.push({ pivot, axis: spec.axis, sign: spec.sign });
    });

    const bellGeom = track(new THREE.CylinderGeometry(0.32, 0.62, 1.4, 14, 1, true));
    const outerAndMid = new THREE.InstancedMesh(bellGeom, nozzleMat, 30);
    let idx = 0;
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const px = Math.cos(a) * 3.65;
      const pz = Math.sin(a) * 3.65;
      dummy.position.set(px, 0.72, pz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      outerAndMid.setMatrixAt(idx++, dummy.matrix);
      if (i % 3 === 0) {
        boosterLocalNozzles.push({
          pos: new THREE.Vector3(px, -0.5, pz),
          gimbals: false,
          radius: 0.62,
          kind: "booster",
          plumeScale: 1.35,
        });
      }
    }
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.15;
      const px = Math.cos(a) * 2.25;
      const pz = Math.sin(a) * 2.25;
      dummy.position.set(px, 0.72, pz);
      dummy.updateMatrix();
      outerAndMid.setMatrixAt(idx++, dummy.matrix);
    }
    outerAndMid.instanceMatrix.needsUpdate = true;
    boosterGroup.add(outerAndMid);

    boosterGimbalGroup.position.set(0, 1.1, 0);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const px = Math.cos(a) * 0.85;
      const pz = Math.sin(a) * 0.85;
      const bell = new THREE.Mesh(bellGeom, nozzleMat);
      bell.position.set(px, -0.38, pz);
      boosterGimbalGroup.add(bell);
      boosterLocalNozzles.unshift({
        pos: new THREE.Vector3(px, -0.95, pz),
        gimbals: true,
        radius: 0.62,
        kind: "booster",
        plumeScale: 1.35,
      });
    }
    boosterGroup.add(boosterGimbalGroup);

    // Starship Upper Stage
    const tpsCyl = new THREE.Mesh(
      track(new THREE.CylinderGeometry(R, R, SHIP_BODY_H, 28, 1, false, -Math.PI * 0.5, Math.PI)),
      tpsMat
    );
    tpsCyl.position.y = SHIP_BODY_H * 0.5;
    tpsCyl.castShadow = true;
    tpsCyl.receiveShadow = true;

    const steelCyl = new THREE.Mesh(
      track(new THREE.CylinderGeometry(R, R, SHIP_BODY_H, 28, 1, false, Math.PI * 0.5, Math.PI)),
      steelMat
    );
    steelCyl.position.y = SHIP_BODY_H * 0.5;
    steelCyl.castShadow = true;
    steelCyl.receiveShadow = true;
    shipGroup.add(tpsCyl, steelCyl);

    const ogivePts: THREE.Vector2[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      ogivePts.push(
        new THREE.Vector2(Math.max(0.08, R * Math.pow(Math.cos(t * Math.PI * 0.5), 0.72)), t * SHIP_NOSE_H)
      );
    }
    const tpsNose = new THREE.Mesh(track(new THREE.LatheGeometry(ogivePts, 24, -Math.PI * 0.5, Math.PI)), tpsMat);
    tpsNose.position.y = SHIP_BODY_H;
    tpsNose.castShadow = true;
    const steelNose = new THREE.Mesh(track(new THREE.LatheGeometry(ogivePts, 24, Math.PI * 0.5, Math.PI)), steelMat);
    steelNose.position.y = SHIP_BODY_H;
    steelNose.castShadow = true;
    shipGroup.add(tpsNose, steelNose);

    const shipFrost = new THREE.Mesh(
      track(new THREE.CylinderGeometry(R + 0.035, R + 0.035, 20.0, 24, 1, true, Math.PI * 0.55, Math.PI * 0.9)),
      shipFrostMat
    );
    shipFrost.position.y = 16.5;
    shipGroup.add(shipFrost);

    const fwdShape = new THREE.Shape();
    fwdShape.moveTo(0, -2.5);
    fwdShape.lineTo(2.4, -1.6);
    fwdShape.lineTo(1.7, 3.0);
    fwdShape.lineTo(0, 3.4);
    fwdShape.closePath();
    const fwdGeom = track(
      new THREE.ExtrudeGeometry(fwdShape, { depth: 0.24, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2 })
    );
    fwdGeom.translate(0, 0, -0.12);
    for (const side of [-1, 1] as const) {
      const mount = new THREE.Group();
      mount.position.set(side * 3.1, 38.0, 0.2);
      const pivot = new THREE.Group();
      const mesh = new THREE.Mesh(fwdGeom, tpsMat);
      if (side === -1) mesh.scale.x = -1;
      mesh.castShadow = true;
      pivot.add(mesh);
      mount.add(pivot);
      shipGroup.add(mount);
      forwardFlapPivots.push({ pivot, side });
    }

    const aftShape = new THREE.Shape();
    aftShape.moveTo(0, -5.0);
    aftShape.lineTo(3.6, -4.4);
    aftShape.lineTo(2.6, 4.6);
    aftShape.lineTo(0, 5.2);
    aftShape.closePath();
    const aftGeom = track(
      new THREE.ExtrudeGeometry(aftShape, { depth: 0.28, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 2 })
    );
    aftGeom.translate(0, 0, -0.14);
    for (const side of [-1, 1] as const) {
      const mount = new THREE.Group();
      mount.position.set(side * (R - 0.15), 7.8, 0.25);
      const pivot = new THREE.Group();
      const mesh = new THREE.Mesh(aftGeom, tpsMat);
      if (side === -1) mesh.scale.x = -1;
      mesh.castShadow = true;
      pivot.add(mesh);
      mount.add(pivot);
      shipGroup.add(mount);
      aftFlapPivots.push({ pivot, side });
    }

    const vacBellGeom = track(new THREE.CylinderGeometry(0.45, 1.15, 2.3, 16, 1, true));
    const slBellGeom = track(new THREE.CylinderGeometry(0.3, 0.62, 1.4, 14, 1, true));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
      const px = Math.cos(a) * 2.55;
      const pz = Math.sin(a) * 2.55;
      const vac = new THREE.Mesh(vacBellGeom, nozzleMat);
      vac.position.set(px, 0.9, pz);
      shipGroup.add(vac);
      shipLocalNozzles.push({
        pos: new THREE.Vector3(px, -0.85, pz),
        gimbals: false,
        radius: 1.15,
        kind: "ship_vac",
        plumeScale: 1.65,
      });
    }
    shipGimbalGroup.position.set(0, 1.2, 0);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 - Math.PI / 6;
      const px = Math.cos(a) * 0.92;
      const pz = Math.sin(a) * 0.92;
      const sl = new THREE.Mesh(slBellGeom, nozzleMat);
      sl.position.set(px, -0.45, pz);
      shipGimbalGroup.add(sl);
      shipLocalNozzles.push({
        pos: new THREE.Vector3(px, -0.85, pz),
        gimbals: true,
        radius: 0.62,
        kind: "ship_sl",
        plumeScale: 1.1,
      });
    }
    shipGroup.add(shipGimbalGroup);

    const legStrutGeom = track(new THREE.BoxGeometry(0.32, 4.6, 0.42));
    const padGeom = track(new THREE.CylinderGeometry(0.65, 0.82, 0.28, 12));
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const mount = new THREE.Group();
      mount.position.set(Math.cos(angle) * (R - 0.15), 3.1, Math.sin(angle) * (R - 0.15));
      mount.rotation.y = -angle;
      const pivot = new THREE.Group();
      const strut = new THREE.Mesh(legStrutGeom, darkSteelMat);
      strut.position.set(0, -2.15, 0);
      strut.castShadow = true;
      pivot.add(strut);
      const footPivot = new THREE.Group();
      footPivot.position.set(0, -4.3, 0);
      footPivot.add(new THREE.Mesh(padGeom, darkSteelMat));
      pivot.add(footPivot);
      mount.add(pivot);
      shipGroup.add(mount);
      shipLegAssemblies.push({ pivot, footPivot });
    }

    return {
      disposables,
      boosterLocalNozzles,
      shipLocalNozzles,
      sideBoosterMounts,
      boosterPlumeStyle: "methalox",
      shipPlumeStyle: "methalox",
      sidePlumeStyle: "methalox",
      gridFinPivots,
      forwardFlapPivots,
      aftFlapPivots,
      shipLegAssemblies,
      boosterLegAssemblies,
      boosterFrostMat,
      shipFrostMat,
      boosterPlumeLight,
      shipPlumeLight,
    };
  }

  // =========================================================================
  // 2. FALCON 9 BLOCK 5 (70 m, 3.7 m dia, white soot Stage 1 + 4 legs + fairing)
  // =========================================================================
  if (vehicleId === "falcon9") {
    const R = 1.85;
    const sootMat = track(
      new THREE.MeshStandardMaterial({
        color: "#6b7280",
        normalMap: steelTex.normalMap,
        roughness: 0.72,
        metalness: 0.2,
      })
    );

    const bLower = new THREE.Mesh(track(new THREE.CylinderGeometry(R, R, 12.0, 28)), sootMat);
    bLower.position.y = 7.0;
    bLower.castShadow = true;
    const bMid = new THREE.Mesh(track(new THREE.CylinderGeometry(R, R, 30.0, 28)), matteWhiteMat);
    bMid.position.y = 28.0;
    bMid.castShadow = true;
    const interstage = new THREE.Mesh(track(new THREE.CylinderGeometry(R + 0.02, R + 0.02, 4.0, 28)), carbonMat);
    interstage.position.y = 45.0;
    interstage.castShadow = true;
    const octaSkirt = new THREE.Mesh(track(new THREE.CylinderGeometry(R, R + 0.16, 1.4, 24)), carbonMat);
    octaSkirt.position.y = 0.7;
    boosterGroup.add(bLower, bMid, interstage, octaSkirt);

    // Dual black raceways
    const raceGeom = track(new THREE.BoxGeometry(0.28, 39.0, 0.24));
    for (const s of [-1, 1]) {
      const rw = new THREE.Mesh(raceGeom, carbonMat);
      rw.position.set(0, 23.0, s * (R + 0.06));
      boosterGroup.add(rw);
    }

    // 4 Titanium Grid Fins near interstage (y = 43.2)
    const finGeom = track(new THREE.BoxGeometry(1.3, 0.14, 1.7));
    (
      [
        { angle: Math.PI * 0.25, axis: "x", sign: 1 },
        { angle: Math.PI * 0.75, axis: "x", sign: -1 },
        { angle: Math.PI * 1.25, axis: "z", sign: -1 },
        { angle: Math.PI * 1.75, axis: "z", sign: 1 },
      ] as const
    ).forEach((spec) => {
      const mount = new THREE.Group();
      mount.position.set(Math.cos(spec.angle) * R, 43.2, Math.sin(spec.angle) * R);
      mount.rotation.y = -spec.angle + Math.PI * 0.5;
      const pivot = new THREE.Group();
      const fin = new THREE.Mesh(finGeom, carbonMat);
      fin.position.set(0, 0, 0.9);
      pivot.add(fin);
      mount.add(pivot);
      boosterGroup.add(mount);
      gridFinPivots.push({ pivot, axis: spec.axis, sign: spec.sign });
    });

    // 4 Deployable Carbon Landing Legs on Stage 1 base (fold downward from stowed upright)
    const legH = 8.4;
    const f9LegGeom = track(new THREE.BoxGeometry(0.26, legH, 0.95));
    const f9FootGeom = track(new THREE.CylinderGeometry(0.32, 0.42, 0.2, 8));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const mount = new THREE.Group();
      mount.position.set(Math.cos(a) * (R + 0.05), 1.8, Math.sin(a) * (R + 0.05));
      mount.rotation.y = -a;
      const pivot = new THREE.Group();
      const strut = new THREE.Mesh(f9LegGeom, carbonMat);
      strut.position.set(0.2, legH * 0.5, 0);
      strut.castShadow = true;
      pivot.add(strut);
      const footPivot = new THREE.Group();
      footPivot.position.set(0.2, legH, 0);
      footPivot.add(new THREE.Mesh(f9FootGeom, carbonMat));
      pivot.add(footPivot);
      mount.add(pivot);
      boosterGroup.add(mount);
      boosterLegAssemblies.push({ pivot, footPivot });
    }

    // 9 Merlin 1D nozzles (8 ring + 1 center gimbaling)
    const m1dGeom = track(new THREE.CylinderGeometry(0.22, 0.42, 0.95, 12, 1, true));
    const octaRing = new THREE.InstancedMesh(m1dGeom, nozzleMat, 8);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const px = Math.cos(a) * 1.32;
      const pz = Math.sin(a) * 1.32;
      dummy.position.set(px, 0.45, pz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      octaRing.setMatrixAt(i, dummy.matrix);
      if (i % 2 === 0) {
        boosterLocalNozzles.push({
          pos: new THREE.Vector3(px, -0.35, pz),
          gimbals: false,
          radius: 0.42,
          kind: "booster",
          plumeScale: 0.95,
        });
      }
    }
    octaRing.instanceMatrix.needsUpdate = true;
    boosterGroup.add(octaRing);

    boosterGimbalGroup.position.set(0, 0.8, 0);
    const mCenter = new THREE.Mesh(m1dGeom, nozzleMat);
    mCenter.position.set(0, -0.35, 0);
    boosterGimbalGroup.add(mCenter);
    boosterLocalNozzles.unshift({
      pos: new THREE.Vector3(0, -0.65, 0),
      gimbals: true,
      radius: 0.44,
      kind: "booster",
      plumeScale: 1.05,
    });
    boosterGroup.add(boosterGimbalGroup);

    // Stage 2 + MVac + bulbous 5.2 m payload fairing
    const s2Body = new THREE.Mesh(track(new THREE.CylinderGeometry(R, R, 10.5, 28)), matteWhiteMat);
    s2Body.position.y = 5.25;
    s2Body.castShadow = true;
    shipGroup.add(s2Body);

    const fairPts: THREE.Vector2[] = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const r =
        t < 0.14
          ? R + (2.6 - R) * (t / 0.14)
          : t < 0.56
            ? 2.6
            : Math.max(0.08, 2.6 * Math.pow(Math.cos(((t - 0.56) / 0.44) * Math.PI * 0.5), 0.75));
      fairPts.push(new THREE.Vector2(r, t * 12.5));
    }
    const fairing = new THREE.Mesh(track(new THREE.LatheGeometry(fairPts, 28)), matteWhiteMat);
    fairing.position.y = 10.5;
    fairing.castShadow = true;
    shipGroup.add(fairing);

    shipGimbalGroup.position.set(0, 0.2, 0);
    const mvac = new THREE.Mesh(
      track(new THREE.CylinderGeometry(0.35, 1.35, 2.4, 18, 1, true)),
      nozzleMat
    );
    mvac.position.set(0, -1.0, 0);
    shipGimbalGroup.add(mvac);
    shipGroup.add(shipGimbalGroup);
    shipLocalNozzles.push({
      pos: new THREE.Vector3(0, -1.35, 0),
      gimbals: true,
      radius: 1.35,
      kind: "ship_vac",
      plumeScale: 1.65,
    });

    const frostBand = new THREE.Mesh(
      track(new THREE.CylinderGeometry(R + 0.03, R + 0.03, 18.0, 20, 1, true)),
      boosterFrostMat
    );
    frostBand.position.y = 22.0;
    boosterGroup.add(frostBand);

    return {
      disposables,
      boosterLocalNozzles,
      shipLocalNozzles,
      sideBoosterMounts,
      boosterPlumeStyle: "kerolox",
      shipPlumeStyle: "kerolox",
      sidePlumeStyle: "kerolox",
      gridFinPivots,
      forwardFlapPivots,
      aftFlapPivots,
      shipLegAssemblies,
      boosterLegAssemblies,
      boosterFrostMat,
      shipFrostMat,
      boosterPlumeLight,
      shipPlumeLight,
    };
  }

  // =========================================================================
  // 3. ISRO LVM3 (43.5 m, L110 + 2x S200 Solid Strap-Ons + C25 + Tricolor Fairing)
  // =========================================================================
  if (vehicleId === "lvm3") {
    const R = 2.0;
    const orangeMat = track(
      new THREE.MeshStandardMaterial({ color: "#ea580c", roughness: 0.45, metalness: 0.15 })
    );
    const core = new THREE.Mesh(track(new THREE.CylinderGeometry(R, R, 21.0, 28)), matteWhiteMat);
    core.position.y = 10.5;
    core.castShadow = true;
    const coreBand = new THREE.Mesh(track(new THREE.CylinderGeometry(R + 0.03, R + 0.03, 1.2, 24)), orangeMat);
    coreBand.position.y = 19.6;
    const aftSkirt = new THREE.Mesh(track(new THREE.CylinderGeometry(R, R + 0.18, 1.6, 24)), carbonMat);
    aftSkirt.position.y = 0.8;
    boosterGroup.add(core, coreBand, aftSkirt);

    // Twin Vikas nozzles on L110 core
    const vikasGeom = track(new THREE.CylinderGeometry(0.28, 0.58, 1.3, 14, 1, true));
    boosterGimbalGroup.position.set(0, 0.6, 0);
    for (const px of [-0.82, 0.82]) {
      const bell = new THREE.Mesh(vikasGeom, nozzleMat);
      bell.position.set(px, -0.5, 0);
      boosterGimbalGroup.add(bell);
      boosterLocalNozzles.push({
        pos: new THREE.Vector3(px, -0.9, 0),
        gimbals: true,
        radius: 0.58,
        kind: "booster",
        plumeScale: 1.15,
      });
    }
    boosterGroup.add(boosterGimbalGroup);

    // Build Left & Right S200 Solid Strap-On Boosters
    const s200R = 1.55;
    const s200CylGeom = track(new THREE.CylinderGeometry(s200R, s200R, 21.5, 22));
    const s200ConeGeom = track(new THREE.ConeGeometry(s200R, 3.8, 22));
    const s200RingGeom = track(new THREE.CylinderGeometry(s200R + 0.04, s200R + 0.04, 0.65, 22));
    const s200NozGeom = track(new THREE.CylinderGeometry(0.45, 0.92, 1.8, 16, 1, true));

    (
      [
        { group: leftSideGroup, z: -3.75, cantSign: -1 },
        { group: rightSideGroup, z: 3.75, cantSign: 1 },
      ] as const
    ).forEach((side) => {
      const body = new THREE.Mesh(s200CylGeom, matteWhiteMat);
      body.position.y = 11.2;
      body.castShadow = true;
      const cone = new THREE.Mesh(s200ConeGeom, matteWhiteMat);
      cone.position.y = 23.85;
      cone.rotation.x = side.cantSign * 0.06;
      const ringA = new THREE.Mesh(s200RingGeom, orangeMat);
      ringA.position.y = 18.5;
      const ringB = new THREE.Mesh(s200RingGeom, carbonMat);
      ringB.position.y = 3.2;
      const noz = new THREE.Mesh(s200NozGeom, nozzleMat);
      noz.position.y = -0.35;
      noz.rotation.x = side.cantSign * 0.14;
      side.group.add(body, cone, ringA, ringB, noz);
      sideBoosterMounts.push({
        localPos: new THREE.Vector3(0, 0, side.z),
        cantZ: side.cantSign * 0.14,
        plumeScale: 1.5,
      });
    });

    // Upper C25 Stage + Tricolor Ogive Payload Fairing (22.5 m)
    const c25 = new THREE.Mesh(track(new THREE.CylinderGeometry(R, R, 11.0, 28)), darkSteelMat);
    c25.position.y = 5.5;
    c25.castShadow = true;
    shipGroup.add(c25);

    const fairingTex = track(createLvm3FairingTexture());
    const fairingMat = track(
      new THREE.MeshStandardMaterial({
        color: "#ffffff",
        map: fairingTex,
        roughness: 0.48,
        metalness: 0.12,
      })
    );
    const lvmPts: THREE.Vector2[] = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      const r =
        t < 0.12
          ? R + (2.5 - R) * (t / 0.12)
          : t < 0.5
            ? 2.5
            : Math.max(0.08, 2.5 * Math.pow(Math.cos(((t - 0.5) / 0.5) * Math.PI * 0.5), 0.72));
      lvmPts.push(new THREE.Vector2(r, t * 11.5));
    }
    const lvmFairing = new THREE.Mesh(track(new THREE.LatheGeometry(lvmPts, 28)), fairingMat);
    lvmFairing.position.y = 11.0;
    lvmFairing.castShadow = true;
    shipGroup.add(lvmFairing);

    shipGimbalGroup.position.set(0, 0.2, 0);
    const ce20 = new THREE.Mesh(
      track(new THREE.CylinderGeometry(0.32, 0.98, 1.8, 16, 1, true)),
      nozzleMat
    );
    ce20.position.set(0, -0.7, 0);
    shipGimbalGroup.add(ce20);
    shipGroup.add(shipGimbalGroup);
    shipLocalNozzles.push({
      pos: new THREE.Vector3(0, -1.0, 0),
      gimbals: true,
      radius: 0.98,
      kind: "ship_vac",
      plumeScale: 1.3,
    });

    return {
      disposables,
      boosterLocalNozzles,
      shipLocalNozzles,
      sideBoosterMounts,
      boosterPlumeStyle: "kerolox",
      shipPlumeStyle: "methalox",
      sidePlumeStyle: "solid_hybrid",
      gridFinPivots,
      forwardFlapPivots,
      aftFlapPivots,
      shipLegAssemblies,
      boosterLegAssemblies,
      boosterFrostMat: null,
      shipFrostMat,
      boosterPlumeLight,
      shipPlumeLight,
    };
  }

  // =========================================================================
  // 4. NASA SATURN V (110.6 m, 10.1 m dia, Roll-Pattern S-IC + Fins + LES Tower)
  // =========================================================================
  const R = 5.05;
  const rollTex = track(createSaturnRollTexture());
  const rollMat = track(
    new THREE.MeshStandardMaterial({
      color: "#ffffff",
      map: rollTex,
      roughness: 0.5,
      metalness: 0.14,
    })
  );

  // S-IC First Stage (42 m)
  const sicBody = new THREE.Mesh(track(new THREE.CylinderGeometry(R, R, 42.0, 40)), rollMat);
  sicBody.position.y = 21.0;
  sicBody.castShadow = true;
  boosterGroup.add(sicBody);

  // 4 Stabilizer Fins + F-1 Engine Fairings
  const f1FairingGeom = track(new THREE.ConeGeometry(1.4, 6.5, 10));
  const finS5Geom = track(new THREE.BoxGeometry(3.4, 4.4, 0.28));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const fairing = new THREE.Mesh(f1FairingGeom, matteWhiteMat);
    fairing.position.set(Math.cos(a) * (R + 0.1), 3.4, Math.sin(a) * (R + 0.1));
    const fin = new THREE.Mesh(finS5Geom, matteWhiteMat);
    fin.position.set(Math.cos(a) * (R + 1.5), 2.8, Math.sin(a) * (R + 1.5));
    fin.rotation.y = -a;
    boosterGroup.add(fairing, fin);
  }

  // 5 Giant F-1 Bells (4 outer + 1 center)
  const f1Geom = track(new THREE.CylinderGeometry(0.75, 1.85, 3.2, 18, 1, true));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const px = Math.cos(a) * 3.55;
    const pz = Math.sin(a) * 3.55;
    const f1 = new THREE.Mesh(f1Geom, nozzleMat);
    f1.position.set(px, -0.4, pz);
    boosterGroup.add(f1);
    boosterLocalNozzles.push({
      pos: new THREE.Vector3(px, -1.6, pz),
      gimbals: false,
      radius: 1.85,
      kind: "booster",
      plumeScale: 2.0,
    });
  }
  boosterGimbalGroup.position.set(0, 0.6, 0);
  const f1Center = new THREE.Mesh(f1Geom, nozzleMat);
  f1Center.position.set(0, -1.0, 0);
  boosterGimbalGroup.add(f1Center);
  boosterLocalNozzles.unshift({
    pos: new THREE.Vector3(0, -1.6, 0),
    gimbals: true,
    radius: 1.85,
    kind: "booster",
    plumeScale: 2.1,
  });
  boosterGroup.add(boosterGimbalGroup);

  // S-II + S-IVB + SLA + Apollo CSM + LES Tower (68.6 m stacked above S-IC)
  const s2Skirt = new THREE.Mesh(track(new THREE.CylinderGeometry(R, R, 5.2, 36)), carbonMat);
  s2Skirt.position.y = 2.6;
  const s2Body = new THREE.Mesh(track(new THREE.CylinderGeometry(R, R, 19.8, 36)), matteWhiteMat);
  s2Body.position.y = 15.1;
  s2Body.castShadow = true;
  const s2Tap = new THREE.Mesh(track(new THREE.CylinderGeometry(3.3, R, 4.0, 32)), carbonMat);
  s2Tap.position.y = 27.0;
  const sivb = new THREE.Mesh(track(new THREE.CylinderGeometry(3.3, 3.3, 14.5, 32)), rollMat);
  sivb.position.y = 36.25;
  sivb.castShadow = true;
  const sla = new THREE.Mesh(track(new THREE.CylinderGeometry(1.95, 3.3, 8.5, 28)), matteWhiteMat);
  sla.position.y = 47.75;
  const csm = new THREE.Mesh(track(new THREE.CylinderGeometry(1.95, 1.95, 4.6, 24)), steelMat);
  csm.position.y = 54.3;
  const cm = new THREE.Mesh(track(new THREE.ConeGeometry(1.95, 3.2, 24)), steelMat);
  cm.position.y = 58.2;
  const lesMat = track(
    new THREE.MeshStandardMaterial({ color: "#e5e7eb", roughness: 0.45, metalness: 0.25 })
  );
  const lesTower = new THREE.Mesh(track(new THREE.CylinderGeometry(0.18, 0.48, 8.8, 12)), lesMat);
  lesTower.position.y = 64.2;
  shipGroup.add(s2Skirt, s2Body, s2Tap, sivb, sla, csm, cm, lesTower);

  // 5 J-2 Vacuum Nozzles on S-II aft
  const j2Geom = track(new THREE.CylinderGeometry(0.38, 1.05, 2.0, 14, 1, true));
  shipGimbalGroup.position.set(0, 0.4, 0);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const px = Math.cos(a) * 2.4;
    const pz = Math.sin(a) * 2.4;
    const j2 = new THREE.Mesh(j2Geom, nozzleMat);
    j2.position.set(px, -0.8, pz);
    shipGimbalGroup.add(j2);
    shipLocalNozzles.push({
      pos: new THREE.Vector3(px, -1.3, pz),
      gimbals: true,
      radius: 1.05,
      kind: "ship_vac",
      plumeScale: 1.45,
    });
  }
  const j2C = new THREE.Mesh(j2Geom, nozzleMat);
  j2C.position.set(0, -0.8, 0);
  shipGimbalGroup.add(j2C);
  shipGroup.add(shipGimbalGroup);
  shipLocalNozzles.unshift({
    pos: new THREE.Vector3(0, -1.3, 0),
    gimbals: true,
    radius: 1.05,
    kind: "ship_vac",
    plumeScale: 1.5,
  });

  return {
    disposables,
    boosterLocalNozzles,
    shipLocalNozzles,
    sideBoosterMounts,
    boosterPlumeStyle: "kerolox",
    shipPlumeStyle: "methalox",
    sidePlumeStyle: "kerolox",
    gridFinPivots,
    forwardFlapPivots,
    aftFlapPivots,
    shipLegAssemblies,
    boosterLegAssemblies,
    boosterFrostMat,
    shipFrostMat,
    boosterPlumeLight,
    shipPlumeLight,
  };
}
