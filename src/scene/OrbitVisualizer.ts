import * as THREE from "three";
import type { PlanetConfig } from "../config/planets";
import type { FlightTelemetry } from "../sim/FlightController";
import { computeGravitationalParameter, sampleOrbitPoints } from "../sim/OrbitalMechanics";

const MAX_TRAJECTORY_POINTS = 200;
const MAX_BOOSTER_ARC_POINTS = 48;
const MAX_TRAIL_POINTS = 600;
const TARGET_RING_SEGMENTS = 180;

interface MarkerSpriteEntry {
  readonly sprite: THREE.Sprite;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.SpriteMaterial;
  lastLabel: string;
}

function createMarkerSprite(accentHex: string, initialText: string): MarkerSpriteEntry {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to acquire 2D canvas context for orbit marker sprite");
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 12;

  const entry: MarkerSpriteEntry = {
    sprite,
    canvas,
    ctx,
    texture,
    material,
    lastLabel: "",
  };
  drawMarkerCanvas(entry, accentHex, initialText);
  return entry;
}

function drawMarkerCanvas(
  entry: MarkerSpriteEntry,
  accentHex: string,
  labelText: string
): void {
  const key = `${accentHex}|${labelText}`;
  if (entry.lastLabel === key) {
    return;
  }
  entry.lastLabel = key;
  const { ctx, canvas } = entry;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cx = 28;
  const cy = 32;
  ctx.save();
  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 3.5;
  ctx.fillStyle = "rgba(6, 12, 24, 0.85)";
  ctx.beginPath();
  ctx.moveTo(cx, cy - 13);
  ctx.lineTo(cx + 13, cy);
  ctx.lineTo(cx, cy + 13);
  ctx.lineTo(cx - 13, cy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = accentHex;
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = "700 22px Consolas, 'Cascadia Mono', monospace";
  const textW = Math.min(182, Math.ceil(ctx.measureText(labelText).width));
  const pillX = 50;
  const pillY = 12;
  const pillW = textW + 20;
  const pillH = 40;

  ctx.fillStyle = "rgba(6, 12, 24, 0.86)";
  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillW, pillH, 8);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#f1f5f9";
  ctx.textBaseline = "middle";
  ctx.fillText(labelText, pillX + 10, cy + 1, 182);
  ctx.restore();

  entry.texture.needsUpdate = true;
}

function updateMarkerScreenScale(
  entry: MarkerSpriteEntry,
  camera: THREE.PerspectiveCamera
): void {
  const dist = camera.position.distanceTo(entry.sprite.position);
  const vFovScale = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const h = dist * vFovScale * 0.048;
  entry.sprite.scale.set(h * 3.4, h, 1);
}

/**
 * Renders the 3D Target Parking Orbit Ring, Live Predicted Keplerian Trajectory Arc,
 * Booster RTLS Return Arc, Spacecraft Flight Trail, and screen-scale orbital markers.
 */
export class OrbitVisualizer {
  public readonly group = new THREE.Group();

  private targetRingGeo: THREE.BufferGeometry | null = null;
  private readonly targetRingMat: THREE.LineDashedMaterial;
  private targetRingLine: THREE.Line | null = null;

  private readonly predictedPositions = new Float32Array(MAX_TRAJECTORY_POINTS * 3);
  private readonly predictedGeo: THREE.BufferGeometry;
  private readonly predictedMat: THREE.LineBasicMaterial;
  private readonly predictedLine: THREE.Line;

  private readonly boosterArcPositions = new Float32Array(MAX_BOOSTER_ARC_POINTS * 3);
  private readonly boosterArcGeo: THREE.BufferGeometry;
  private readonly boosterArcMat: THREE.LineDashedMaterial;
  private readonly boosterArcLine: THREE.Line;

  private readonly trailWorld = new Float64Array(MAX_TRAIL_POINTS * 3);
  private readonly trailPositions = new Float32Array(MAX_TRAIL_POINTS * 3);
  private trailCount = 0;
  private lastTrailPos = new THREE.Vector3();
  private readonly trailGeo: THREE.BufferGeometry;
  private readonly trailMat: THREE.LineBasicMaterial;
  private readonly trailLine: THREE.Line;

  private readonly shipMarker: MarkerSpriteEntry;
  private readonly boosterMarker: MarkerSpriteEntry;
  private readonly apMarker: MarkerSpriteEntry;
  private readonly peMarker: MarkerSpriteEntry;
  private readonly padMarker: MarkerSpriteEntry;

  private activeConfig: PlanetConfig;
  private siteShortName = "STARBASE";
  private enabled = true;
  private prevRunning = false;
  private readonly scratchShipWorldPos = new THREE.Vector3();
  private readonly scratchShipPos = new THREE.Vector3();
  private readonly scratchPadPos = new THREE.Vector3();
  private readonly scratchBoosterPos = new THREE.Vector3();

  constructor(initialConfig: PlanetConfig) {
    this.activeConfig = initialConfig;

    this.targetRingMat = new THREE.LineDashedMaterial({
      color: "#38bdf8",
      transparent: true,
      opacity: 0.45,
      dashSize: 1600,
      gapSize: 1100,
      depthWrite: false,
    });

    this.predictedGeo = new THREE.BufferGeometry();
    this.predictedGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(this.predictedPositions, 3)
    );
    this.predictedGeo.setDrawRange(0, 0);
    this.predictedMat = new THREE.LineBasicMaterial({
      color: "#f59e0b",
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.predictedLine = new THREE.Line(this.predictedGeo, this.predictedMat);
    this.predictedLine.frustumCulled = false;

    this.boosterArcGeo = new THREE.BufferGeometry();
    this.boosterArcGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(this.boosterArcPositions, 3)
    );
    this.boosterArcMat = new THREE.LineDashedMaterial({
      color: "#fb923c",
      transparent: true,
      opacity: 0.85,
      dashSize: 420,
      gapSize: 260,
      depthWrite: false,
    });
    this.boosterArcLine = new THREE.Line(this.boosterArcGeo, this.boosterArcMat);
    this.boosterArcLine.frustumCulled = false;
    this.boosterArcLine.visible = false;

    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(this.trailPositions, 3)
    );
    this.trailGeo.setDrawRange(0, 0);
    this.trailMat = new THREE.LineBasicMaterial({
      color: "#93c5fd",
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    this.trailLine = new THREE.Line(this.trailGeo, this.trailMat);
    this.trailLine.frustumCulled = false;

    this.shipMarker = createMarkerSprite("#38bdf8", "STARSHIP");
    this.boosterMarker = createMarkerSprite("#fb923c", "BOOSTER");
    this.apMarker = createMarkerSprite("#34d399", "AP");
    this.peMarker = createMarkerSprite("#fbbf24", "PE");
    this.padMarker = createMarkerSprite("#cbd5e1", "PAD");

    this.group.add(
      this.predictedLine,
      this.boosterArcLine,
      this.trailLine,
      this.shipMarker.sprite,
      this.boosterMarker.sprite,
      this.apMarker.sprite,
      this.peMarker.sprite,
      this.padMarker.sprite
    );

    this.updatePlanet(initialConfig);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.group.visible = enabled;
  }

  setSiteShortName(name: string): void {
    this.siteShortName = name;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  resetTrail(): void {
    this.trailCount = 0;
    this.trailGeo.setDrawRange(0, 0);
    this.prevRunning = false;
  }

  updatePlanet(config: PlanetConfig): void {
    this.activeConfig = config;
    if (this.targetRingLine) {
      this.group.remove(this.targetRingLine);
      this.targetRingLine = null;
    }
    this.targetRingGeo?.dispose();

    const R = config.scale.simRadiusM;
    const orbitR = R + config.scale.targetOrbitAltM;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= TARGET_RING_SEGMENTS; i++) {
      const ang = (i / TARGET_RING_SEGMENTS) * Math.PI * 2;
      pts.push(
        new THREE.Vector3(Math.sin(ang) * orbitR, Math.cos(ang) * orbitR - R, 0)
      );
    }
    this.targetRingGeo = new THREE.BufferGeometry().setFromPoints(pts);
    this.targetRingMat.dashSize = orbitR * 0.045;
    this.targetRingMat.gapSize = orbitR * 0.025;
    this.targetRingLine = new THREE.Line(this.targetRingGeo, this.targetRingMat);
    this.targetRingLine.computeLineDistances();
    this.targetRingLine.frustumCulled = false;
    this.group.add(this.targetRingLine);

    this.resetTrail();
  }

  private appendTrailPoint(x: number, y: number, z: number): void {
    if (this.trailCount >= MAX_TRAIL_POINTS) {
      let dst = 0;
      for (let src = 0; src < MAX_TRAIL_POINTS; src += 2) {
        this.trailWorld[dst * 3] = this.trailWorld[src * 3];
        this.trailWorld[dst * 3 + 1] = this.trailWorld[src * 3 + 1];
        this.trailWorld[dst * 3 + 2] = this.trailWorld[src * 3 + 2];
        dst += 1;
      }
      this.trailCount = dst;
    }
    const off = this.trailCount * 3;
    this.trailWorld[off] = x;
    this.trailWorld[off + 1] = y;
    this.trailWorld[off + 2] = z;
    this.trailCount += 1;
    this.lastTrailPos.set(x, y, z);
    this.trailGeo.setDrawRange(0, this.trailCount);
  }

  private updateBoosterReturnArc(
    tel: FlightTelemetry,
    R: number,
    mu: number,
    origin: { readonly x: number; readonly y: number; readonly z: number }
  ): void {
    let bx = tel.booster.position.x;
    let by = tel.booster.position.y;
    let bz = tel.booster.position.z;
    let vx = tel.booster.velocity.x;
    let vy = tel.booster.velocity.y;
    let vz = tel.booster.velocity.z;

    const dtStep = 4.5;
    let impacted = false;
    for (let i = 0; i < MAX_BOOSTER_ARC_POINTS; i++) {
      this.boosterArcPositions[i * 3] = bx - origin.x;
      this.boosterArcPositions[i * 3 + 1] = by - origin.y;
      this.boosterArcPositions[i * 3 + 2] = bz - origin.z;
      if (impacted) {
        continue;
      }
      const rx = bx;
      const ry = by + R;
      const rz = bz;
      const rMag = Math.max(1, Math.hypot(rx, ry, rz));
      const invR3 = -mu / (rMag * rMag * rMag);
      vx += rx * invR3 * dtStep;
      vy += ry * invR3 * dtStep;
      vz += rz * invR3 * dtStep;
      bx += vx * dtStep;
      by += vy * dtStep;
      bz += vz * dtStep;
      const nextR = Math.hypot(bx, by + R, bz);
      if (nextR <= R + tel.padDeckY) {
        const s = (R + tel.padDeckY) / Math.max(1, nextR);
        bx *= s;
        by = (by + R) * s - R;
        bz *= s;
        impacted = true;
      }
    }

    const attr = this.boosterArcGeo.getAttribute("position") as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.boosterArcLine.computeLineDistances();
  }

  update(
    tel: FlightTelemetry,
    camera: THREE.PerspectiveCamera,
    camAltM: number,
    renderOrigin: { readonly x: number; readonly y: number; readonly z: number } = {
      x: 0,
      y: 0,
      z: 0,
    }
  ): void {
    const showInMode = this.enabled && tel.missionMode === "launch";
    this.group.visible = showInMode;
    if (!showInMode) {
      return;
    }

    const R = this.activeConfig.scale.simRadiusM;
    const mu = computeGravitationalParameter(this.activeConfig.physics.gravityMps2, R);

    const shipWorldPos = this.scratchShipWorldPos.set(tel.position.x, tel.position.y, tel.position.z);
    const shipRenderPos = this.scratchShipPos.set(
      tel.position.x - renderOrigin.x,
      tel.position.y - renderOrigin.y,
      tel.position.z - renderOrigin.z
    );
    const padRenderPos = this.scratchPadPos.set(
      -renderOrigin.x,
      tel.padDeckY - renderOrigin.y,
      -renderOrigin.z
    );

    if (tel.running && tel.phase !== "PRELAUNCH" && tel.phase !== "COUNTDOWN") {
      if (!this.prevRunning || this.trailCount === 0) {
        this.appendTrailPoint(tel.position.x, tel.position.y, tel.position.z);
      } else {
        const minSpacing = Math.max(250, tel.altitudeM * 0.015);
        if (this.lastTrailPos.distanceTo(shipWorldPos) >= minSpacing) {
          this.appendTrailPoint(tel.position.x, tel.position.y, tel.position.z);
        }
      }
      this.prevRunning = true;
    } else if (!tel.running && tel.phase === "PRELAUNCH") {
      if (this.trailCount > 0) {
        this.resetTrail();
      }
    }

    const camDistToShip = camera.position.distanceTo(shipRenderPos);
    const camDistToPad = camera.position.distanceTo(padRenderPos);
    const showOverview = camAltM > 14_000 || camDistToPad > 18_000 || tel.altitudeM > 10_000;

    if (this.targetRingLine) {
      this.targetRingLine.position.set(-renderOrigin.x, -renderOrigin.y, -renderOrigin.z);
      this.targetRingLine.visible = showOverview;
    }
    this.trailLine.visible = showOverview && this.trailCount >= 2;
    if (this.trailLine.visible) {
      for (let i = 0; i < this.trailCount; i++) {
        const o = i * 3;
        this.trailPositions[o] = this.trailWorld[o] - renderOrigin.x;
        this.trailPositions[o + 1] = this.trailWorld[o + 1] - renderOrigin.y;
        this.trailPositions[o + 2] = this.trailWorld[o + 2] - renderOrigin.z;
      }
      const attr = this.trailGeo.getAttribute("position") as THREE.BufferAttribute;
      attr.needsUpdate = true;
    }

    const showArc =
      tel.altitudeM > 1500 &&
      tel.phase !== "PRELAUNCH" &&
      tel.phase !== "COUNTDOWN" &&
      tel.phase !== "CRASHED";
    this.predictedLine.visible = showArc && showOverview;
    if (this.predictedLine.visible) {
      const pts = sampleOrbitPoints(tel.position, tel.velocity, R, mu, MAX_TRAJECTORY_POINTS - 2);
      const count = Math.min(MAX_TRAJECTORY_POINTS, pts.length);
      for (let i = 0; i < count; i++) {
        this.predictedPositions[i * 3] = pts[i].x - renderOrigin.x;
        this.predictedPositions[i * 3 + 1] = pts[i].y - renderOrigin.y;
        this.predictedPositions[i * 3 + 2] = pts[i].z - renderOrigin.z;
      }
      const attr = this.predictedGeo.getAttribute("position") as THREE.BufferAttribute;
      attr.needsUpdate = true;
      this.predictedGeo.setDrawRange(0, count);

      if (tel.orbital.orbitAchieved) {
        this.predictedMat.color.set("#34d399");
      } else if (tel.orbital.periapsisAltM > 0) {
        this.predictedMat.color.set("#38bdf8");
      } else {
        this.predictedMat.color.set("#f59e0b");
      }
    }

    // Booster RTLS dashed return arc
    const showBoosterArc =
      showOverview &&
      tel.stageSeparated &&
      tel.booster.active &&
      tel.booster.altitudeM > 150;
    this.boosterArcLine.visible = showBoosterArc;
    if (showBoosterArc) {
      this.updateBoosterReturnArc(tel, R, mu, renderOrigin);
    }

    // Strict SHIP distance threshold (>= 2500m) prevents oversized billboard sprite in close-up views
    const showShip = camDistToShip >= 2500;
    this.shipMarker.sprite.visible = showShip;
    if (showShip) {
      this.shipMarker.sprite.position.copy(shipRenderPos);
      const altLabel =
        tel.altitudeM >= 1000
          ? `SHIP ${(tel.altitudeM / 1000).toFixed(1)}km`
          : `SHIP ${tel.altitudeM.toFixed(0)}m`;
      drawMarkerCanvas(this.shipMarker, tel.orbital.orbitAchieved ? "#34d399" : "#38bdf8", altLabel);
      updateMarkerScreenScale(this.shipMarker, camera);
    }

    // Compact BOOSTER beacon when separated and viewed from >= 2500m
    const bRenderPos = this.scratchBoosterPos.set(
      tel.booster.position.x - renderOrigin.x,
      tel.booster.position.y - renderOrigin.y,
      tel.booster.position.z - renderOrigin.z
    );
    const camDistToBooster = camera.position.distanceTo(bRenderPos);
    const showBoosterMarker =
      tel.stageSeparated &&
      tel.booster.status !== "NONE" &&
      tel.booster.status !== "BOOSTER_CRASHED" &&
      camDistToBooster >= 2500;
    this.boosterMarker.sprite.visible = showBoosterMarker;
    if (showBoosterMarker) {
      this.boosterMarker.sprite.position.copy(bRenderPos);
      const bText =
        tel.booster.status === "BOOSTER_CAUGHT"
          ? "BSTR CAUGHT"
          : tel.booster.status === "BOOSTER_LANDED"
            ? "BSTR LANDED"
            : tel.booster.altitudeM >= 1000
              ? `BSTR ${(tel.booster.altitudeM / 1000).toFixed(1)}km`
              : `BSTR ${tel.booster.altitudeM.toFixed(0)}m`;
      const bColor =
        tel.booster.status === "BOOSTER_CAUGHT" || tel.booster.status === "BOOSTER_LANDED"
          ? "#34d399"
          : "#fb923c";
      drawMarkerCanvas(this.boosterMarker, bColor, bText);
      updateMarkerScreenScale(this.boosterMarker, camera);
    }

    const showPad = camDistToPad > 15_000;
    this.padMarker.sprite.visible = showPad;
    if (showPad) {
      this.padMarker.sprite.position.copy(padRenderPos);
      const padLabel =
        this.activeConfig.id === "earth"
          ? `${this.siteShortName} PAD`
          : `${this.activeConfig.name} PAD`;
      drawMarkerCanvas(this.padMarker, "#cbd5e1", padLabel);
      updateMarkerScreenScale(this.padMarker, camera);
    }

    const orb = tel.orbital;
    const showAp =
      showOverview &&
      tel.altitudeM > 5000 &&
      orb.isBoundOrbit &&
      orb.apoapsisWorldPos !== null &&
      Number.isFinite(orb.apoapsisAltM) &&
      orb.apoapsisAltM > 500;
    this.apMarker.sprite.visible = showAp;
    if (showAp && orb.apoapsisWorldPos) {
      this.apMarker.sprite.position.set(
        orb.apoapsisWorldPos.x - renderOrigin.x,
        orb.apoapsisWorldPos.y - renderOrigin.y,
        orb.apoapsisWorldPos.z - renderOrigin.z
      );
      drawMarkerCanvas(this.apMarker, "#34d399", `AP ${(orb.apoapsisAltM / 1000).toFixed(1)} km`);
      updateMarkerScreenScale(this.apMarker, camera);
    }

    const showPe =
      showOverview &&
      tel.altitudeM > 5000 &&
      orb.isBoundOrbit &&
      orb.periapsisWorldPos !== null &&
      orb.periapsisAltM > 0;
    this.peMarker.sprite.visible = showPe;
    if (showPe && orb.periapsisWorldPos) {
      this.peMarker.sprite.position.set(
        orb.periapsisWorldPos.x - renderOrigin.x,
        orb.periapsisWorldPos.y - renderOrigin.y,
        orb.periapsisWorldPos.z - renderOrigin.z
      );
      drawMarkerCanvas(this.peMarker, "#fbbf24", `PE ${(orb.periapsisAltM / 1000).toFixed(1)} km`);
      updateMarkerScreenScale(this.peMarker, camera);
    }
  }

  dispose(): void {
    this.targetRingGeo?.dispose();
    this.targetRingMat.dispose();
    this.predictedGeo.dispose();
    this.predictedMat.dispose();
    this.boosterArcGeo.dispose();
    this.boosterArcMat.dispose();
    this.trailGeo.dispose();
    this.trailMat.dispose();
    for (const m of [
      this.shipMarker,
      this.boosterMarker,
      this.apMarker,
      this.peMarker,
      this.padMarker,
    ]) {
      m.texture.dispose();
      m.material.dispose();
    }
  }
}
