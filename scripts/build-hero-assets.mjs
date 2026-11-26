import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// Lightweight FileReader polyfill for Node.js so Three.js GLTFExporter works cleanly offline
if (typeof globalThis.FileReader === "undefined") {
  globalThis.FileReader = class NodeFileReader {
    constructor() {
      this.result = null;
      this.onloadend = null;
      this.onload = null;
      this.onerror = null;
    }
    readAsArrayBuffer(blob) {
      Promise.resolve(blob.arrayBuffer())
        .then((buf) => {
          this.result = buf;
          if (typeof this.onload === "function") this.onload({ target: this });
          if (typeof this.onloadend === "function") this.onloadend({ target: this });
        })
        .catch((err) => {
          if (typeof this.onerror === "function") this.onerror(err);
        });
    }
    readAsDataURL(blob) {
      Promise.resolve(blob.arrayBuffer())
        .then((buf) => {
          const b64 = Buffer.from(buf).toString("base64");
          const mime = blob.type || "application/octet-stream";
          this.result = `data:${mime};base64,${b64}`;
          if (typeof this.onload === "function") this.onload({ target: this });
          if (typeof this.onloadend === "function") this.onloadend({ target: this });
        })
        .catch((err) => {
          if (typeof this.onerror === "function") this.onerror(err);
        });
    }
  };
}

function copyDecoderBundle() {
  const dracoSrc = path.join(rootDir, "node_modules", "three", "examples", "jsm", "libs", "draco", "gltf");
  const basisSrc = path.join(rootDir, "node_modules", "three", "examples", "jsm", "libs", "basis");
  const dracoDst = path.join(rootDir, "public", "decoders", "draco");
  const basisDst = path.join(rootDir, "public", "decoders", "basis");

  fs.mkdirSync(dracoDst, { recursive: true });
  fs.mkdirSync(basisDst, { recursive: true });

  const dracoFiles = ["draco_decoder.js", "draco_decoder.wasm", "draco_wasm_wrapper.js"];
  for (const f of dracoFiles) {
    fs.copyFileSync(path.join(dracoSrc, f), path.join(dracoDst, f));
  }

  const basisFiles = ["basis_transcoder.js", "basis_transcoder.wasm"];
  for (const f of basisFiles) {
    fs.copyFileSync(path.join(basisSrc, f), path.join(basisDst, f));
  }

  console.log(
    `[build-hero-assets] Copied ${dracoFiles.length} Draco + ${basisFiles.length} Basis/KTX2 decoder files to public/decoders/`
  );
}

function makeBox(w, h, d, mat, x = 0, y = 0, z = 0, name = "box") {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.name = name;
  mesh.position.set(x, y, z);
  return mesh;
}

function makeCyl(rt, rb, h, segs, mat, x = 0, y = 0, z = 0, name = "cyl") {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, segs), mat);
  mesh.name = name;
  mesh.position.set(x, y, z);
  return mesh;
}

/**
 * Builds the Starbase Boca Chica Mega Bay architectural hero model:
 * Grounded at y = 0, footprint ~44 m (X) x 40 m (Z), height ~86 m (Y).
 */
function buildStarbaseMegaBay() {
  const root = new THREE.Group();
  root.name = "StarbaseMegaBay";

  const concreteMat = new THREE.MeshStandardMaterial({
    name: "ConcreteFoundation",
    color: "#bfc5ce",
    roughness: 0.88,
    metalness: 0.04,
  });
  const claddingMat = new THREE.MeshStandardMaterial({
    name: "GalvanizedCladding",
    color: "#808b99",
    roughness: 0.48,
    metalness: 0.62,
  });
  const ribMat = new THREE.MeshStandardMaterial({
    name: "CladdingRib",
    color: "#697483",
    roughness: 0.44,
    metalness: 0.68,
  });
  const darkSteelMat = new THREE.MeshStandardMaterial({
    name: "StructuralSteel",
    color: "#323945",
    roughness: 0.38,
    metalness: 0.78,
  });
  const doorShutterMat = new THREE.MeshStandardMaterial({
    name: "BayDoorShutter",
    color: "#4a5564",
    roughness: 0.52,
    metalness: 0.58,
  });
  const penthouseGlassMat = new THREE.MeshStandardMaterial({
    name: "PenthouseGlass",
    color: "#5b9ad0",
    emissive: "#153658",
    emissiveIntensity: 0.28,
    roughness: 0.14,
    metalness: 0.86,
  });
  const craneYellowMat = new THREE.MeshStandardMaterial({
    name: "GantryCraneYellow",
    color: "#e6b422",
    roughness: 0.42,
    metalness: 0.32,
  });
  const ventLightMat = new THREE.MeshStandardMaterial({
    name: "RooftopMetal",
    color: "#b4beca",
    roughness: 0.54,
    metalness: 0.52,
  });

  // 1. Concrete foundation plinth
  root.add(makeBox(46.5, 2.2, 42.5, concreteMat, 0, 1.1, 0, "FoundationPlinth"));

  // 2. Main recessed steel core shell (y = 2.2 -> 70.0)
  root.add(makeBox(42.0, 68.0, 38.0, claddingMat, 0, 36.2, 0, "CoreShell"));

  // 3. Architectural vertical facade cladding ribs (east/west & north/south)
  const ribPositionsZ = [-15, -10, -5, 5, 10, 15];
  for (let i = 0; i < ribPositionsZ.length; i++) {
    const rz = ribPositionsZ[i];
    // West (-X) continuous ribs
    root.add(makeBox(0.9, 67.4, 1.2, ribMat, -21.3, 36.0, rz, `WestRib_${i}`));
    // East (+X) ribs outside central roll-up bay door (skip inner [-5, 5])
    if (Math.abs(rz) >= 9) {
      root.add(makeBox(0.9, 67.4, 1.2, ribMat, 21.3, 36.0, rz, `EastRib_${i}`));
    }
  }
  const ribPositionsX = [-16, -9.5, -3, 3, 9.5, 16];
  for (let i = 0; i < ribPositionsX.length; i++) {
    const rx = ribPositionsX[i];
    root.add(makeBox(1.2, 67.4, 0.9, ribMat, rx, 36.0, 19.3, `SouthRib_${i}`));
    root.add(makeBox(1.2, 67.4, 0.9, ribMat, rx, 36.0, -19.3, `NorthRib_${i}`));
  }

  // 4. Heavy external H-column structural corner buttresses + horizontal wind girts
  const corners = [
    [-21.4, -19.4],
    [21.4, -19.4],
    [-21.4, 19.4],
    [21.4, 19.4],
  ];
  corners.forEach(([cx, cz], idx) => {
    root.add(makeBox(2.4, 83.8, 2.4, darkSteelMat, cx, 43.0, cz, `CornerColumn_${idx}`));
    // Tapered base gusset
    root.add(makeBox(3.4, 5.5, 3.4, darkSteelMat, cx, 4.8, cz, `ColumnFoot_${idx}`));
  });
  // Horizontal seismic belt trusses encircling the Mega Bay
  for (const gy of [18, 36, 54, 70.2]) {
    root.add(makeBox(44.2, 1.35, 40.2, darkSteelMat, 0, gy, 0, `BeltTruss_${gy}`));
  }

  // 5. Pad-facing (+X) giant vehicle integration portal & roll-up shutter door
  root.add(makeBox(1.8, 56.0, 16.4, darkSteelMat, 21.2, 30.2, 0, "DoorPortalFrame"));
  root.add(makeBox(1.1, 52.0, 14.0, doorShutterMat, 21.65, 28.2, 0, "DoorShutterPanel"));
  // Horizontal door panel ribs
  for (let dy = 8; dy <= 50; dy += 6) {
    root.add(makeBox(0.55, 0.45, 14.4, darkSteelMat, 22.15, dy, 0, `DoorSeam_${dy}`));
  }
  // Yellow safety bollards flanking the main portal
  root.add(makeCyl(0.45, 0.55, 3.2, 8, craneYellowMat, 23.0, 3.2, -9.2, "DoorBollardN"));
  root.add(makeCyl(0.45, 0.55, 3.2, 8, craneYellowMat, 23.0, 3.2, 9.2, "DoorBollardS"));

  // 6. Internal/Portal Overhead Gantry Bridge Crane (visible beneath upper header overhang)
  root.add(makeBox(6.2, 2.2, 17.5, craneYellowMat, 20.4, 60.4, 0, "GantryBridgeBeam"));
  root.add(makeBox(3.0, 1.8, 3.6, darkSteelMat, 22.6, 58.6, 0, "GantryTrolleyHoist"));

  // 7. Panoramic Glass Penthouse Observation Deck (y = 70.8 -> 79.8)
  root.add(makeBox(42.8, 9.0, 38.8, penthouseGlassMat, 0, 75.4, 0, "PenthouseGlassBand"));
  // Vertical window mullions on all sides
  for (const mx of [-14, -7, 0, 7, 14]) {
    root.add(makeBox(0.55, 9.2, 39.4, darkSteelMat, mx, 75.4, 0, `GlassMullionX_${mx}`));
  }
  for (const mz of [-12, -4, 4, 12]) {
    root.add(makeBox(43.4, 9.2, 0.55, darkSteelMat, 0, 75.4, mz, `GlassMullionZ_${mz}`));
  }
  // Cantilevered exterior observation balcony deck + parapet rail on East (+X)
  root.add(makeBox(3.4, 0.65, 36.0, darkSteelMat, 23.1, 70.6, 0, "ObservationDeck"));
  root.add(makeBox(0.25, 1.3, 36.0, ventLightMat, 24.7, 71.55, 0, "ObservationRail"));

  // 8. Upper Crown, Parapet Cornice, Rooftop Mechanical Penthouse & HVAC Vents
  root.add(makeBox(45.4, 4.8, 41.4, darkSteelMat, 0, 82.4, 0, "RoofCrownParapet"));
  root.add(makeBox(41.5, 1.0, 37.5, concreteMat, 0, 84.9, 0, "RoofDeckSlab"));
  // Crane hoist mechanical penthouse on roof
  root.add(makeBox(16.0, 4.4, 13.0, ventLightMat, -6.0, 87.2, 0, "RoofHoistPenthouse"));
  // Rooftop HVAC & exhaust ventilator units
  const hvacCoords = [
    [10, -10],
    [10, 0],
    [10, 10],
    [-12, 12],
    [-12, -12],
  ];
  hvacCoords.forEach(([hx, hz], i) => {
    root.add(makeBox(4.2, 2.3, 3.4, ventLightMat, hx, 86.2, hz, `RoofHVAC_${i}`));
  });
  // Twin rooftop lightning masts
  root.add(makeCyl(0.12, 0.25, 6.5, 6, ventLightMat, 19.5, 88.2, 17.5, "LightningMastSE"));
  root.add(makeCyl(0.12, 0.25, 6.5, 6, ventLightMat, -19.5, 88.2, -17.5, "LightningMastNW"));

  return root;
}

/**
 * Builds the Range Telemetry Faceted Geodesic Radome hero model:
 * Grounded at y = 0, centered at origin, total height ~25 m.
 */
function buildTrackingRadome() {
  const root = new THREE.Group();
  root.name = "TrackingRadomeStation";

  const concreteMat = new THREE.MeshStandardMaterial({
    name: "RadomePedestalConcrete",
    color: "#c4cbd4",
    roughness: 0.88,
    metalness: 0.05,
  });
  const steelMat = new THREE.MeshStandardMaterial({
    name: "RadomeSteelWork",
    color: "#3f4957",
    roughness: 0.42,
    metalness: 0.74,
  });
  const railMat = new THREE.MeshStandardMaterial({
    name: "CatwalkRailSteel",
    color: "#8e99a8",
    roughness: 0.45,
    metalness: 0.72,
  });
  const radomeMat = new THREE.MeshStandardMaterial({
    name: "GeodesicCompositeFiberglass",
    color: "#e2e8f0",
    roughness: 0.44,
    metalness: 0.08,
    flatShading: true,
  });
  const dishMat = new THREE.MeshStandardMaterial({
    name: "TelemetryDishWhite",
    color: "#d6dee8",
    roughness: 0.36,
    metalness: 0.22,
    side: THREE.DoubleSide,
  });
  const beaconMat = new THREE.MeshStandardMaterial({
    name: "RadomeApexFinial",
    color: "#fca5a5",
    emissive: "#ef4444",
    emissiveIntensity: 1.35,
    roughness: 0.3,
    metalness: 0.1,
  });

  // 1. Stepped octagonal concrete pedestal & equipment bunker
  root.add(makeCyl(10.6, 11.4, 1.4, 8, concreteMat, 0, 0.7, 0, "PedestalPlinth"));
  root.add(makeCyl(8.6, 9.6, 6.8, 12, concreteMat, 0, 4.8, 0, "PedestalBunker"));
  // Recessed equipment room steel access door
  root.add(makeBox(1.2, 3.0, 2.2, steelMat, 9.15, 2.4, 0, "BunkerAccessDoor"));

  // 2. Cantilevered circular catwalk collar & safety railing ring
  root.add(makeCyl(10.8, 10.6, 0.45, 24, steelMat, 0, 8.35, 0, "CatwalkDeck"));
  const railRing = new THREE.Mesh(new THREE.TorusGeometry(10.55, 0.12, 8, 28), railMat);
  railRing.name = "PerimeterTopRail";
  railRing.rotation.x = Math.PI * 0.5;
  railRing.position.y = 9.55;
  root.add(railRing);

  const midRailRing = new THREE.Mesh(new THREE.TorusGeometry(10.55, 0.08, 6, 28), railMat);
  midRailRing.name = "PerimeterMidRail";
  midRailRing.rotation.x = Math.PI * 0.5;
  midRailRing.position.y = 9.0;
  root.add(midRailRing);

  // Stanchion posts around catwalk
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    root.add(
      makeCyl(
        0.09,
        0.09,
        1.25,
        6,
        railMat,
        Math.cos(a) * 10.55,
        9.0,
        Math.sin(a) * 10.55,
        `RailPost_${i}`
      )
    );
  }

  // 3. Exterior access stairwell ascending from ground to catwalk on -Z flank
  const stairGroup = new THREE.Group();
  stairGroup.name = "AccessStairwell";
  for (let s = 0; s < 8; s++) {
    const t = s / 7;
    const sy = 1.0 + t * 7.2;
    const sx = -8.2 + t * 6.5;
    stairGroup.add(makeBox(1.3, 0.18, 1.8, steelMat, sx, sy, -10.2, `StairTread_${s}`));
  }
  const stringer = makeBox(10.2, 0.35, 0.25, steelMat, -4.9, 4.6, -11.0, "StairStringer");
  stringer.rotation.z = 0.82;
  stairGroup.add(stringer);
  const stringer2 = makeBox(10.2, 0.35, 0.25, steelMat, -4.9, 4.6, -9.4, "StairStringerInner");
  stringer2.rotation.z = 0.82;
  stairGroup.add(stringer2);
  root.add(stairGroup);

  // 4. Faceted Geodesic Radome Sphere + Structural Base Ring
  root.add(makeCyl(8.7, 9.0, 1.2, 20, steelMat, 0, 8.9, 0, "DomeBaseCollar"));
  const domeGeo = new THREE.IcosahedronGeometry(9.6, 2);
  const domeMesh = new THREE.Mesh(domeGeo, radomeMat);
  domeMesh.name = "GeodesicRadomeDome";
  domeMesh.position.set(0, 14.3, 0);
  root.add(domeMesh);

  // Lightning rod finial & red aviation warning beacon at dome apex
  root.add(makeCyl(0.08, 0.16, 2.8, 6, railMat, 0, 24.9, 0, "ApexLightningRod"));
  const apexBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), beaconMat);
  apexBeacon.name = "ApexBeacon";
  apexBeacon.position.set(0, 26.35, 0);
  root.add(apexBeacon);

  // 5. Dual auxiliary S-band telemetry dishes mounted on catwalk outriggers
  const dishMounts = [
    { x: 11.4, z: 4.8, yaw: 0.45, pitch: 0.55 },
    { x: -11.4, z: 5.4, yaw: -0.6, pitch: 0.48 },
  ];
  dishMounts.forEach((dm, i) => {
    const dishUnit = new THREE.Group();
    dishUnit.name = `AuxTelemetryDish_${i}`;
    dishUnit.position.set(dm.x, 8.6, dm.z);
    dishUnit.rotation.y = dm.yaw;

    dishUnit.add(makeCyl(0.42, 0.58, 2.6, 8, steelMat, 0, 1.3, 0, `DishPedestal_${i}`));
    const dishGeo = new THREE.SphereGeometry(2.4, 14, 8, 0, Math.PI * 2, 0, 0.95);
    const reflector = new THREE.Mesh(dishGeo, dishMat);
    reflector.name = `DishReflector_${i}`;
    reflector.position.set(0, 2.8, 0);
    reflector.rotation.x = Math.PI * 0.5 - dm.pitch;
    dishUnit.add(reflector);

    const feed = makeCyl(0.09, 0.16, 2.1, 6, steelMat, 0, 3.6, 1.15, `DishFeedHorn_${i}`);
    feed.rotation.x = -0.6;
    dishUnit.add(feed);
    root.add(dishUnit);
  });

  return root;
}

/**
 * Bakes transforms and merges all child meshes sharing the same Material into
 * one draw call per material (drastically reducing main + CSM shadow draw calls
 * while preserving 100% of silhouette, normals, UVs, and PBR material fidelity).
 */
function optimizeHierarchyByMaterial(sourceRoot) {
  sourceRoot.updateMatrixWorld(true);
  const buckets = new Map();

  sourceRoot.traverse((node) => {
    if (!node.isMesh || !node.geometry || !node.material) return;
    const mat = node.material;
    const geom = node.geometry.clone();
    geom.applyMatrix4(node.matrixWorld);
    // Normalize to non-indexed so indexed & non-indexed primitives merge cleanly
    const normalized = geom.index ? geom.toNonIndexed() : geom;
    if (!normalized.attributes.normal) {
      normalized.computeVertexNormals();
    }
    if (!normalized.attributes.uv) {
      const count = normalized.attributes.position.count;
      normalized.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    let list = buckets.get(mat);
    if (!list) {
      list = [];
      buckets.set(mat, list);
    }
    list.push(normalized);
  });

  const optimized = new THREE.Group();
  optimized.name = sourceRoot.name;
  for (const [mat, geoms] of buckets.entries()) {
    const merged = mergeGeometries(geoms, false);
    if (!merged) {
      throw new Error(`Failed to merge geometries for material ${mat.name || "unnamed"}`);
    }
    for (const g of geoms) g.dispose();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = `${sourceRoot.name}_${mat.name || "Part"}`;
    optimized.add(mesh);
  }
  return optimized;
}

async function exportGlb(object3d, outPath) {
  const optimized = optimizeHierarchyByMaterial(object3d);
  const exporter = new GLTFExporter();
  const glbBuffer = await new Promise((resolve, reject) => {
    exporter.parse(
      optimized,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(Buffer.from(result));
        } else {
          reject(new Error("GLTFExporter did not return binary ArrayBuffer"));
        }
      },
      (err) => reject(err),
      { binary: true, onlyVisible: true }
    );
  });

  // Verify binary glTF 2.0 header magic ("glTF" = 0x46546C67)
  if (glbBuffer.length < 20 || glbBuffer.readUInt32LE(0) !== 0x46546c67) {
    throw new Error(`Generated buffer for ${outPath} failed glTF magic validation`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, glbBuffer);

  let triCount = 0;
  let meshCount = 0;
  optimized.traverse((node) => {
    if (node.isMesh && node.geometry) {
      meshCount += 1;
      const idx = node.geometry.index;
      const pos = node.geometry.attributes.position;
      triCount += idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
    }
  });
  console.log(
    `[build-hero-assets] Wrote ${path.relative(rootDir, outPath)} (${(glbBuffer.length / 1024).toFixed(1)} KB, ${meshCount} draw calls, ${Math.round(triCount)} tris)`
  );
}

async function main() {
  copyDecoderBundle();
  const modelsDir = path.join(rootDir, "public", "models");
  await exportGlb(buildStarbaseMegaBay(), path.join(modelsDir, "starbase_megabay.glb"));
  await exportGlb(buildTrackingRadome(), path.join(modelsDir, "tracking_radome.glb"));
}

main().catch((err) => {
  console.error("[build-hero-assets] Failed:", err);
  process.exit(1);
});
