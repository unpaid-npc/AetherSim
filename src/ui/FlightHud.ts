import { getVehicleConfig } from "../config/vehicles";
import type { SceneTelemetry } from "../scene/SceneManager";
import { el } from "./dom";
import {
  formatAltitude,
  formatBoosterStatusLabel,
  formatCompactAltitude,
  formatDynamicPressure,
  formatOrbitalAltitude,
  formatSignedVelocity,
  formatSpeed,
  formatTClock,
} from "./formatters";

const SVG_NS = "http://www.w3.org/2000/svg";
const ARC_LENGTH = 2 * Math.PI * 17 * 0.75; // 270° radial dial circumference

interface ArcGaugeHandles {
  root: HTMLDivElement;
  fillCircle: SVGCircleElement;
  centerEl: HTMLSpanElement;
  readoutEl: HTMLSpanElement;
}

function createArcGauge(label: string, toneClass = ""): ArcGaugeHandles {
  const root = el("div", "arc-gauge");
  const ring = el("div", "arc-gauge-ring");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 44 44");
  svg.setAttribute("class", "arc-gauge-svg");
  svg.setAttribute("aria-hidden", "true");

  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("cx", "22");
  track.setAttribute("cy", "22");
  track.setAttribute("r", "17");
  track.setAttribute("class", "arc-track");
  track.setAttribute("stroke-dasharray", `${ARC_LENGTH.toFixed(2)} 140`);

  const fillCircle = document.createElementNS(SVG_NS, "circle");
  fillCircle.setAttribute("cx", "22");
  fillCircle.setAttribute("cy", "22");
  fillCircle.setAttribute("r", "17");
  fillCircle.setAttribute("class", `arc-fill ${toneClass}`.trim());
  fillCircle.setAttribute("stroke-dasharray", `${ARC_LENGTH.toFixed(2)} 140`);
  fillCircle.setAttribute("stroke-dashoffset", ARC_LENGTH.toFixed(2));

  svg.append(track, fillCircle);
  const centerEl = el("span", "arc-center-val tabular", "0");
  ring.append(svg, centerEl);

  const meta = el("div", "arc-meta");
  const readoutEl = el("span", "telemetry-value tabular", "-");
  meta.append(el("span", "telemetry-label", label), readoutEl);

  root.append(ring, meta);
  return { root, fillCircle, centerEl, readoutEl };
}

function setArcFraction(circle: SVGCircleElement, fraction: number): void {
  const f = Math.max(0, Math.min(1, fraction));
  const offset = ARC_LENGTH * (1 - f);
  circle.style.strokeDashoffset = offset.toFixed(2);
}

/** SpaceX-webcast-inspired bottom telemetry strip with radial arc gauges & orbital readout. */
export class FlightHud {
  public readonly root: HTMLElement;

  private readonly tClockEl: HTMLSpanElement;
  private readonly phaseBadgeEl: HTMLSpanElement;
  private readonly atmoLayerEl: HTMLSpanElement;

  private readonly spdGauge: ArcGaugeHandles;
  private readonly altGauge: ArcGaugeHandles;
  private readonly thrGauge: ArcGaugeHandles;

  private readonly vyValEl: HTMLSpanElement;
  private readonly gValEl: HTMLSpanElement;
  private readonly qValEl: HTMLSpanElement;
  private readonly downrangeValEl: HTMLSpanElement;

  private readonly boosterLabelEl: HTMLSpanElement;
  private readonly boosterFill: HTMLDivElement;
  private readonly boosterPct: HTMLSpanElement;
  private readonly shipLabelEl: HTMLSpanElement;
  private readonly shipFill: HTMLDivElement;
  private readonly shipPct: HTMLSpanElement;
  private readonly sideWrapEl: HTMLDivElement;
  private readonly sideLabelEl: HTMLSpanElement;
  private readonly sideFill: HTMLDivElement;
  private readonly sidePct: HTMLSpanElement;

  private readonly boosterRtlsPill: HTMLSpanElement;
  private readonly verdictBanner: HTMLDivElement;

  private readonly orbitalRow: HTMLDivElement;
  private readonly apValEl: HTMLSpanElement;
  private readonly peValEl: HTMLSpanElement;
  private readonly eccValEl: HTMLSpanElement;
  private readonly periodValEl: HTMLSpanElement;
  private readonly targetOrbValEl: HTMLSpanElement;

  private readonly fpsStrong: HTMLElement;
  private readonly drawStrong: HTMLElement;
  private readonly faultStrong: HTMLElement;
  private readonly gpuStrong: HTMLElement;

  constructor(isElectron: boolean, initialRendererName: string) {
    this.root = el("footer", "glass-panel flight-hud");

    const mainRow = el("div", "flight-hud-main");

    // Clock, Phase & Atmospheric Layer Badge
    const clockCluster = el("div", "hud-clock-cluster");
    this.tClockEl = el("span", "tclock-label tabular", "T-00:10.0");
    this.phaseBadgeEl = el("span", "phase-badge", "PRELAUNCH");
    this.atmoLayerEl = el("span", "atmo-layer-badge tabular", "TROPOSPHERE");
    clockCluster.append(this.tClockEl, this.phaseBadgeEl, this.atmoLayerEl);

    // 3 Radial Arc Gauges
    const gaugesRow = el("div", "arc-gauges-row");
    this.spdGauge = createArcGauge("SPEED");
    this.altGauge = createArcGauge("ALTITUDE", "ok");
    this.thrGauge = createArcGauge("THROTTLE", "warn");
    gaugesRow.append(this.spdGauge.root, this.altGauge.root, this.thrGauge.root);

    // Compact Inline Metrics
    const inlineRow = el("div", "readouts-inline");
    const makeReadout = (label: string) => {
      const item = el("div", "telemetry-item");
      const val = el("span", "telemetry-value tabular", "-");
      item.append(el("span", "telemetry-label", label), val);
      inlineRow.append(item);
      return val;
    };
    this.vyValEl = makeReadout("VERT VEL");
    this.gValEl = makeReadout("G-LOAD");
    this.qValEl = makeReadout("DYN PRESS");
    this.downrangeValEl = makeReadout("DOWNRANGE");

    // Propellant Bars
    const fuelInline = el("div", "fuel-bars-inline");
    const makeFuelMini = (label: string) => {
      const wrap = el("div", "fuel-mini");
      const labelEl = el("span", undefined, label);
      const track = el("div", "fuel-track");
      const fill = el("div", "fuel-fill");
      fill.style.width = "100%";
      track.append(fill);
      const pct = el("span", "tabular", "100%");
      wrap.append(labelEl, track, pct);
      fuelInline.append(wrap);
      return { wrap, labelEl, fill, pct };
    };
    const sideBar = makeFuelMini("S200×2");
    sideBar.wrap.style.display = "none";
    const bBar = makeFuelMini("BSTR");
    const sBar = makeFuelMini("SHIP");
    this.sideWrapEl = sideBar.wrap;
    this.sideLabelEl = sideBar.labelEl;
    this.sideFill = sideBar.fill;
    this.sidePct = sideBar.pct;
    this.boosterLabelEl = bBar.labelEl;
    this.boosterFill = bBar.fill;
    this.boosterPct = bBar.pct;
    this.shipLabelEl = sBar.labelEl;
    this.shipFill = sBar.fill;
    this.shipPct = sBar.pct;

    this.boosterRtlsPill = el("span", "booster-rtls-pill tabular", "BSTR: ATTACHED");
    this.verdictBanner = el("div", "status-banner tabular");
    this.verdictBanner.style.display = "none";

    mainRow.append(
      clockCluster,
      gaugesRow,
      inlineRow,
      fuelInline,
      this.boosterRtlsPill,
      this.verdictBanner
    );

    // Footer: Orbital Telemetry (left) + System Metrics (right)
    const footerRow = el("div", "flight-hud-footer");
    this.orbitalRow = el("div", "orbital-telemetry-row");
    const makeOrbItem = (label: string) => {
      const item = el("div", "telemetry-item");
      const val = el("span", "telemetry-value tabular", "-");
      item.append(el("span", "telemetry-label", label), val);
      this.orbitalRow.append(item);
      return val;
    };
    this.apValEl = makeOrbItem("APOAPSIS");
    this.peValEl = makeOrbItem("PERIAPSIS");
    this.eccValEl = makeOrbItem("ECCENTRICITY");
    this.periodValEl = makeOrbItem("PERIOD");
    this.targetOrbValEl = makeOrbItem("TARGET ORBIT");

    const sysRow = el("div", "sys-meta-row");
    const makePill = (prefix: string, initVal: string, extraCls?: string) => {
      const p = el("span", "status-pill tabular");
      const strong = el("strong", extraCls, initVal);
      p.append(document.createTextNode(`${prefix} `), strong);
      sysRow.append(p);
      return strong;
    };
    this.fpsStrong = makePill("FPS", "--");
    this.drawStrong = makePill("DRAWS", "--");
    this.faultStrong = makePill("FAULTS", "NOMINAL");
    makePill("MODE", isElectron ? "DESKTOP" : "BROWSER");
    this.gpuStrong = makePill("GPU", initialRendererName, "gpu-label");
    this.gpuStrong.title = initialRendererName;

    footerRow.append(this.orbitalRow, sysRow);
    this.root.append(mainRow, footerRow);
  }

  update(t: SceneTelemetry): void {
    const f = t.flight;
    this.tClockEl.textContent = formatTClock(f.tClockSec);
    this.phaseBadgeEl.textContent = f.phase;
    this.phaseBadgeEl.className = "phase-badge";
    if (f.phase === "CRASHED") {
      this.phaseBadgeEl.classList.add("crashed");
    } else if (f.orbital.orbitAchieved || f.phase === "TOUCHDOWN") {
      this.phaseBadgeEl.classList.add("orbit-ok");
    }
    this.atmoLayerEl.textContent =
      f.atmosphericLayer === "KARMAN LINE" ? "KARMAN 100km" : f.atmosphericLayer;
    this.atmoLayerEl.className = "atmo-layer-badge tabular";
    if (f.karmanLineCrossed || f.atmosphericLayer === "ORBIT SPACE") {
      this.atmoLayerEl.classList.add("space");
    }

    // Radial arc gauges
    const speedRef = Math.max(400, f.orbital.circularVelocityMps * 1.05);
    setArcFraction(this.spdGauge.fillCircle, f.speedMps / speedRef);
    this.spdGauge.centerEl.textContent = `${Math.round(f.speedMps)}`;
    this.spdGauge.readoutEl.textContent = `${formatSpeed(f.speedMps)} · ${Math.round(f.speedKmh).toLocaleString()} km/h`;

    setArcFraction(this.altGauge.fillCircle, f.altitudeM / Math.max(1000, f.orbital.targetOrbitAltM));
    this.altGauge.centerEl.textContent = formatCompactAltitude(f.altitudeM);
    this.altGauge.readoutEl.textContent = formatAltitude(f.altitudeM);

    const thrPct = Math.round(f.throttle * 100);
    setArcFraction(this.thrGauge.fillCircle, f.throttle);
    this.thrGauge.centerEl.textContent = `${thrPct}%`;
    this.thrGauge.readoutEl.textContent = `${thrPct}%`;

    this.vyValEl.textContent = formatSignedVelocity(f.verticalSpeedMps);
    this.gValEl.textContent = `${f.gLoad.toFixed(2)} g`;
    this.qValEl.textContent =
      f.mach > 0.1
        ? `${formatDynamicPressure(f.dynamicPressurePa)} · M${f.mach.toFixed(1)}`
        : formatDynamicPressure(f.dynamicPressurePa);
    this.downrangeValEl.textContent = `${f.downrangeKm.toFixed(1)} km`;

    const veh = getVehicleConfig(t.vehicleId);
    this.boosterLabelEl.textContent = veh.stage1Label;
    this.shipLabelEl.textContent = veh.stage2Label;
    if (veh.hasSideBoosters && f.missionMode === "launch") {
      this.sideWrapEl.style.display = "flex";
      this.sideLabelEl.textContent = veh.sideBoosterLabel;
      const sidePctVal = Math.round(f.sideBoosterFuel * 100);
      this.sideFill.style.width = `${sidePctVal}%`;
      this.sidePct.textContent = `${sidePctVal}%`;
    } else {
      this.sideWrapEl.style.display = "none";
    }

    const bPct = Math.round(f.boosterFuel * 100);
    this.boosterFill.style.width = `${bPct}%`;
    this.boosterPct.textContent = `${bPct}%`;
    const sPct = Math.round(f.shipFuel * 100);
    this.shipFill.style.width = `${sPct}%`;
    this.shipPct.textContent = `${sPct}%`;

    if (f.missionMode !== "launch") {
      this.boosterRtlsPill.style.display = "none";
    } else {
      this.boosterRtlsPill.style.display = "inline-flex";
      const bStatus = formatBoosterStatusLabel(f.booster);
      this.boosterRtlsPill.className = `booster-rtls-pill tabular ${
        bStatus.tone === "active"
          ? "rtls-active"
          : bStatus.tone === "ok"
            ? "rtls-ok"
            : bStatus.tone === "fail"
              ? "rtls-fail"
              : ""
      }`.trim();
      this.boosterRtlsPill.textContent = bStatus.text;
    }

    // Status & verdict banner (cleanly clears ORBIT ACHIEVED if spacecraft deorbits)
    if (f.crashEvent) {
      this.verdictBanner.style.display = "block";
      this.verdictBanner.className = "status-banner tabular crash";
      this.verdictBanner.textContent = `RUD (${f.crashEvent.cause}) · ${f.crashEvent.impactSpeedMps.toFixed(1)} m/s`;
    } else if (f.landingVerdict !== "NONE") {
      this.verdictBanner.style.display = "block";
      const cls =
        f.landingVerdict === "NOMINAL LANDING"
          ? "nominal"
          : f.landingVerdict === "HARD LANDING"
            ? "hard"
            : "crash";
      this.verdictBanner.className = `status-banner tabular ${cls}`;
      this.verdictBanner.textContent = `${f.landingVerdict} · |vy|=${f.touchdownVerticalSpeedMps?.toFixed(2) ?? "-"} m/s`;
    } else if (f.missionMode === "launch" && f.orbital.orbitAchieved) {
      this.verdictBanner.style.display = "block";
      this.verdictBanner.className = "status-banner tabular nominal";
      this.verdictBanner.textContent = `ORBIT ACHIEVED · Ap ${(f.orbital.apoapsisAltM / 1000).toFixed(1)} km · Pe ${(f.orbital.periapsisAltM / 1000).toFixed(1)} km · e=${f.orbital.eccentricity.toFixed(3)}`;
    } else if (f.maxQReached && f.missionMode === "launch") {
      this.verdictBanner.style.display = "block";
      this.verdictBanner.className = "status-banner tabular maxq";
      this.verdictBanner.textContent = `MAX-Q ${(f.maxQPa / 1000).toFixed(1)} kPa`;
    } else {
      this.verdictBanner.style.display = "none";
    }

    this.orbitalRow.style.display = f.missionMode === "launch" ? "flex" : "none";
    if (f.missionMode === "launch") {
      const orb = f.orbital;
      const airborne = f.phase !== "PRELAUNCH" && f.phase !== "COUNTDOWN";
      this.apValEl.textContent = airborne ? formatOrbitalAltitude(orb.apoapsisAltM) : "0.0 m";
      this.peValEl.textContent = airborne ? formatOrbitalAltitude(orb.periapsisAltM) : "SUBORB";
      this.eccValEl.textContent = Number.isFinite(orb.eccentricity)
        ? orb.eccentricity.toFixed(3)
        : "—";
      this.periodValEl.textContent =
        orb.orbitalPeriodMin !== null ? `${orb.orbitalPeriodMin.toFixed(1)} min` : "—";
      this.targetOrbValEl.textContent = `${(orb.targetOrbitAltM / 1000).toFixed(0)} km · ${orb.circularVelocityMps.toFixed(0)} m/s`;
    }

    this.fpsStrong.textContent = String(t.fps);
    this.drawStrong.textContent = String(t.drawCalls);
    this.faultStrong.textContent = f.activeFaults;
    this.gpuStrong.textContent = t.rendererName;
  }
}
