import "./style.css";
import { PLANET_ORDER, type PlanetConfig, type PlanetId, getPlanetConfig } from "./config/planets";
import type { QualityPreset } from "./effects/PropulsionEffects";
import { type CameraFocusMode, SceneManager, type SceneTelemetry } from "./scene/SceneManager";
import type { ControlMode, FlightTelemetry, MissionMode } from "./sim/FlightController";

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

function formatTClock(tSec: number): string {
  const sign = tSec < 0 ? "-" : "+";
  const abs = Math.abs(tSec);
  const mins = Math.floor(abs / 60);
  const secs = abs % 60;
  return `T${sign}${String(mins).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;
}

function buildHud(
  root: HTMLElement,
  initialPlanet: PlanetConfig,
  rendererName: string,
  isElectron: boolean,
  actions: {
    onSelectPlanet: (id: PlanetId) => void;
    onSelectMissionMode: (mode: MissionMode) => void;
    onSelectControlMode: (mode: ControlMode) => void;
    onToggleSas: () => void;
    onStart: () => void;
    onPause: () => void;
    onStageSep: () => void;
    onReset: () => void;
    onToggleFocus: () => void;
    onResetCamera: () => void;
    onSelectQuality: (q: QualityPreset) => void;
  }
) {
  const topRow = createElement("div", "hud-top-row");

  // --- Top-Left Control & Planet Card ---
  const topLeft = createElement("section", "hud-card hud-top-left");
  const brandRow = createElement("div", "brand-row");
  brandRow.append(
    createElement("span", "brand-title", "AETHERSIM"),
    createElement("span", "brand-stage", "Stage 3 · FX & RUD Physics")
  );

  const planetRow = createElement("div", "seg-row seg-3");
  const planetBtns = new Map<PlanetId, HTMLButtonElement>();
  PLANET_ORDER.forEach((id, idx) => {
    const cfg = getPlanetConfig(id);
    const btn = createElement("button", "seg-btn", `${idx + 1} · ${cfg.name}`);
    btn.type = "button";
    btn.addEventListener("click", () => actions.onSelectPlanet(id));
    planetRow.append(btn);
    planetBtns.set(id, btn);
  });

  const modeRow = createElement("div", "seg-row seg-2");
  const launchBtn = createElement("button", "seg-btn", "LAUNCH");
  launchBtn.type = "button";
  launchBtn.addEventListener("click", () => actions.onSelectMissionMode("launch"));
  const landingBtn = createElement("button", "seg-btn", "LANDING");
  landingBtn.type = "button";
  landingBtn.addEventListener("click", () => actions.onSelectMissionMode("landing"));
  modeRow.append(launchBtn, landingBtn);

  const ctrlRow = createElement("div", "seg-row seg-3");
  const autoBtn = createElement("button", "seg-btn", "AUTOPILOT");
  autoBtn.type = "button";
  autoBtn.addEventListener("click", () => actions.onSelectControlMode("autopilot"));
  const manualBtn = createElement("button", "seg-btn", "MANUAL");
  manualBtn.type = "button";
  manualBtn.addEventListener("click", () => actions.onSelectControlMode("manual"));
  const sasBtn = createElement("button", "seg-btn", "SAS: ON [T]");
  sasBtn.type = "button";
  sasBtn.addEventListener("click", actions.onToggleSas);
  ctrlRow.append(autoBtn, manualBtn, sasBtn);

  const actionRow = createElement("div", "action-row");
  const startBtn = createElement("button", "action-btn primary", "START [Space]");
  startBtn.type = "button";
  startBtn.addEventListener("click", actions.onStart);

  const pauseBtn = createElement("button", "action-btn", "PAUSE");
  pauseBtn.type = "button";
  pauseBtn.addEventListener("click", actions.onPause);

  const sepBtn = createElement("button", "action-btn", "STAGE SEP");
  sepBtn.type = "button";
  sepBtn.addEventListener("click", actions.onStageSep);

  const resetBtn = createElement("button", "action-btn", "RESET [R]");
  resetBtn.type = "button";
  resetBtn.addEventListener("click", actions.onReset);

  const focusBtn = createElement("button", "action-btn", "FOCUS: ROCKET");
  focusBtn.type = "button";
  focusBtn.addEventListener("click", actions.onToggleFocus);

  actionRow.append(startBtn, pauseBtn, sepBtn, resetBtn, focusBtn);

  const subtitleEl = createElement("div", "planet-subtitle");
  const physGrid = createElement("div", "telemetry-grid");
  const makePhysField = (label: string): HTMLElement => {
    const item = createElement("div", "telemetry-item");
    const val = createElement("span", "telemetry-value", "-");
    item.append(createElement("span", "telemetry-label", label), val);
    physGrid.append(item);
    return val;
  };
  const gravityVal = makePhysField("Surface Gravity");
  const pressureVal = makePhysField("Surface Pressure");
  const densityVal = makePhysField("Air Density");
  const atmosphereVal = makePhysField("Atmosphere");

  topLeft.append(brandRow, planetRow, modeRow, ctrlRow, actionRow, subtitleEl, physGrid);

  // --- Top-Right Flight Telemetry Card ---
  const topRight = createElement("section", "hud-card hud-top-right");
  const badgeRow = createElement("div", "badge-row");
  const phaseBadge = createElement("span", "phase-badge", "PRELAUNCH");
  const tClockEl = createElement("span", "tclock-label", "T-00:10.0");
  badgeRow.append(phaseBadge, tClockEl);

  const flightGrid = createElement("div", "telemetry-grid");
  const makeFlightField = (label: string): HTMLElement => {
    const item = createElement("div", "telemetry-item");
    const val = createElement("span", "telemetry-value", "-");
    item.append(createElement("span", "telemetry-label", label), val);
    flightGrid.append(item);
    return val;
  };
  const altVal = makeFlightField("Altitude");
  const speedVal = makeFlightField("Velocity");
  const vyVal = makeFlightField("Vertical Speed");
  const machVal = makeFlightField("Mach / q");
  const throttleVal = makeFlightField("Throttle");
  const legsVal = makeFlightField("Legs / Tilt");

  const fuelBars = createElement("div", "fuel-bars");
  const makeFuelRow = (label: string) => {
    const row = createElement("div", "fuel-row");
    const lbl = createElement("span", undefined, label);
    lbl.style.width = "54px";
    const track = createElement("div", "fuel-track");
    const fill = createElement("div", "fuel-fill");
    fill.style.width = "100%";
    track.append(fill);
    const pct = createElement("span", undefined, "100%");
    pct.style.width = "34px";
    pct.style.textAlign = "right";
    row.append(lbl, track, pct);
    fuelBars.append(row);
    return { fill, pct };
  };
  const boosterFuelBar = makeFuelRow("BOOSTER");
  const shipFuelBar = makeFuelRow("SHIP");

  const bannerEl = createElement("div", "status-banner");
  bannerEl.style.display = "none";

  const manualHint = createElement(
    "div",
    "manual-hint",
    "MANUAL: W/Shift +Thr · S/Ctrl -Thr · Z 100% · X 0% · Arrows/IJKL Pitch/Tilt · Q/E Roll · T SAS · G Legs · Space Start/Sep"
  );
  manualHint.style.display = "none";

  topRight.append(badgeRow, flightGrid, fuelBars, bannerEl, manualHint);
  topRow.append(topLeft, topRight);

  // --- Bottom-Left Diagnostics & Quality Card ---
  const bottomLeft = createElement("section", "hud-card hud-bottom-left");
  const fpsPill = createElement("div", "status-pill");
  const fpsStrong = createElement("strong", undefined, "--");
  fpsPill.append(document.createTextNode("FPS "), fpsStrong);

  const drawPill = createElement("div", "status-pill");
  const drawStrong = createElement("strong", undefined, "--");
  drawPill.append(document.createTextNode("DRAWS "), drawStrong);

  const envPill = createElement("div", "status-pill");
  envPill.append(
    document.createTextNode("MODE "),
    createElement("strong", undefined, isElectron ? "DESKTOP" : "BROWSER")
  );

  const qualityGroup = createElement("div", "quality-group");
  qualityGroup.append(createElement("span", "status-pill", "FX"));
  const qualityBtns = new Map<QualityPreset, HTMLButtonElement>();
  (["low", "med", "high"] as const).forEach((q) => {
    const qBtn = createElement("button", "quality-btn", q.toUpperCase());
    qBtn.type = "button";
    qBtn.addEventListener("click", () => actions.onSelectQuality(q));
    qualityGroup.append(qBtn);
    qualityBtns.set(q, qBtn);
  });

  const gpuPill = createElement("div", "status-pill");
  const gpuStrong = createElement("strong", "gpu-label", rendererName);
  gpuStrong.title = rendererName;
  gpuPill.append(document.createTextNode("GPU "), gpuStrong);

  const resetCamBtn = createElement("button", "action-btn", "Reset Cam");
  resetCamBtn.type = "button";
  resetCamBtn.addEventListener("click", actions.onResetCamera);

  bottomLeft.append(fpsPill, drawPill, envPill, qualityGroup, gpuPill, resetCamBtn);
  root.append(topRow, bottomLeft);

  const updatePlanetReadout = (cfg: PlanetConfig): void => {
    for (const [id, btn] of planetBtns.entries()) {
      btn.classList.toggle("active", id === cfg.id);
    }
    subtitleEl.textContent = `${cfg.name} — ${cfg.subtitle}`;
    gravityVal.textContent = `${cfg.physics.gravityMps2.toFixed(3)} m/s²`;
    pressureVal.textContent =
      cfg.physics.surfacePressureBar === 0
        ? "0.000 bar"
        : `${cfg.physics.surfacePressureBar.toFixed(5)} bar`;
    densityVal.textContent = `${cfg.physics.airDensityKgM3.toFixed(3)} kg/m³`;
    atmosphereVal.textContent = cfg.physics.atmosphereLabel;
  };

  const updateQualityReadout = (q: QualityPreset): void => {
    for (const [preset, btn] of qualityBtns.entries()) {
      btn.classList.toggle("active", preset === q);
    }
  };

  const updateFlightReadout = (tel: FlightTelemetry, focus: CameraFocusMode): void => {
    launchBtn.classList.toggle("active", tel.missionMode === "launch");
    landingBtn.classList.toggle("active", tel.missionMode === "landing");
    autoBtn.classList.toggle("active", tel.controlMode === "autopilot");
    manualBtn.classList.toggle("active", tel.controlMode === "manual");
    sasBtn.classList.toggle("active", tel.sasEnabled);
    sasBtn.textContent = tel.sasEnabled ? "SAS: ON [T]" : "SAS: OFF [T]";
    pauseBtn.textContent = tel.paused ? "RESUME" : "PAUSE";
    focusBtn.textContent = focus === "rocket" ? "FOCUS: ROCKET" : "FOCUS: PAD & BASE";
    manualHint.style.display = tel.controlMode === "manual" ? "block" : "none";

    phaseBadge.textContent = tel.phase;
    tClockEl.textContent = formatTClock(tel.tClockSec);

    altVal.textContent =
      tel.altitudeM >= 1000
        ? `${(tel.altitudeM / 1000).toFixed(2)} km`
        : `${tel.altitudeM.toFixed(1)} m`;
    speedVal.textContent = `${tel.speedMps.toFixed(1)} m/s (${tel.speedKmh.toFixed(0)} km/h)`;
    vyVal.textContent = `${tel.verticalSpeedMps >= 0 ? "+" : ""}${tel.verticalSpeedMps.toFixed(1)} m/s`;
    machVal.textContent = `M${tel.mach.toFixed(2)} · ${(tel.dynamicPressurePa / 1000).toFixed(2)} kPa`;
    throttleVal.textContent = `${Math.round(tel.throttle * 100)}%`;

    const tiltDeg = (Math.hypot(tel.pitch, tel.roll) * 180) / Math.PI;
    const legsTxt = tel.landingLegsDeployed > 0.7 ? "DEPLOYED" : "STOWED";
    legsVal.textContent = `${legsTxt} · ${tiltDeg.toFixed(1)}°`;

    const bPct = Math.round(tel.boosterFuel * 100);
    boosterFuelBar.fill.style.width = `${bPct}%`;
    boosterFuelBar.pct.textContent = `${bPct}%`;
    const sPct = Math.round(tel.shipFuel * 100);
    shipFuelBar.fill.style.width = `${sPct}%`;
    shipFuelBar.pct.textContent = `${sPct}%`;

    if (tel.crashEvent) {
      bannerEl.style.display = "block";
      bannerEl.className = "status-banner crash";
      bannerEl.textContent = `RUD (${tel.crashEvent.cause}) · v=${tel.crashEvent.impactSpeedMps.toFixed(1)} m/s`;
    } else if (tel.landingVerdict !== "NONE") {
      bannerEl.style.display = "block";
      const cls =
        tel.landingVerdict === "NOMINAL LANDING"
          ? "nominal"
          : tel.landingVerdict === "HARD LANDING"
            ? "hard"
            : "crash";
      bannerEl.className = `status-banner ${cls}`;
      const tdVy = tel.touchdownVerticalSpeedMps?.toFixed(2) ?? "-";
      const tdOff = tel.touchdownOffsetM?.toFixed(1) ?? "-";
      bannerEl.textContent = `${tel.landingVerdict} · |vy|=${tdVy} m/s · off=${tdOff}m`;
    } else if (tel.maxQReached && tel.missionMode === "launch") {
      bannerEl.style.display = "block";
      bannerEl.className = "status-banner maxq";
      bannerEl.textContent = `MAX-Q PASSED · Peak ${(tel.maxQPa / 1000).toFixed(2)} kPa`;
    } else {
      bannerEl.style.display = "none";
    }
  };

  const updateTelemetry = (t: SceneTelemetry, focus: CameraFocusMode): void => {
    fpsStrong.textContent = String(t.fps);
    drawStrong.textContent = `${t.drawCalls} (${Math.round(t.triangles / 1000)}k tri)`;
    gpuStrong.textContent = t.rendererName;
    updateQualityReadout(t.quality);
    updateFlightReadout(t.flight, focus);
  };

  updatePlanetReadout(initialPlanet);
  updateQualityReadout("med");
  return { updatePlanetReadout, updateFlightReadout, updateQualityReadout, updateTelemetry };
}

function bootstrap(): void {
  const canvas = document.getElementById("sim-canvas");
  const hudRoot = document.getElementById("hud-root");
  if (!(canvas instanceof HTMLCanvasElement) || !(hudRoot instanceof HTMLElement)) {
    throw new Error("Missing #sim-canvas or #hud-root in index.html");
  }

  const isElectron = Boolean(window.desktopApp?.isElectron);
  let hudApi: ReturnType<typeof buildHud> | null = null;

  const sceneManager = new SceneManager(canvas, "mars", (telemetry) => {
    hudApi?.updateTelemetry(telemetry, sceneManager.getFocusMode());
    window.__STARSHIP_SIM__ = {
      ready: true,
      planet: sceneManager.getPlanet().id,
      missionMode: telemetry.flight.missionMode,
      controlMode: telemetry.flight.controlMode,
      phase: telemetry.flight.phase,
      quality: telemetry.quality,
      sasEnabled: telemetry.flight.sasEnabled,
      crashed: telemetry.flight.phase === "CRASHED",
      fps: telemetry.fps,
      rendererName: telemetry.rendererName,
      isElectron,
      drawCalls: telemetry.drawCalls,
      triangles: telemetry.triangles,
    };
  });

  const syncNow = (): void => {
    const tel = sceneManager.getFlightTelemetry();
    hudApi?.updateFlightReadout(tel, sceneManager.getFocusMode());
    hudApi?.updateQualityReadout(sceneManager.getQualityPreset());
    if (window.__STARSHIP_SIM__) {
      window.__STARSHIP_SIM__.planet = tel.planetId;
      window.__STARSHIP_SIM__.missionMode = tel.missionMode;
      window.__STARSHIP_SIM__.controlMode = tel.controlMode;
      window.__STARSHIP_SIM__.phase = tel.phase;
      window.__STARSHIP_SIM__.quality = sceneManager.getQualityPreset();
      window.__STARSHIP_SIM__.sasEnabled = tel.sasEnabled;
      window.__STARSHIP_SIM__.crashed = tel.phase === "CRASHED";
    }
  };

  const selectPlanet = (id: PlanetId): void => {
    const cfg = sceneManager.setPlanet(id);
    hudApi?.updatePlanetReadout(cfg);
    syncNow();
  };

  hudApi = buildHud(
    hudRoot,
    sceneManager.getPlanet(),
    sceneManager.getRendererName(),
    isElectron,
    {
      onSelectPlanet: selectPlanet,
      onSelectMissionMode: (mode) => {
        sceneManager.setMissionMode(mode);
        syncNow();
      },
      onSelectControlMode: (mode) => {
        sceneManager.setControlMode(mode);
        syncNow();
      },
      onToggleSas: () => {
        sceneManager.toggleSas();
        syncNow();
      },
      onStart: () => {
        sceneManager.startMission();
        syncNow();
      },
      onPause: () => {
        sceneManager.togglePause();
        syncNow();
      },
      onStageSep: () => {
        sceneManager.triggerStageSeparation();
        syncNow();
      },
      onReset: () => {
        sceneManager.resetMission();
        syncNow();
      },
      onToggleFocus: () => {
        const next = sceneManager.getFocusMode() === "rocket" ? "base" : "rocket";
        sceneManager.setFocusMode(next);
        syncNow();
      },
      onResetCamera: () => sceneManager.resetCamera(),
      onSelectQuality: (q) => {
        sceneManager.setQualityPreset(q);
        syncNow();
      },
    }
  );
  syncNow();

  const initialTel = sceneManager.getFlightTelemetry();
  window.__STARSHIP_SIM__ = {
    ready: true,
    planet: sceneManager.getPlanet().id,
    missionMode: initialTel.missionMode,
    controlMode: initialTel.controlMode,
    phase: initialTel.phase,
    quality: sceneManager.getQualityPreset(),
    sasEnabled: initialTel.sasEnabled,
    crashed: false,
    fps: 0,
    rendererName: sceneManager.getRendererName(),
    isElectron,
    drawCalls: 0,
    triangles: 0,
  };

  const keysDown = new Set<string>();
  const recomputeManualAxes = (): void => {
    const thrUp = keysDown.has("KeyW") || keysDown.has("ShiftLeft") || keysDown.has("ShiftRight");
    const thrDown = keysDown.has("KeyS") || keysDown.has("ControlLeft") || keysDown.has("ControlRight");
    const pUp = keysDown.has("ArrowUp") || keysDown.has("KeyI");
    const pDown = keysDown.has("ArrowDown") || keysDown.has("KeyK");
    const yLeft = keysDown.has("ArrowLeft") || keysDown.has("KeyJ");
    const yRight = keysDown.has("ArrowRight") || keysDown.has("KeyL");
    const rLeft = keysDown.has("KeyQ");
    const rRight = keysDown.has("KeyE");

    sceneManager.setManualInput({
      throttleDelta: (thrUp ? 1 : 0) - (thrDown ? 1 : 0),
      pitchInput: (pUp ? 1 : 0) - (pDown ? 1 : 0),
      yawInput: (yRight ? 1 : 0) - (yLeft ? 1 : 0),
      rollInput: (rRight ? 1 : 0) - (rLeft ? 1 : 0),
    });
  };

  window.addEventListener("keydown", (event: KeyboardEvent) => {
    keysDown.add(event.code);
    if (event.key === "1") {
      selectPlanet("mars");
    } else if (event.key === "2") {
      selectPlanet("earth");
    } else if (event.key === "3") {
      selectPlanet("moon");
    } else if (event.code === "Space") {
      event.preventDefault();
      const tel = sceneManager.getFlightTelemetry();
      if (!tel.running && tel.phase !== "TOUCHDOWN" && tel.phase !== "CRASHED" && tel.phase !== "COMPLETE") {
        sceneManager.startMission();
      } else if (tel.missionMode === "launch" && !tel.stageSeparated && tel.phase !== "CRASHED") {
        sceneManager.triggerStageSeparation();
      } else {
        sceneManager.startMission();
      }
      syncNow();
    } else if (event.key === "r" || event.key === "R") {
      sceneManager.resetMission();
      syncNow();
    } else if (event.key === "g" || event.key === "G") {
      sceneManager.toggleLandingLegs();
      syncNow();
    } else if (event.key === "t" || event.key === "T") {
      sceneManager.toggleSas();
      syncNow();
    } else if (event.key === "z" || event.key === "Z") {
      sceneManager.setManualInput({ throttleSet: 1.0 });
    } else if (event.key === "x" || event.key === "X") {
      sceneManager.setManualInput({ throttleSet: 0.0 });
    }
    recomputeManualAxes();
  });

  window.addEventListener("keyup", (event: KeyboardEvent) => {
    keysDown.delete(event.code);
    recomputeManualAxes();
  });

  window.addEventListener("beforeunload", () => {
    sceneManager.dispose();
  });
}

bootstrap();
