import * as THREE from "three";
import type { OMMJsonObject } from "satellite.js";
import type { LaunchSiteConfig } from "../config/launchSites";
import type { PlanetConfig, PlanetId } from "../config/planets";
import { fetchCelesTrakGpSnapshot } from "../orbital/CelesTrakService";
import {
  GROUND_TRACK_OFFSET_M,
  type OrbitalDataSource,
  type OrbitalMeshStyle,
  type OrbitalProvenanceSummary,
  type RuntimeSatelliteEntry,
  type SatelliteDefinition,
  type SatelliteStateSnapshot,
  createRuntimeSatelliteEntry,
  evaluateSatelliteSnapshot,
  formatUtcTimestamp,
  geodeticToPlanetWorld,
  getPrimaryStationIdForPlanet,
  getSatelliteDefinitionsForPlanet,
  sampleGroundTrack,
  sampleOrbitalPathPlanetCentered,
} from "../orbital/SatelliteCatalog";
import { computeLaunchSiteZenithQuaternion } from "./earthGeography";

interface LabelSpriteEntry {
  readonly sprite: THREE.Sprite;
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.SpriteMaterial;
  readonly accentHex: string;
  readonly shortName: string;
}

interface ManagedOrbitalObject {
  readonly entry: RuntimeSatelliteEntry;
  readonly meshGroup: THREE.Group;
  readonly strobes: THREE.Mesh[];
  readonly labelSprite: LabelSpriteEntry | null;
  snapshot: SatelliteStateSnapshot | null;
}

export interface OrbitalVisibilityOptions {
  readonly showSatellites: boolean;
  readonly showGroundTrack: boolean;
  readonly showAllOrbitRings: boolean;
}

function createSatelliteLabelSprite(
  accentHex: string,
  shortName: string
): LabelSpriteEntry {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 56;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.font = "700 20px Consolas, 'Cascadia Mono', monospace";
    const textW = Math.min(198, Math.ceil(ctx.measureText(shortName).width));
    const pillX = 24;
    const pillY = 10;
    const pillW = textW + 24;
    const pillH = 36;

    ctx.fillStyle = "rgba(6, 12, 24, 0.86)";
    ctx.strokeStyle = accentHex;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 7);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = accentHex;
    ctx.beginPath();
    ctx.arc(pillX + 12, pillY + pillH * 0.5, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#f1f5f9";
    ctx.textBaseline = "middle";
    ctx.fillText(shortName, pillX + 22, pillY + pillH * 0.5 + 1, 186);
    ctx.restore();
  }

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
  sprite.renderOrder = 14;
  sprite.visible = false;

  return { sprite, texture, material, accentHex, shortName };
}

interface SharedSpacecraftMaterials {
  readonly aluminum: THREE.MeshStandardMaterial;
  readonly whiteHab: THREE.MeshStandardMaterial;
  readonly goldFoil: THREE.MeshStandardMaterial;
  readonly solarGold: THREE.MeshStandardMaterial;
  readonly solarBlue: THREE.MeshStandardMaterial;
  readonly darkOptics: THREE.MeshStandardMaterial;
  readonly radiatorWhite: THREE.MeshStandardMaterial;
  readonly strobeRed: THREE.MeshStandardMaterial;
  readonly strobeWhite: THREE.MeshStandardMaterial;
}

function createSharedSpacecraftMaterials(): SharedSpacecraftMaterials {
  return {
    aluminum: new THREE.MeshStandardMaterial({
      color: "#cbd5e1",
      metalness: 0.85,
      roughness: 0.28,
    }),
    whiteHab: new THREE.MeshStandardMaterial({
      color: "#d8dee6",
      metalness: 0.18,
      roughness: 0.48,
    }),
    goldFoil: new THREE.MeshStandardMaterial({
      color: "#d4a12a",
      metalness: 0.78,
      roughness: 0.34,
    }),
    solarGold: new THREE.MeshStandardMaterial({
      color: "#c58f2a",
      metalness: 0.68,
      roughness: 0.24,
    }),
    solarBlue: new THREE.MeshStandardMaterial({
      color: "#1e40af",
      metalness: 0.62,
      roughness: 0.22,
    }),
    darkOptics: new THREE.MeshStandardMaterial({
      color: "#1e293b",
      metalness: 0.6,
      roughness: 0.3,
    }),
    radiatorWhite: new THREE.MeshStandardMaterial({
      color: "#e2e8f0",
      metalness: 0.12,
      roughness: 0.55,
    }),
    strobeRed: new THREE.MeshStandardMaterial({
      color: "#fecaca",
      emissive: "#ef4444",
      emissiveIntensity: 2.0,
    }),
    strobeWhite: new THREE.MeshStandardMaterial({
      color: "#f8fafc",
      emissive: "#e0f2fe",
      emissiveIntensity: 2.0,
    }),
  };
}

function buildDetailedSpacecraftMesh(
  style: OrbitalMeshStyle,
  planetId: PlanetId,
  mats: SharedSpacecraftMaterials,
  trackGeom: <T extends THREE.BufferGeometry>(g: T) => T
): { group: THREE.Group; strobes: THREE.Mesh[] } {
  const group = new THREE.Group();
  const strobes: THREE.Mesh[] = [];
  const strobeGeom = trackGeom(new THREE.SphereGeometry(0.65, 8, 8));

  if (style === "iss") {
    // Detailed 1:1 modular International Space Station (~108 m integrated truss span)
    const truss = new THREE.Mesh(trackGeom(new THREE.BoxGeometry(106, 2.6, 2.6)), mats.aluminum);
    group.add(truss);

    // Truss alpha/beta rotary joint housings
    const sarjGeom = trackGeom(new THREE.CylinderGeometry(2.1, 2.1, 3.2, 12));
    for (const sx of [-24, 24]) {
      const joint = new THREE.Mesh(sarjGeom, mats.goldFoil);
      joint.rotation.z = Math.PI * 0.5;
      joint.position.set(sx, 0, 0);
      group.add(joint);
    }

    // Main pressurized module spine (Zvezda -> Zarya -> Unity -> Destiny -> Harmony)
    const spine = new THREE.Mesh(
      trackGeom(new THREE.CylinderGeometry(2.3, 2.3, 52, 16)),
      mats.whiteHab
    );
    spine.rotation.x = Math.PI * 0.5;
    spine.position.set(0, -1.5, 2);
    group.add(spine);

    // Columbus (port) & Kibo (starboard) laboratory modules + docking nodes
    const labCross = new THREE.Mesh(
      trackGeom(new THREE.CylinderGeometry(2.1, 2.1, 26, 14)),
      mats.whiteHab
    );
    labCross.rotation.z = Math.PI * 0.5;
    labCross.position.set(0, -1.5, 11);
    group.add(labCross);

    // Cupola nadir observatory + Quest airlock
    const cupola = new THREE.Mesh(
      trackGeom(new THREE.CylinderGeometry(1.1, 1.6, 2.2, 8)),
      mats.darkOptics
    );
    cupola.position.set(0, -4.4, -3);
    group.add(cupola);

    // 4 vertical white thermal radiator panels
    const radGeom = trackGeom(new THREE.BoxGeometry(4.2, 0.22, 18));
    for (const rx of [-14, -9.5, 9.5, 14]) {
      const rad = new THREE.Mesh(radGeom, mats.radiatorWhite);
      rad.position.set(rx, 1.8, -11.5);
      group.add(rad);
    }

    // 8 large golden-amber solar array wings (4 port, 4 starboard)
    const wingGeom = trackGeom(new THREE.BoxGeometry(10.5, 0.24, 34));
    const wings = new THREE.InstancedMesh(wingGeom, mats.solarGold, 8);
    const dummy = new THREE.Object3D();
    let idx = 0;
    for (const wx of [-46, -34, 34, 46]) {
      for (const sz of [-1, 1]) {
        dummy.position.set(wx, 0.4, sz * 21);
        dummy.rotation.set(0.22, 0, 0);
        dummy.updateMatrix();
        wings.setMatrixAt(idx++, dummy.matrix);
      }
    }
    wings.instanceMatrix.needsUpdate = true;
    group.add(wings);

    const s1 = new THREE.Mesh(strobeGeom, mats.strobeRed);
    s1.position.set(-53, 2.4, 0);
    const s2 = new THREE.Mesh(strobeGeom, mats.strobeWhite);
    s2.position.set(53, 2.4, 0);
    group.add(s1, s2);
    strobes.push(s1, s2);
  } else if (style === "tiangong") {
    // T-shaped modular China Space Station (~40 m)
    const core = new THREE.Mesh(
      trackGeom(new THREE.CylinderGeometry(2.1, 2.1, 26, 14)),
      mats.whiteHab
    );
    core.rotation.x = Math.PI * 0.5;
    group.add(core);

    const labs = new THREE.Mesh(
      trackGeom(new THREE.CylinderGeometry(1.9, 1.9, 34, 14)),
      mats.whiteHab
    );
    labs.rotation.z = Math.PI * 0.5;
    labs.position.set(0, 0, 5.5);
    group.add(labs);

    const wingGeom = trackGeom(new THREE.BoxGeometry(5.5, 0.2, 22));
    for (const wx of [-17.5, 17.5]) {
      for (const sz of [-1, 1]) {
        const w = new THREE.Mesh(wingGeom, mats.solarBlue);
        w.position.set(wx, 0, 5.5 + sz * 13);
        group.add(w);
      }
    }
    const s1 = new THREE.Mesh(strobeGeom, mats.strobeWhite);
    s1.position.set(0, 2.8, 0);
    group.add(s1);
    strobes.push(s1);
  } else if (style === "hubble") {
    // Hubble Space Telescope (~13.2 m tube, scaled slightly for crisp inspection clarity)
    const tube = new THREE.Mesh(
      trackGeom(new THREE.CylinderGeometry(2.4, 2.4, 18, 18)),
      mats.aluminum
    );
    tube.rotation.x = Math.PI * 0.5;
    group.add(tube);

    const aftShroud = new THREE.Mesh(
      trackGeom(new THREE.CylinderGeometry(3.0, 3.0, 6.2, 18)),
      mats.aluminum
    );
    aftShroud.rotation.x = Math.PI * 0.5;
    aftShroud.position.set(0, 0, -6.2);
    group.add(aftShroud);

    const apertureRim = new THREE.Mesh(
      trackGeom(new THREE.CylinderGeometry(2.1, 2.1, 0.6, 16)),
      mats.darkOptics
    );
    apertureRim.rotation.x = Math.PI * 0.5;
    apertureRim.position.set(0, 0, 9.1);
    group.add(apertureRim);

    const door = new THREE.Mesh(
      trackGeom(new THREE.BoxGeometry(4.2, 0.25, 4.4)),
      mats.aluminum
    );
    door.position.set(0, 2.4, 10.6);
    door.rotation.x = -0.65;
    group.add(door);

    const wingGeom = trackGeom(new THREE.BoxGeometry(11.5, 0.18, 3.6));
    for (const sx of [-1, 1]) {
      const wing = new THREE.Mesh(wingGeom, mats.solarBlue);
      wing.position.set(sx * 8.4, 0, 0.5);
      wing.rotation.x = 0.25;
      group.add(wing);
    }

    const dishGeom = trackGeom(new THREE.ConeGeometry(1.5, 0.8, 12));
    for (const sy of [-1, 1]) {
      const boom = new THREE.Mesh(
        trackGeom(new THREE.CylinderGeometry(0.14, 0.14, 5.2, 6)),
        mats.aluminum
      );
      boom.position.set(0, sy * 4.5, -2.0);
      const dish = new THREE.Mesh(dishGeom, mats.whiteHab);
      dish.position.set(0, sy * 7.2, -2.0);
      dish.rotation.x = sy > 0 ? Math.PI : 0;
      group.add(boom, dish);
    }
  } else if (style === "earth_obs") {
    // Sentinel-2A / NOAA-20 Earth observation satellite
    const bus = new THREE.Mesh(trackGeom(new THREE.BoxGeometry(4.2, 4.8, 7.2)), mats.goldFoil);
    group.add(bus);

    const optics = new THREE.Mesh(
      trackGeom(new THREE.CylinderGeometry(1.4, 1.7, 2.4, 14)),
      mats.darkOptics
    );
    optics.position.set(0, -3.2, 1.0);
    group.add(optics);

    const solarWing = new THREE.Mesh(
      trackGeom(new THREE.BoxGeometry(16.0, 0.2, 4.6)),
      mats.solarBlue
    );
    solarWing.position.set(10.5, 0.4, -0.5);
    solarWing.rotation.x = 0.3;
    group.add(solarWing);
  } else if (style === "gps" || style === "geo") {
    // Navigation MEO (GPS III) or Geostationary weather (GOES-16)
    const isGeo = style === "geo";
    const bus = new THREE.Mesh(
      trackGeom(new THREE.BoxGeometry(isGeo ? 6.0 : 4.8, isGeo ? 5.6 : 4.4, isGeo ? 7.2 : 5.2)),
      mats.goldFoil
    );
    group.add(bus);

    const panelPanel = new THREE.Mesh(
      trackGeom(new THREE.BoxGeometry(3.8, 0.6, 3.8)),
      mats.aluminum
    );
    panelPanel.position.set(0, -3.0, 0);
    group.add(panelPanel);

    const wingLen = isGeo ? 18 : 14;
    const wingGeom = trackGeom(new THREE.BoxGeometry(wingLen, 0.22, 4.8));
    for (const sx of [-1, 1]) {
      const wing = new THREE.Mesh(wingGeom, mats.solarBlue);
      wing.position.set(sx * (wingLen * 0.5 + 3.6), 0, 0);
      wing.rotation.x = 0.2;
      group.add(wing);
    }

    if (isGeo) {
      const dish = new THREE.Mesh(
        trackGeom(new THREE.CylinderGeometry(2.4, 0.6, 1.2, 16)),
        mats.whiteHab
      );
      dish.position.set(0, 3.5, 1.5);
      dish.rotation.x = 0.45;
      group.add(dish);
    }
  } else if (style === "starlink") {
    // Sleek flat-panel Starlink chassis + vertical single solar fin
    const chassis = new THREE.Mesh(
      trackGeom(new THREE.BoxGeometry(4.4, 0.45, 7.2)),
      mats.aluminum
    );
    const fin = new THREE.Mesh(
      trackGeom(new THREE.BoxGeometry(4.2, 11.5, 0.16)),
      mats.solarBlue
    );
    fin.position.set(0, 6.0, -3.0);
    group.add(chassis, fin);
  } else if (style === "gateway") {
    // Lunar Gateway / Mars Orbital Transfer Station
    const truss = new THREE.Mesh(trackGeom(new THREE.BoxGeometry(68, 2.2, 2.2)), mats.aluminum);
    group.add(truss);

    const spine = new THREE.Mesh(
      trackGeom(new THREE.CylinderGeometry(2.8, 2.8, 32, 14)),
      mats.whiteHab
    );
    spine.rotation.x = Math.PI * 0.5;
    group.add(spine);

    if (planetId === "mars") {
      const ring = new THREE.Mesh(
        trackGeom(new THREE.TorusGeometry(15.5, 1.6, 10, 28)),
        mats.whiteHab
      );
      group.add(ring);
    }

    const wingGeom = trackGeom(new THREE.BoxGeometry(9.0, 0.22, 26));
    for (const wx of [-28, 28]) {
      for (const sz of [-1, 1]) {
        const w = new THREE.Mesh(wingGeom, mats.solarGold);
        w.position.set(wx, 0, sz * 16.5);
        w.rotation.x = 0.2;
        group.add(w);
      }
    }
    const s1 = new THREE.Mesh(strobeGeom, mats.strobeRed);
    s1.position.set(-34, 2.2, 0);
    const s2 = new THREE.Mesh(strobeGeom, mats.strobeWhite);
    s2.position.set(34, 2.2, 0);
    group.add(s1, s2);
    strobes.push(s1, s2);
  } else {
    // Science planetary orbiter (LRO / MRO)
    const bus = new THREE.Mesh(trackGeom(new THREE.BoxGeometry(4.5, 4.5, 5.2)), mats.goldFoil);
    const dish = new THREE.Mesh(
      trackGeom(new THREE.CylinderGeometry(3.2, 0.5, 1.4, 16)),
      mats.whiteHab
    );
    dish.position.set(0, 4.0, 0);
    const wingGeom = trackGeom(new THREE.BoxGeometry(11.0, 0.2, 3.8));
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(wingGeom, mats.solarBlue);
      w.position.set(sx * 8.4, 0, 0);
      group.add(w);
    }
    group.add(bus, dish);
  }

  return { group, strobes };
}

/**
 * Manages explorable 3D satellites & space stations around Earth, Moon, and Mars:
 * - Real SGP4 propagation via `satellite.js` with live CelesTrak GP refresh & offline fallback
 * - Float64 camera-relative positioning (`worldPos - renderOrigin`)
 * - 3D orbital path ring + Earth surface ground track (±1 orbit at R + 1,800 m)
 * - 1-draw-call instanced space beacons + FOV-scaled flagship markers + viewport click picking
 */
export class OrbitalObjectManager {
  public readonly group = new THREE.Group();

  private readonly spacecraftRoot = new THREE.Group();
  private readonly planetCenterLinesRoot = new THREE.Group();
  private readonly markersRoot = new THREE.Group();

  private readonly sharedMats: SharedSpacecraftMaterials;
  private readonly meshDisposables: Array<{ dispose(): void }> = [];

  private readonly beaconGeo: THREE.OctahedronGeometry;
  private readonly beaconMat: THREE.MeshBasicMaterial;
  private beaconInst: THREE.InstancedMesh | null = null;

  private readonly selectedOrbitGeo: THREE.BufferGeometry;
  private readonly selectedOrbitMat: THREE.LineBasicMaterial;
  private readonly selectedOrbitLine: THREE.Line;

  private readonly groundTrackGeo: THREE.BufferGeometry;
  private readonly groundTrackMat: THREE.LineBasicMaterial;
  private readonly groundTrackLine: THREE.Line;

  private readonly nadirLineGeo: THREE.BufferGeometry;
  private readonly nadirLineMat: THREE.LineBasicMaterial;
  private readonly nadirLine: THREE.Line;
  private readonly nadirPositions = new Float32Array(6);

  private readonly allOrbitsGeo: THREE.BufferGeometry;
  private readonly allOrbitsMat: THREE.LineBasicMaterial;
  private readonly allOrbitsLine: THREE.LineSegments;
  private readonly earthshineLight: THREE.PointLight;

  private activePlanet: PlanetConfig;
  private activeSite: LaunchSiteConfig;
  private zenithQuat = new THREE.Quaternion();

  private managed: ManagedOrbitalObject[] = [];
  private liveOmmByNorad = new Map<number, OMMJsonObject>();
  private provenance: OrbitalProvenanceSummary = {
    dataSource: "simulated",
    lastUpdatedUtc: formatUtcTimestamp(new Date()),
    liveCount: 0,
    totalCatalogCount: 7,
    fetching: false,
    lastError: null,
  };

  private selectedId: string = "iss";
  private inspectedId: string | null = null;
  private visibility: OrbitalVisibilityOptions = {
    showSatellites: true,
    showGroundTrack: true,
    showAllOrbitRings: false,
  };

  private simEpochOffsetMs = 0;
  private lastLineRebuildSimMs = -Infinity;
  private linesDirty = true;
  private liveRefreshStarted = false;

  private readonly raycaster = new THREE.Raycaster();
  private readonly ndcVec = new THREE.Vector2();
  private readonly scratchDummy = new THREE.Object3D();
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchUp = new THREE.Vector3();
  private readonly scratchFwd = new THREE.Vector3();
  private readonly scratchRight = new THREE.Vector3();
  private readonly scratchMat4 = new THREE.Matrix4();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly scratchProj = new THREE.Vector3();
  private readonly scratchCamToSat = new THREE.Vector3();
  private readonly scratchCamToCenter = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();

  constructor(initialPlanet: PlanetConfig, initialSite: LaunchSiteConfig) {
    this.activePlanet = initialPlanet;
    this.activeSite = initialSite;
    this.zenithQuat.copy(
      computeLaunchSiteZenithQuaternion(initialSite.latDeg, initialSite.lonDeg)
    );

    this.sharedMats = createSharedSpacecraftMaterials();

    this.beaconGeo = new THREE.OctahedronGeometry(1.0, 0);
    this.beaconMat = new THREE.MeshBasicMaterial({
      color: "#ffffff",
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });

    this.selectedOrbitGeo = new THREE.BufferGeometry();
    this.selectedOrbitMat = new THREE.LineBasicMaterial({
      color: "#38bdf8",
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.selectedOrbitLine = new THREE.Line(this.selectedOrbitGeo, this.selectedOrbitMat);
    this.selectedOrbitLine.frustumCulled = false;
    this.selectedOrbitLine.renderOrder = 7;

    this.groundTrackGeo = new THREE.BufferGeometry();
    this.groundTrackMat = new THREE.LineBasicMaterial({
      color: "#fbbf24",
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });
    this.groundTrackLine = new THREE.Line(this.groundTrackGeo, this.groundTrackMat);
    this.groundTrackLine.frustumCulled = false;
    this.groundTrackLine.renderOrder = 6;

    this.nadirLineGeo = new THREE.BufferGeometry();
    this.nadirLineGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(this.nadirPositions, 3)
    );
    this.nadirLineMat = new THREE.LineBasicMaterial({
      color: "#fbbf24",
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.nadirLine = new THREE.Line(this.nadirLineGeo, this.nadirLineMat);
    this.nadirLine.frustumCulled = false;
    this.nadirLine.visible = false;
    this.nadirLine.renderOrder = 6;

    this.allOrbitsGeo = new THREE.BufferGeometry();
    this.allOrbitsMat = new THREE.LineBasicMaterial({
      color: "#94a3b8",
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    this.allOrbitsLine = new THREE.LineSegments(this.allOrbitsGeo, this.allOrbitsMat);
    this.allOrbitsLine.frustumCulled = false;
    this.allOrbitsLine.visible = false;
    this.allOrbitsLine.renderOrder = 5;

    // Subtle planetary Earthshine / albedo bounce rim fill light active ONLY during 3D satellite inspection
    this.earthshineLight = new THREE.PointLight("#7ec8ff", 1.55, 360, 0);
    this.earthshineLight.visible = false;

    this.planetCenterLinesRoot.add(
      this.allOrbitsLine,
      this.groundTrackLine,
      this.selectedOrbitLine
    );
    this.group.add(
      this.planetCenterLinesRoot,
      this.nadirLine,
      this.spacecraftRoot,
      this.markersRoot,
      this.earthshineLight
    );

    this.rebuildCatalogForPlanet(initialPlanet, initialSite);
  }

  /** Kicks off respectful non-blocking CelesTrak OMM/GP refresh (honoring 2-hour cache). */
  startInitialLiveSync(): void {
    if (this.liveRefreshStarted) return;
    this.liveRefreshStarted = true;
    void this.refreshLiveData(false);
  }

  async refreshLiveData(force = true): Promise<OrbitalProvenanceSummary> {
    this.provenance = {
      ...this.provenance,
      fetching: true,
      lastError: null,
    };

    const result = await fetchCelesTrakGpSnapshot({ force });
    if (result.recordsByNorad.size > 0) {
      this.liveOmmByNorad = new Map(result.recordsByNorad);
    }

    const totalCatalogCount = getSatelliteDefinitionsForPlanet("earth").filter(
      (d) => d.noradId !== null
    ).length;

    this.provenance = {
      dataSource:
        result.recordsByNorad.size > 0
          ? result.dataSource
          : this.liveOmmByNorad.size > 0
            ? "cached_celestrak"
            : "simulated",
      lastUpdatedUtc: result.lastUpdatedUtc,
      liveCount: this.liveOmmByNorad.size,
      totalCatalogCount,
      fetching: false,
      lastError: result.errorMessage,
    };

    if (this.activePlanet.id === "earth" && result.recordsByNorad.size > 0) {
      this.applyLiveOmmToCurrentEntries(result.dataSource, result.lastUpdatedUtc);
    }

    return this.provenance;
  }

  private applyLiveOmmToCurrentEntries(
    source: OrbitalDataSource,
    updatedUtc: string
  ): void {
    for (const item of this.managed) {
      const nid = item.entry.def.noradId;
      if (nid === null) continue;
      const omm = this.liveOmmByNorad.get(nid);
      if (!omm) continue;
      const fresh = createRuntimeSatelliteEntry(item.entry.def, omm, source, updatedUtc);
      item.entry.satrec = fresh.satrec;
      item.entry.ommEpochMs = fresh.ommEpochMs;
      item.entry.tleEpochUtc = fresh.tleEpochUtc;
      item.entry.dataSource = fresh.dataSource;
      item.entry.lastUpdatedUtc = fresh.lastUpdatedUtc;
      item.entry.inclinationDeg = fresh.inclinationDeg;
      item.entry.periodMin = fresh.periodMin;
      item.entry.apogeeKm = fresh.apogeeKm;
      item.entry.perigeeKm = fresh.perigeeKm;
    }
    this.linesDirty = true;
  }

  setPlanet(planet: PlanetConfig, site: LaunchSiteConfig): void {
    this.activePlanet = planet;
    this.activeSite = site;
    this.zenithQuat.copy(computeLaunchSiteZenithQuaternion(site.latDeg, site.lonDeg));
    this.inspectedId = null;
    this.rebuildCatalogForPlanet(planet, site);
  }

  setLaunchSite(site: LaunchSiteConfig): void {
    this.activeSite = site;
    this.zenithQuat.copy(computeLaunchSiteZenithQuaternion(site.latDeg, site.lonDeg));
    this.linesDirty = true;
    this.evaluateAllSnapshots(this.getCurrentSimDate());
  }

  setVisibilityOptions(next: Partial<OrbitalVisibilityOptions>): void {
    const prevAll = this.visibility.showAllOrbitRings;
    this.visibility = { ...this.visibility, ...next };
    if (this.visibility.showAllOrbitRings && !prevAll) {
      this.linesDirty = true;
    }
  }

  getVisibilityOptions(): OrbitalVisibilityOptions {
    return this.visibility;
  }

  getProvenance(): OrbitalProvenanceSummary {
    if (this.activePlanet.id !== "earth") {
      return {
        dataSource: "simulated",
        lastUpdatedUtc: this.provenance.lastUpdatedUtc,
        liveCount: 0,
        totalCatalogCount: this.managed.length,
        fetching: false,
        lastError: null,
      };
    }
    return this.provenance;
  }

  setSelectedId(id: string): SatelliteStateSnapshot | null {
    const found = this.managed.find((m) => m.entry.def.id === id);
    if (!found) return null;
    if (this.selectedId !== id) {
      this.selectedId = id;
      this.linesDirty = true;
    }
    return found.snapshot;
  }

  getSelectedId(): string {
    return this.selectedId;
  }

  setInspectedId(id: string | null): void {
    if (id && !this.managed.some((m) => m.entry.def.id === id)) {
      this.inspectedId = null;
      return;
    }
    this.inspectedId = id;
    if (id) {
      this.setSelectedId(id);
    }
  }

  getInspectedId(): string | null {
    return this.inspectedId;
  }

  getSelectedSnapshot(): SatelliteStateSnapshot | null {
    return this.managed.find((m) => m.entry.def.id === this.selectedId)?.snapshot ?? null;
  }

  getInspectedSnapshot(): SatelliteStateSnapshot | null {
    if (!this.inspectedId) return null;
    return this.managed.find((m) => m.entry.def.id === this.inspectedId)?.snapshot ?? null;
  }

  getSnapshots(): readonly SatelliteStateSnapshot[] {
    const list: SatelliteStateSnapshot[] = [];
    for (const m of this.managed) {
      if (m.snapshot) list.push(m.snapshot);
    }
    return list;
  }

  getPrimaryStationWorldPosition(out = new THREE.Vector3()): THREE.Vector3 | null {
    const primaryId = getPrimaryStationIdForPlanet(this.activePlanet.id);
    const found = this.managed.find((m) => m.entry.def.id === primaryId);
    if (!found?.snapshot) return null;
    const p = found.snapshot.worldPos;
    return out.set(p.x, p.y, p.z);
  }

  getInspectedWorldPosition(out = new THREE.Vector3()): {
    pos: THREE.Vector3;
    inspectRadiusM: number;
  } | null {
    const snap = this.getInspectedSnapshot();
    if (!snap) return null;
    out.set(snap.worldPos.x, snap.worldPos.y, snap.worldPos.z);
    return { pos: out, inspectRadiusM: snap.inspectRadiusM };
  }

  getCurrentSimDate(): Date {
    return new Date(Date.now() + this.simEpochOffsetMs);
  }

  private clearManaged(): void {
    this.spacecraftRoot.clear();
    this.markersRoot.clear();
    if (this.beaconInst) {
      this.beaconInst.dispose();
      this.beaconInst = null;
    }
    for (const m of this.managed) {
      if (m.labelSprite) {
        m.labelSprite.texture.dispose();
        m.labelSprite.material.dispose();
      }
    }
    for (const item of this.meshDisposables) {
      item.dispose();
    }
    this.meshDisposables.length = 0;
    this.managed = [];
  }

  private trackMeshGeom = <T extends THREE.BufferGeometry>(g: T): T => {
    this.meshDisposables.push(g);
    return g;
  };

  private shouldShowLabelByDefault(def: SatelliteDefinition): boolean {
    if (def.category === "starlink") {
      return def.id === "starlink_1";
    }
    return true;
  }

  private rebuildCatalogForPlanet(planet: PlanetConfig, site: LaunchSiteConfig): void {
    this.clearManaged();
    const defs = getSatelliteDefinitionsForPlanet(planet.id);
    this.selectedId = getPrimaryStationIdForPlanet(planet.id);

    this.beaconInst = new THREE.InstancedMesh(
      this.beaconGeo,
      this.beaconMat,
      Math.max(1, defs.length)
    );
    this.beaconInst.frustumCulled = false;
    this.beaconInst.renderOrder = 11;
    this.markersRoot.add(this.beaconInst);

    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      const liveOmm =
        planet.id === "earth" && def.noradId !== null
          ? this.liveOmmByNorad.get(def.noradId)
          : undefined;
      const source: OrbitalDataSource = liveOmm ? this.provenance.dataSource : "simulated";
      const entry = createRuntimeSatelliteEntry(
        def,
        liveOmm,
        source,
        this.provenance.lastUpdatedUtc
      );
      const { group: meshGroup, strobes } = buildDetailedSpacecraftMesh(
        def.meshStyle,
        planet.id,
        this.sharedMats,
        this.trackMeshGeom
      );
      meshGroup.visible = false;
      this.spacecraftRoot.add(meshGroup);

      const labelSprite = createSatelliteLabelSprite(def.accentHex, def.shortName);
      this.markersRoot.add(labelSprite.sprite);

      this.managed.push({
        entry,
        meshGroup,
        strobes,
        labelSprite,
        snapshot: null,
      });

      this.scratchColor.set(def.accentHex);
      this.beaconInst.setColorAt(i, this.scratchColor);
    }
    if (this.beaconInst.instanceColor) {
      this.beaconInst.instanceColor.needsUpdate = true;
    }

    this.activeSite = site;
    this.linesDirty = true;
    this.evaluateAllSnapshots(this.getCurrentSimDate());
  }

  private evaluateAllSnapshots(simDate: Date): void {
    const R = this.activePlanet.scale.simRadiusM;
    const padAlt = this.activeSite.elevationM;
    for (const item of this.managed) {
      item.snapshot = evaluateSatelliteSnapshot(
        item.entry,
        simDate,
        R,
        this.zenithQuat,
        padAlt
      );
    }
  }

  private rebuildOrbitLines(simDate: Date): void {
    const R = this.activePlanet.scale.simRadiusM;
    this.lastLineRebuildSimMs = simDate.getTime();
    this.linesDirty = false;

    const selected = this.managed.find((m) => m.entry.def.id === this.selectedId);
    if (selected) {
      const pathPts = sampleOrbitalPathPlanetCentered(
        selected.entry,
        simDate,
        R,
        this.zenithQuat,
        144
      );
      this.selectedOrbitGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(pathPts, 3)
      );
      this.selectedOrbitGeo.setDrawRange(0, pathPts.length / 3);
      this.selectedOrbitMat.color.set(selected.entry.def.accentHex);

      const gt = sampleGroundTrack(
        selected.entry,
        simDate,
        R,
        this.zenithQuat,
        240,
        GROUND_TRACK_OFFSET_M
      );
      this.groundTrackGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(gt.planetCenteredPoints, 3)
      );
      this.groundTrackGeo.setDrawRange(0, gt.planetCenteredPoints.length / 3);
    }

    if (this.visibility.showAllOrbitRings) {
      const segsPerOrbit = 72;
      const renderedEntries = this.managed.filter(
        (m) => m.entry.def.category !== "starlink" || m.entry.def.id === "starlink_1"
      );
      const totalFloats = renderedEntries.length * segsPerOrbit * 2 * 3;
      const buf = new Float32Array(totalFloats);
      let cursor = 0;
      for (const item of renderedEntries) {
        const ring = sampleOrbitalPathPlanetCentered(
          item.entry,
          simDate,
          R,
          this.zenithQuat,
          segsPerOrbit
        );
        for (let i = 0; i < segsPerOrbit; i++) {
          const i0 = i * 3;
          const i1 = (i + 1) * 3;
          buf[cursor++] = ring[i0];
          buf[cursor++] = ring[i0 + 1];
          buf[cursor++] = ring[i0 + 2];
          buf[cursor++] = ring[i1];
          buf[cursor++] = ring[i1 + 1];
          buf[cursor++] = ring[i1 + 2];
        }
      }
      this.allOrbitsGeo.setAttribute("position", new THREE.BufferAttribute(buf, 3));
      this.allOrbitsGeo.setDrawRange(0, buf.length / 3);
    }
  }

  update(
    dt: number,
    elapsedSec: number,
    timeWarp: number,
    simRunningAndUnpaused: boolean,
    camera: THREE.PerspectiveCamera,
    camAltM: number,
    cameraMode: string,
    renderOrigin: { readonly x: number; readonly y: number; readonly z: number }
  ): void {
    if (simRunningAndUnpaused && timeWarp > 1) {
      this.simEpochOffsetMs += dt * 1000 * (timeWarp - 1);
    }
    const simDate = this.getCurrentSimDate();
    this.evaluateAllSnapshots(simDate);

    const R = this.activePlanet.scale.simRadiusM;
    const isOrbitalView =
      cameraMode === "map" ||
      cameraMode === "station" ||
      this.inspectedId !== null ||
      camAltM > 28_000;

    if (!this.visibility.showSatellites && cameraMode !== "station" && this.inspectedId === null) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    // Rebuild full SGP4 orbital path & ground track only when dirty or every 15s of sim time
    if (
      isOrbitalView &&
      (this.linesDirty || Math.abs(simDate.getTime() - this.lastLineRebuildSimMs) > 15_000)
    ) {
      this.rebuildOrbitLines(simDate);
    }

    // Position planet-centered orbital lines with zero per-frame buffer rebuilds
    this.planetCenterLinesRoot.position.set(
      -renderOrigin.x,
      -R - renderOrigin.y,
      -renderOrigin.z
    );
    const showSpaceLines = this.visibility.showSatellites && isOrbitalView;
    this.selectedOrbitLine.visible = showSpaceLines;
    this.groundTrackLine.visible = showSpaceLines && this.visibility.showGroundTrack;
    this.allOrbitsLine.visible = showSpaceLines && this.visibility.showAllOrbitRings;

    const vFovScale = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    const strobePulse = Math.sin(elapsedSec * 4.2) > 0.72 ? 2.4 : 0.35;
    this.sharedMats.strobeRed.emissiveIntensity = strobePulse;
    this.sharedMats.strobeWhite.emissiveIntensity = strobePulse;

    const primaryStationId = getPrimaryStationIdForPlanet(this.activePlanet.id);
    const showBeacons = this.visibility.showSatellites && isOrbitalView;
    if (this.beaconInst) {
      this.beaconInst.visible = showBeacons;
    }

    let nadirShown = false;
    let earthshineShown = false;

    for (let i = 0; i < this.managed.length; i++) {
      const item = this.managed[i];
      const snap = item.snapshot;
      if (!snap) {
        item.meshGroup.visible = false;
        if (item.labelSprite) item.labelSprite.sprite.visible = false;
        continue;
      }

      const rx = snap.worldPos.x - renderOrigin.x;
      const ry = snap.worldPos.y - renderOrigin.y;
      const rz = snap.worldPos.z - renderOrigin.z;
      const distToCam = Math.hypot(
        camera.position.x - rx,
        camera.position.y - ry,
        camera.position.z - rz
      );

      const isSelected = snap.id === this.selectedId;
      const isInspected = snap.id === this.inspectedId;
      const isStationTarget = cameraMode === "station" && snap.id === primaryStationId;

      // Detailed 3D mesh visible only close up or when targeted (keeps pad draw calls unchanged!)
      const showMesh =
        isInspected || isStationTarget || (this.visibility.showSatellites && distToCam < 35_000);
      item.meshGroup.visible = showMesh;
      if (showMesh) {
        item.meshGroup.position.set(rx, ry, rz);
        // Orient spacecraft nose along velocity tangent, belly toward planet nadir
        this.scratchUp
          .set(snap.worldPos.x, snap.worldPos.y + R, snap.worldPos.z)
          .normalize();
        this.scratchFwd
          .set(snap.velocityDir.x, snap.velocityDir.y, snap.velocityDir.z)
          .normalize();
        this.scratchRight.crossVectors(this.scratchUp, this.scratchFwd);
        if (this.scratchRight.lengthSq() > 1e-6) {
          this.scratchRight.normalize();
          this.scratchUp.crossVectors(this.scratchFwd, this.scratchRight).normalize();
          this.scratchMat4.makeBasis(this.scratchRight, this.scratchUp, this.scratchFwd);
          this.scratchQuat.setFromRotationMatrix(this.scratchMat4);
          item.meshGroup.quaternion.copy(this.scratchQuat);
        }

        // Position subtle planetary Earthshine rim fill light on the actively inspected / station spacecraft
        if (isInspected || isStationTarget) {
          const rimColor =
            this.activePlanet.id === "earth"
              ? "#7ec8ff"
              : this.activePlanet.id === "mars"
                ? "#e8a878"
                : "#b8c0ce";
          this.earthshineLight.color.set(rimColor);
          this.earthshineLight.intensity = this.activePlanet.id === "moon" ? 1.15 : 1.65;
          const rimOffset = Math.max(24, snap.inspectRadiusM * 1.45);
          this.earthshineLight.position.set(
            rx - this.scratchUp.x * rimOffset + this.scratchRight.x * (rimOffset * 0.55),
            ry - this.scratchUp.y * rimOffset + this.scratchRight.y * (rimOffset * 0.55),
            rz - this.scratchUp.z * rimOffset + this.scratchRight.z * (rimOffset * 0.55)
          );
          this.earthshineLight.visible = true;
          earthshineShown = true;
        }
      }

      // Instanced orbital beacon dot (FOV-scaled so visible cleanly across LEO..GEO)
      if (this.beaconInst && showBeacons) {
        const hideDotBecauseClose = distToCam < 2_500;
        const beaconRadius = hideDotBecauseClose
          ? 0.0001
          : Math.max(450, distToCam * vFovScale * (isSelected ? 0.0155 : 0.0105));
        this.scratchDummy.position.set(rx, ry, rz);
        this.scratchDummy.rotation.set(elapsedSec * 0.4, elapsedSec * 0.6, 0);
        this.scratchDummy.scale.setScalar(beaconRadius);
        this.scratchDummy.updateMatrix();
        this.beaconInst.setMatrixAt(i, this.scratchDummy.matrix);
      }

      // Crisp screen-scale label sprite for flagship objects + active selection (hidden close-up or on pad)
      if (item.labelSprite) {
        const showLabel =
          showBeacons &&
          distToCam > 12_000 &&
          (isSelected || this.shouldShowLabelByDefault(item.entry.def));
        item.labelSprite.sprite.visible = showLabel;
        if (showLabel) {
          const labelH = distToCam * vFovScale * (isSelected ? 0.044 : 0.036);
          item.labelSprite.sprite.position.set(rx, ry, rz);
          item.labelSprite.sprite.scale.set(labelH * 4.4, labelH, 1);
          item.labelSprite.material.opacity = isSelected ? 1.0 : 0.84;
        }
      }

      // Subtle nadir drop line from selected satellite down to ground-track point
      if (isSelected && showSpaceLines && this.visibility.showGroundTrack) {
        const subWorld = geodeticToPlanetWorld(
          snap.latDeg,
          snap.lonDeg,
          GROUND_TRACK_OFFSET_M,
          R,
          this.zenithQuat,
          this.scratchPos
        );
        this.nadirPositions[0] = rx;
        this.nadirPositions[1] = ry;
        this.nadirPositions[2] = rz;
        this.nadirPositions[3] = subWorld.x - renderOrigin.x;
        this.nadirPositions[4] = subWorld.y - renderOrigin.y;
        this.nadirPositions[5] = subWorld.z - renderOrigin.z;
        const attr = this.nadirLineGeo.getAttribute("position") as THREE.BufferAttribute;
        attr.needsUpdate = true;
        this.nadirLine.visible = true;
        nadirShown = true;
      }
    }

    if (!nadirShown) {
      this.nadirLine.visible = false;
    }
    if (!earthshineShown) {
      this.earthshineLight.visible = false;
    }

    if (this.beaconInst && showBeacons) {
      this.beaconInst.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Raycasts / screen-picks orbital satellites on viewport click.
   * Respects planet sphere occlusion so satellites on the far side of Earth are never accidentally selected.
   */
  pickAtNdc(
    ndcX: number,
    ndcY: number,
    camera: THREE.PerspectiveCamera,
    viewportWidth: number,
    viewportHeight: number,
    renderOrigin: { readonly x: number; readonly y: number; readonly z: number }
  ): SatelliteStateSnapshot | null {
    if (!this.group.visible) return null;

    // 1. Direct 3D mesh raycast for close-up inspection
    this.ndcVec.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndcVec, camera);
    for (const item of this.managed) {
      if (!item.meshGroup.visible || !item.snapshot) continue;
      const hits = this.raycaster.intersectObject(item.meshGroup, true);
      if (hits.length > 0) {
        return item.snapshot;
      }
    }

    // 2. Screen-space hit radius against visible orbital beacons (with planet occlusion check)
    if (!this.beaconInst?.visible) return null;
    const R = this.activePlanet.scale.simRadiusM * 0.992;
    const centerRenderX = -renderOrigin.x;
    const centerRenderY = -this.activePlanet.scale.simRadiusM - renderOrigin.y;
    const centerRenderZ = -renderOrigin.z;
    this.scratchCamToCenter.set(
      centerRenderX - camera.position.x,
      centerRenderY - camera.position.y,
      centerRenderZ - camera.position.z
    );

    const clickPxX = (ndcX * 0.5 + 0.5) * viewportWidth;
    const clickPxY = (-ndcY * 0.5 + 0.5) * viewportHeight;
    const maxHitPx = 26;

    let bestSnap: SatelliteStateSnapshot | null = null;
    let bestPxDist = maxHitPx;

    for (const item of this.managed) {
      const snap = item.snapshot;
      if (!snap) continue;
      const rx = snap.worldPos.x - renderOrigin.x;
      const ry = snap.worldPos.y - renderOrigin.y;
      const rz = snap.worldPos.z - renderOrigin.z;

      this.scratchCamToSat.set(
        rx - camera.position.x,
        ry - camera.position.y,
        rz - camera.position.z
      );
      const satDist = this.scratchCamToSat.length();
      if (satDist < 1) continue;

      // Ray-sphere occlusion check against planet center
      const rayDirX = this.scratchCamToSat.x / satDist;
      const rayDirY = this.scratchCamToSat.y / satDist;
      const rayDirZ = this.scratchCamToSat.z / satDist;
      const projOnRay =
        this.scratchCamToCenter.x * rayDirX +
        this.scratchCamToCenter.y * rayDirY +
        this.scratchCamToCenter.z * rayDirZ;
      if (projOnRay > 0 && projOnRay < satDist) {
        const dSq = this.scratchCamToCenter.lengthSq() - projOnRay * projOnRay;
        if (dSq < R * R) {
          continue; // Occluded behind planet
        }
      }

      this.scratchProj.set(rx, ry, rz).project(camera);
      if (this.scratchProj.z < -1 || this.scratchProj.z > 1) continue;

      const pxX = (this.scratchProj.x * 0.5 + 0.5) * viewportWidth;
      const pxY = (-this.scratchProj.y * 0.5 + 0.5) * viewportHeight;
      const pxDist = Math.hypot(pxX - clickPxX, pxY - clickPxY);
      if (pxDist < bestPxDist) {
        bestPxDist = pxDist;
        bestSnap = snap;
      }
    }

    return bestSnap;
  }

  dispose(): void {
    this.clearManaged();
    this.beaconGeo.dispose();
    this.beaconMat.dispose();
    this.selectedOrbitGeo.dispose();
    this.selectedOrbitMat.dispose();
    this.groundTrackGeo.dispose();
    this.groundTrackMat.dispose();
    this.nadirLineGeo.dispose();
    this.nadirLineMat.dispose();
    this.allOrbitsGeo.dispose();
    this.allOrbitsMat.dispose();
    Object.values(this.sharedMats).forEach((m) => m.dispose());
  }
}
