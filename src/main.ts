import "./style.css";
import pkg from "../package.json";
import type { PolicyCheckpoint } from "./ai/NeuralNetwork";
import { PLANET_ORDER, type PlanetId, getPlanetConfig } from "./config/planets";
import type { QualityPreset } from "./effects/PropulsionEffects";
import {
  buildExperimentBundleJSON,
  formatFlightTelemetryCSV,
  formatTrainingHistoryCSV,
  triggerBrowserDownload,
} from "./research/DataExporter";
import type { MonteCarloPilot, MonteCarloSummary } from "./research/MonteCarloRunner";
import { NeuralNetVisualizer } from "./research/NeuralNetVisualizer";
import { TelemetryCharts } from "./research/TelemetryCharts";
import {
  type CameraPreset,
  SceneManager,
  type SceneTelemetry,
} from "./scene/SceneManager";
import type { FaultConfig } from "./sim/FaultInjector";

const APP_VERSION = pkg.version;

type ResearchTab = "plots" | "nn" | "faults" | "mc" | "export";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
  tooltip?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tooltip) node.title = tooltip;
  return node;
}

function formatTClock(tSec: number): string {
  const sign = tSec < 0 ? "-" : "+";
  const abs = Math.abs(tSec);
  const mins = Math.floor(abs / 60);
  const secs = abs % 60;
  return `T${sign}${String(mins).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;
}

function bootstrap(): void {
  const canvas = document.getElementById("sim-canvas");
  const hudRoot = document.getElementById("hud-root");
  if (!(canvas instanceof HTMLCanvasElement) || !(hudRoot instanceof HTMLElement)) {
    throw new Error("Missing #sim-canvas or #hud-root in index.html");
  }

  const isElectron = Boolean(window.desktopApp?.isElectron);

  let latestTelemetry: SceneTelemetry | null = null;
  let mcSummary: MonteCarloSummary | null = null;
  let activeTab: ResearchTab = "plots";
  let leftDeckOpen = true;
  let labOpen = false;
  let advOpen = false;
  let resetConfirmArmTimer: number | null = null;
  let resetConfirmArmed = false;
  let lastChartRepaintMs = 0;

  let mcStatusText = "Select sample count to run off-thread Monte Carlo dispersion trials.";
  let mcSummaryEl: HTMLElement | null = null;
  let mcStatusEl: HTMLElement | null = null;

  const charts = new TelemetryCharts();
  const nnViz = new NeuralNetVisualizer();

  const renderMonteCarloSummary = (summary: MonteCarloSummary | null): void => {
    if (!mcSummaryEl || !mcStatusEl) {
      return;
    }
    if (!summary) {
      mcSummaryEl.style.display = "none";
      mcStatusEl.textContent = mcStatusText;
      return;
    }
    mcStatusEl.textContent = `Completed ${summary.episodes} trials in ${summary.durationMs} ms (${summary.pilot === "ai_ppo" ? "AI NEURAL" : "PID AUTO"} · ${summary.planet.toUpperCase()} ${summary.mission.toUpperCase()})`;
    mcSummaryEl.style.display = "grid";
    mcSummaryEl.innerHTML = "";
    const addStat = (label: string, value: string) => {
      const item = el("div", "telemetry-item");
      item.append(el("span", "telemetry-label", label), el("span", "telemetry-value", value));
      mcSummaryEl!.append(item);
    };
    addStat(
      "Success Rate (95% CI)",
      `${summary.successRatePct.toFixed(1)}% [${summary.ciLowPct.toFixed(1)}–${summary.ciHighPct.toFixed(1)}%]`
    );
    addStat("Crash / RUD Rate", `${summary.crashRatePct.toFixed(1)}% (${summary.crashCount}/${summary.episodes})`);
    addStat("Return (Mean ± Std)", `${summary.meanReturn.toFixed(1)} ± ${summary.stdReturn.toFixed(1)}`);
    addStat(
      "Mean Touchdown |vy|",
      summary.meanTouchdownVy !== null ? `${summary.meanTouchdownVy.toFixed(2)} m/s` : "N/A"
    );
    addStat(
      "Mean Pad Offset",
      summary.meanPadOffsetM !== null ? `${summary.meanPadOffsetM.toFixed(1)} m` : "N/A"
    );
    addStat("Mean Fuel Left", `${summary.meanFuelRemainingPct.toFixed(1)}%`);
  };

  const sceneManager = new SceneManager(
    canvas,
    "mars",
    (telemetry) => {
      latestTelemetry = telemetry;
      updateUI(telemetry);
      window.__STARSHIP_SIM__ = {
        ready: true,
        version: APP_VERSION,
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
        aiState: telemetry.ai.mode,
        aiBrainLevel: telemetry.ai.brainLevel,
        aiBestSuccessPct: telemetry.ai.bestBrain.evalSuccessRatePct,
        aiEpisodes: telemetry.ai.metrics.episodesCompleted,
        aiTotalSteps: telemetry.ai.metrics.totalSteps,
        aiMeanReturn: telemetry.ai.metrics.rollingMeanReturn,
        cameraPreset: telemetry.cameraPreset,
        audioMuted: telemetry.audioMuted,
      };
    },
    (summary) => {
      mcSummary = summary;
      renderMonteCarloSummary(summary);
    }
  );

  // =========================================================================
  // 1. COMPACT TOP BAR
  // =========================================================================
  const topBar = el("header", "hud-card hud-topbar");

  const brandGroup = el("div", "topbar-group");
  brandGroup.append(
    el("span", "brand-title", "AETHERSIM"),
    el("span", "brand-stage", `v${APP_VERSION} · Research Workbench`)
  );

  // Planet pills
  const planetStrip = el("div", "pill-strip");
  const planetBtns = new Map<PlanetId, HTMLButtonElement>();
  PLANET_ORDER.forEach((id, idx) => {
    const cfg = getPlanetConfig(id);
    const btn = el(
      "button",
      "seg-btn",
      `${idx + 1} ${cfg.name}`,
      `Switch world to ${cfg.name} (${cfg.physics.gravityMps2.toFixed(2)} m/s²)`
    );
    btn.type = "button";
    btn.addEventListener("click", () => selectPlanet(id));
    planetStrip.append(btn);
    planetBtns.set(id, btn);
  });

  // Mission pills
  const missionStrip = el("div", "pill-strip");
  const launchBtn = el("button", "seg-btn", "LAUNCH", "Full-stack launch from pad to orbit insertion");
  launchBtn.type = "button";
  launchBtn.addEventListener("click", () => {
    sceneManager.setMissionMode("launch");
    syncNow();
  });
  const landingBtn = el("button", "seg-btn", "LANDING", "Propulsive descent and precision pad landing");
  landingBtn.type = "button";
  landingBtn.addEventListener("click", () => {
    sceneManager.setMissionMode("landing");
    syncNow();
  });
  missionStrip.append(launchBtn, landingBtn);

  // Pilot pills
  const pilotStrip = el("div", "pill-strip");
  const aiPilotBtn = el(
    "button",
    "seg-btn",
    "AI NEURAL",
    "Fly using the continuous-control PPO neural network"
  );
  aiPilotBtn.type = "button";
  aiPilotBtn.addEventListener("click", () => {
    sceneManager.setControlMode("ai_ppo");
    syncNow();
  });
  const pidPilotBtn = el(
    "button",
    "seg-btn",
    "PID AUTO",
    "Fly using the classical guidance & PID flight autopilot"
  );
  pidPilotBtn.type = "button";
  pidPilotBtn.addEventListener("click", () => {
    sceneManager.setControlMode("autopilot");
    syncNow();
  });
  const manPilotBtn = el(
    "button",
    "seg-btn",
    "MANUAL",
    "Fly manually with keyboard throttle, TVC gimbal & cold-gas RCS"
  );
  manPilotBtn.type = "button";
  manPilotBtn.addEventListener("click", () => {
    sceneManager.setControlMode("manual");
    syncNow();
  });
  pilotStrip.append(aiPilotBtn, pidPilotBtn, manPilotBtn);

  // Camera pills
  const camStrip = el("div", "pill-strip");
  const camSpecs: Array<{ preset: CameraPreset; label: string; tip: string }> = [
    { preset: "pad", label: "C1 PAD", tip: "Pad Apron Camera (F1)" },
    { preset: "drone", label: "C2 DRONE", tip: "Tracking Chase Drone Camera (F2)" },
    { preset: "engine", label: "C3 ENGINE", tip: "Aft Raptor Nozzle & Plume Camera (F3)" },
    { preset: "station", label: "C4 STATION", tip: "Spaceport & Habitat Scenic Camera (F4)" },
    { preset: "orbit", label: "C5 ORBIT", tip: "Free Interactive Orbit Camera (F5)" },
  ];
  const camBtns = new Map<CameraPreset, HTMLButtonElement>();
  for (const spec of camSpecs) {
    const b = el("button", "seg-btn", spec.label, spec.tip);
    b.type = "button";
    b.addEventListener("click", () => {
      sceneManager.setCameraPreset(spec.preset);
      syncNow();
    });
    camStrip.append(b);
    camBtns.set(spec.preset, b);
  }
  const autoDirBtn = el(
    "button",
    "seg-btn",
    "AUTO",
    "Auto Director: switches cameras cinematically along the mission timeline"
  );
  autoDirBtn.type = "button";
  autoDirBtn.addEventListener("click", () => {
    sceneManager.setAutoDirector(!sceneManager.getAutoDirector());
    syncNow();
  });
  camStrip.append(autoDirBtn);

  // Utility group: Quality, Audio, Lab Toggle, Help
  const utilGroup = el("div", "topbar-group");
  const qualStrip = el("div", "pill-strip");
  const qualBtns = new Map<QualityPreset, HTMLButtonElement>();
  (["low", "med", "high"] as const).forEach((q) => {
    const qb = el("button", "seg-btn", q.toUpperCase(), `Graphics quality preset: ${q.toUpperCase()}`);
    qb.type = "button";
    qb.addEventListener("click", () => {
      sceneManager.setQualityPreset(q);
      syncNow();
    });
    qualStrip.append(qb);
    qualBtns.set(q, qb);
  });

  const audioBtn = el(
    "button",
    "action-btn",
    "AUDIO: OFF",
    "Toggle procedural Web Audio acoustics (Raptor roar, cryo hiss, RCS & RUD boom)"
  );
  audioBtn.type = "button";
  audioBtn.addEventListener("click", () => {
    sceneManager.setAudioMuted(!sceneManager.isAudioMuted());
    syncNow();
  });

  const leftToggleBtn = el("button", "action-btn active", "DECK", "Show/hide Mission & AI Control Deck");
  leftToggleBtn.type = "button";

  const labToggleBtn = el("button", "action-btn", "RESEARCH LAB", "Open/close Aerospace Research Workbench (Plots, Neural Net, Faults, Monte Carlo, Export)");
  labToggleBtn.type = "button";

  const helpBtn = el("button", "action-btn", "?", "Open Quick-Reference Controls & Guide");
  helpBtn.type = "button";

  utilGroup.append(qualStrip, audioBtn, leftToggleBtn, labToggleBtn, helpBtn);
  topBar.append(
    brandGroup,
    planetStrip,
    missionStrip,
    pilotStrip,
    camStrip,
    utilGroup
  );

  // =========================================================================
  // 2. MIDDLE ROW: LEFT MISSION & GUIDED AI DECK + RIGHT RESEARCH LAB
  // =========================================================================
  const midRow = el("div", "hud-mid-row");

  // --- Left Deck ---
  const leftDeck = el("aside", "hud-card hud-side-panel");
  const leftHead = el("div", "panel-header");
  leftHead.append(el("span", "panel-title", "MISSION & AI DECK"));
  const planetSub = el("span", "planet-subtitle", "");
  leftHead.append(planetSub);

  const flightActions = el("div", "action-row");
  const startBtn = el("button", "action-btn primary", "START [Space]", "Start countdown/flight or advance AI episode");
  startBtn.type = "button";
  startBtn.addEventListener("click", () => {
    sceneManager.startMission();
    syncNow();
  });
  const pauseBtn = el("button", "action-btn", "PAUSE", "Pause or resume physics simulation");
  pauseBtn.type = "button";
  pauseBtn.addEventListener("click", () => {
    sceneManager.togglePause();
    syncNow();
  });
  const sepBtn = el("button", "action-btn", "STAGE SEP", "Hot-stage separate Starship from Super Heavy");
  sepBtn.type = "button";
  sepBtn.addEventListener("click", () => {
    sceneManager.triggerStageSeparation();
    syncNow();
  });
  const resetBtn = el("button", "action-btn", "RESET [R]", "Reset vehicle and re-lock camera onto Starship");
  resetBtn.type = "button";
  resetBtn.addEventListener("click", () => {
    sceneManager.resetMission();
    syncNow();
  });
  const sasBtn = el("button", "action-btn", "SAS: ON [T]", "Toggle angular rate damping stability assist");
  sasBtn.type = "button";
  sasBtn.addEventListener("click", () => {
    sceneManager.toggleSas();
    syncNow();
  });
  const legsBtn = el("button", "action-btn", "LEGS [G]", "Deploy or stow Starship landing legs");
  legsBtn.type = "button";
  legsBtn.addEventListener("click", () => {
    sceneManager.toggleLandingLegs();
    syncNow();
  });
  const focusBtn = el("button", "action-btn", "FOCUS: ROCKET", "Toggle Free Orbit camera between Rocket and Pad/Base");
  focusBtn.type = "button";
  focusBtn.addEventListener("click", () => {
    const next = sceneManager.getFocusMode() === "rocket" ? "base" : "rocket";
    sceneManager.setFocusMode(next);
    syncNow();
  });
  flightActions.append(startBtn, pauseBtn, sepBtn, resetBtn, sasBtn, legsBtn, focusBtn);

  // Guided Neural AI Section (Hotfix v1.0.1 crystal-clear status & controls)
  const aiSection = el("div", "section-divider");
  const aiHead = el("div", "panel-header");
  aiHead.append(el("span", "panel-title", "NEURAL AI PILOT (PPO)"));
  const aiStatePill = el("span", "ai-state-pill", "IDLE");
  aiHead.append(aiStatePill);

  const aiStatusBanner = el("div", "ai-status-banner status-idle-untrained");
  const aiStatusDot = el("span", "ai-status-dot");
  const aiStatusText = el("span", "ai-status-banner-text", "IDLE — UNTRAINED BRAIN (Will Crash)");
  aiStatusBanner.append(aiStatusDot, aiStatusText);

  const aiStatusNote = el(
    "div",
    "ai-status-note",
    "Untrained random brain. Click 1. PRE-TRAIN BRAIN or 2. FAST TRAIN."
  );

  // Clear Brain Status Scorecard
  const aiScorecard = el("div", "ai-scorecard");
  const makeScoreRow = (label: string) => {
    const item = el("div", "telemetry-item");
    const lbl = el("span", "telemetry-label", label);
    const val = el("span", "telemetry-value", "-");
    item.append(lbl, val);
    aiScorecard.append(item);
    return { lbl, val };
  };
  const aiBrainLevelRow = makeScoreRow("Brain Level");
  const aiBestSuccessRow = makeScoreRow("Best Landing Success");
  const aiEpRow = makeScoreRow("Train Episodes");
  const aiRateRow = makeScoreRow("Worker Speed");
  const aiMeanRetRow = makeScoreRow("Live Rollout Ret");
  const aiBestRetRow = makeScoreRow("Best Eval Return");

  const guidedStack = el("div", "ai-guided-stack");
  const warmStartBtn = el(
    "button",
    "action-btn primary",
    "1. PRE-TRAIN BRAIN (FAST)",
    "Pre-train the neural network via Behavior Cloning + DAgger (~1–2s), evaluate 5 trials, and save the best brain"
  );
  warmStartBtn.type = "button";
  warmStartBtn.addEventListener("click", () => {
    sceneManager.startPreTrain();
    syncNow();
  });

  const turboTrainBtn = el(
    "button",
    "action-btn primary",
    "2. FAST TRAIN (PPO)",
    "Toggle background Web Worker PPO fine-tuning (safely preserves Best Saved Brain against collapse)"
  );
  turboTrainBtn.type = "button";
  turboTrainBtn.addEventListener("click", () => {
    sceneManager.toggleTurboTrain();
    syncNow();
  });

  const flyTrainedBtn = el(
    "button",
    "action-btn",
    "3. FLY TRAINED AI (3D)",
    "One-click: pauses background training, loads Best Saved Brain, resets Starship & locks camera in 3D"
  );
  flyTrainedBtn.type = "button";
  flyTrainedBtn.addEventListener("click", () => {
    sceneManager.startAIEval();
    syncNow();
  });
  guidedStack.append(warmStartBtn, turboTrainBtn, flyTrainedBtn);

  const secondaryAiRow = el("div", "ai-secondary-row");
  const liveTrainBtn = el(
    "button",
    "action-btn",
    "WATCH AI CRASH & LEARN (3D)",
    "Live 3D self-play: watch Starship crash, update PPO weights, and auto-retry"
  );
  liveTrainBtn.type = "button";
  liveTrainBtn.addEventListener("click", () => {
    sceneManager.startLiveTrain();
    syncNow();
  });

  // Two-click safety guard on RESET AI BRAIN
  const resetBrainBtn = el(
    "button",
    "action-btn",
    "RESET AI BRAIN",
    "Wipe learned neural weights back to random initialization (requires confirmation click)"
  );
  resetBrainBtn.type = "button";
  const clearResetConfirm = () => {
    resetConfirmArmed = false;
    resetBrainBtn.textContent = "RESET AI BRAIN";
    resetBrainBtn.classList.remove("danger-confirm");
    if (resetConfirmArmTimer !== null) {
      window.clearTimeout(resetConfirmArmTimer);
      resetConfirmArmTimer = null;
    }
  };
  resetBrainBtn.addEventListener("click", () => {
    if (!resetConfirmArmed) {
      resetConfirmArmed = true;
      resetBrainBtn.textContent = "Click again to confirm wipe";
      resetBrainBtn.classList.add("danger-confirm");
      resetConfirmArmTimer = window.setTimeout(clearResetConfirm, 3000);
      return;
    }
    clearResetConfirm();
    sceneManager.resetAIWeights();
    syncNow();
    repaintResearchCanvases(true);
  });
  secondaryAiRow.append(liveTrainBtn, resetBrainBtn);

  // Collapsible Advanced Hyperparameters
  const advToggleBtn = el("button", "action-btn", "▸ Advanced Hyperparameters", "Learning rate, domain randomization & checkpoint .json");
  advToggleBtn.type = "button";
  const advBody = el("div", "section-divider");
  advBody.style.display = "none";
  advToggleBtn.addEventListener("click", () => {
    advOpen = !advOpen;
    advBody.style.display = advOpen ? "flex" : "none";
    advToggleBtn.textContent = advOpen ? "▾ Advanced Hyperparameters" : "▸ Advanced Hyperparameters";
  });

  const lrRow = el("div", "action-row");
  const lrBtns = new Map<number, HTMLButtonElement>();
  for (const lr of [3e-4, 6e-4, 1e-3]) {
    const lbl = lr === 3e-4 ? "LR 3e-4" : lr === 6e-4 ? "LR 6e-4" : "LR 1e-3";
    const b = el("button", "action-btn", lbl, `Set Adam learning rate to ${lbl}`);
    b.type = "button";
    b.addEventListener("click", () => {
      sceneManager.setAILearningRate(lr);
      syncNow();
    });
    lrRow.append(b);
    lrBtns.set(lr, b);
  }
  const randBtn = el(
    "button",
    "action-btn active",
    "RAND: ON",
    "Randomize initial position, velocity, and tilt during training"
  );
  randBtn.type = "button";
  randBtn.addEventListener("click", () => {
    sceneManager.setDomainRandomization(!sceneManager.getAIStatus().randomizeSpawn);
    syncNow();
  });

  const ckptRow = el("div", "action-row");
  const saveCkptBtn = el("button", "action-btn", "SAVE .JSON", "Download trained neural weights as .json checkpoint");
  saveCkptBtn.type = "button";
  saveCkptBtn.addEventListener("click", () => {
    const cp: PolicyCheckpoint = sceneManager.exportPolicyCheckpoint();
    triggerBrowserDownload(
      `aethersim-ppo-${cp.planet}-${cp.mission}-ep${cp.episodesCompleted}.json`,
      JSON.stringify(cp, null, 2),
      "application/json"
    );
  });

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.style.display = "none";
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    sceneManager.importPolicyCheckpoint(await f.text());
    fileInput.value = "";
    syncNow();
  });
  const loadCkptBtn = el("button", "action-btn", "LOAD .JSON", "Load saved .json neural weights");
  loadCkptBtn.type = "button";
  loadCkptBtn.addEventListener("click", () => fileInput.click());
  ckptRow.append(saveCkptBtn, loadCkptBtn, fileInput);
  advBody.append(lrRow, randBtn, ckptRow);

  const aiErrBanner = el("div", "status-banner crash");
  aiErrBanner.style.display = "none";

  aiSection.append(
    aiHead,
    aiStatusBanner,
    aiStatusNote,
    aiScorecard,
    guidedStack,
    secondaryAiRow,
    advToggleBtn,
    advBody,
    aiErrBanner
  );
  leftDeck.append(leftHead, flightActions, aiSection);

  // --- Right Panel: RESEARCH LAB ---
  const labPanel = el("aside", "hud-card hud-research-panel");
  labPanel.style.display = "none";

  const labHead = el("div", "panel-header");
  labHead.append(el("span", "panel-title", "AEROSPACE RESEARCH LAB"));
  const labCloseBtn = el("button", "action-btn", "✕", "Close Research Lab");
  labCloseBtn.type = "button";
  labHead.append(labCloseBtn);

  const tabBar = el("div", "tab-bar");
  const tabDefs: Array<{ id: ResearchTab; label: string; tip: string }> = [
    { id: "plots", label: "PLOTS", tip: "Live streaming flight & PPO learning charts" },
    { id: "nn", label: "NEURAL NET", tip: "Live 14→64→64→3 actor activation visualizer" },
    { id: "faults", label: "FAULTS", tip: "Inject thrust loss, crosswind, IMU bias/noise & TVC lag" },
    { id: "mc", label: "MONTE CARLO", tip: "Batch 20/50/100 seeded dispersion runs with 95% CI" },
    { id: "export", label: "EXPORT", tip: "Export flight CSV, RL training CSV, and JSON bundle" },
  ];
  const tabBtns = new Map<ResearchTab, HTMLButtonElement>();
  const tabViews = new Map<ResearchTab, HTMLElement>();

  const setActiveTab = (tab: ResearchTab) => {
    activeTab = tab;
    for (const [id, b] of tabBtns.entries()) {
      b.classList.toggle("active", id === tab);
    }
    for (const [id, view] of tabViews.entries()) {
      view.style.display = id === tab ? "block" : "none";
    }
    if (labOpen) {
      lastChartRepaintMs = 0;
      repaintResearchCanvases(true);
    }
  };

  for (const td of tabDefs) {
    const b = el("button", "tab-btn", td.label, td.tip);
    b.type = "button";
    b.addEventListener("click", () => setActiveTab(td.id));
    tabBar.append(b);
    tabBtns.set(td.id, b);
  }

  // Tab 1: PLOTS
  const plotsView = el("div");
  plotsView.append(charts.root);
  tabViews.set("plots", plotsView);

  // Tab 2: NEURAL NET
  const nnView = el("div");
  nnView.append(nnViz.canvas);
  tabViews.set("nn", nnView);

  // Tab 3: FAULTS
  const faultsView = el("div", "section-divider");
  const makeSlider = (
    label: string,
    min: number,
    max: number,
    step: number,
    unit: string,
    initial: number,
    onChange: (v: number) => void
  ) => {
    const row = el("div", "fault-row");
    const head = el("div", "fault-row-head");
    const valStrong = el("strong", undefined, `${initial}${unit}`);
    head.append(el("span", undefined, label), valStrong);
    const input = document.createElement("input");
    input.type = "range";
    input.className = "fault-slider";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);
    input.addEventListener("input", () => {
      const v = Number(input.value);
      valStrong.textContent = `${v}${unit}`;
      onChange(v);
      syncNow();
    });
    row.append(head, input);
    faultsView.append(row);
    return { input, valStrong, unit };
  };

  const fThrust = makeSlider("Engine Thrust Loss", 0, 50, 5, "%", 0, (v) =>
    sceneManager.setFaultConfig({ thrustLossPct: v })
  );
  const fAlt = makeSlider("Thrust Fault Trigger Alt", 0, 1000, 50, "m", 0, (v) =>
    sceneManager.setFaultConfig({ thrustLossTriggerAltM: v })
  );
  const fWind = makeSlider("Crosswind / Gust Speed", 0, 40, 2, " m/s", 0, (v) =>
    sceneManager.setFaultConfig({ windSpeedMps: v })
  );
  const fBias = makeSlider("IMU Attitude Bias", 0, 10, 0.5, "°", 0, (v) =>
    sceneManager.setFaultConfig({ imuBiasDeg: v })
  );
  const fNoise = makeSlider("IMU Attitude Noise", 0, 5, 0.5, "°", 0, (v) =>
    sceneManager.setFaultConfig({ imuNoiseDeg: v })
  );

  const faultBtnRow = el("div", "action-row");
  const tvcLagBtn = el("button", "action-btn", "TVC LAG: OFF", "Toggle actuator gimbal lag & 45% authority reduction");
  tvcLagBtn.type = "button";
  tvcLagBtn.addEventListener("click", () => {
    const cur = sceneManager.getFaultConfig().tvcLagEnabled;
    sceneManager.setFaultConfig({ tvcLagEnabled: !cur });
    tvcLagBtn.textContent = !cur ? "TVC LAG: ON" : "TVC LAG: OFF";
    tvcLagBtn.classList.toggle("active", !cur);
    syncNow();
  });
  const resetFaultsBtn = el("button", "action-btn", "RESET FAULTS", "Restore nominal zero-fault conditions");
  resetFaultsBtn.type = "button";
  resetFaultsBtn.addEventListener("click", () => {
    sceneManager.resetFaults();
    const def: FaultConfig = sceneManager.getFaultConfig();
    fThrust.input.value = String(def.thrustLossPct);
    fThrust.valStrong.textContent = `${def.thrustLossPct}${fThrust.unit}`;
    fAlt.input.value = String(def.thrustLossTriggerAltM);
    fAlt.valStrong.textContent = `${def.thrustLossTriggerAltM}${fAlt.unit}`;
    fWind.input.value = String(def.windSpeedMps);
    fWind.valStrong.textContent = `${def.windSpeedMps}${fWind.unit}`;
    fBias.input.value = String(def.imuBiasDeg);
    fBias.valStrong.textContent = `${def.imuBiasDeg}${fBias.unit}`;
    fNoise.input.value = String(def.imuNoiseDeg);
    fNoise.valStrong.textContent = `${def.imuNoiseDeg}${fNoise.unit}`;
    tvcLagBtn.textContent = "TVC LAG: OFF";
    tvcLagBtn.classList.remove("active");
    syncNow();
  });
  faultBtnRow.append(tvcLagBtn, resetFaultsBtn);
  faultsView.append(faultBtnRow);
  tabViews.set("faults", faultsView);

  // Tab 4: MONTE CARLO
  const mcView = el("div", "section-divider");
  let mcPilot: MonteCarloPilot = "ai_ppo";
  const mcPilotRow = el("div", "action-row");
  const mcAiBtn = el("button", "action-btn active", "PILOT: AI NEURAL");
  mcAiBtn.type = "button";
  const mcPidBtn = el("button", "action-btn", "PILOT: PID AUTO");
  mcPidBtn.type = "button";
  mcAiBtn.addEventListener("click", () => {
    mcPilot = "ai_ppo";
    mcAiBtn.classList.add("active");
    mcPidBtn.classList.remove("active");
  });
  mcPidBtn.addEventListener("click", () => {
    mcPilot = "autopilot";
    mcPidBtn.classList.add("active");
    mcAiBtn.classList.remove("active");
  });
  mcPilotRow.append(mcAiBtn, mcPidBtn);

  const mcRunRow = el("div", "action-row");
  for (const n of [20, 50, 100]) {
    const rb = el(
      "button",
      "action-btn primary",
      `RUN ${n} TRIALS`,
      `Run ${n} domain-randomized headless Monte Carlo trials in Web Worker`
    );
    rb.type = "button";
    rb.addEventListener("click", () => {
      if (sceneManager.isMonteCarloRunning()) return;
      mcStatusText = `Running ${n} Monte Carlo trials off-thread...`;
      if (mcStatusEl) mcStatusEl.textContent = mcStatusText;
      sceneManager.runMonteCarlo(n, mcPilot);
    });
    mcRunRow.append(rb);
  }
  mcStatusEl = el("div", "planet-subtitle", mcStatusText);
  mcSummaryEl = el("div", "mc-summary-grid");
  mcSummaryEl.style.display = "none";
  mcView.append(mcPilotRow, mcRunRow, mcStatusEl, mcSummaryEl);
  tabViews.set("mc", mcView);

  // Tab 5: EXPORT
  const exportView = el("div", "export-stack");
  const expFlightBtn = el(
    "button",
    "action-btn primary",
    "Export Flight Telemetry (.csv)",
    "Download high-rate time-series flight telemetry log as CSV"
  );
  expFlightBtn.type = "button";
  expFlightBtn.addEventListener("click", () => {
    const csv = formatFlightTelemetryCSV(sceneManager.getFlightLog());
    const tel = sceneManager.getFlightTelemetry();
    triggerBrowserDownload(
      `aethersim-flight-${tel.planetId}-${tel.missionMode}.csv`,
      csv,
      "text/csv;charset=utf-8"
    );
  });

  const expTrainBtn = el(
    "button",
    "action-btn primary",
    "Export RL Training History (.csv)",
    "Download PPO learning curves, losses & success rate history as CSV"
  );
  expTrainBtn.type = "button";
  expTrainBtn.addEventListener("click", () => {
    const csv = formatTrainingHistoryCSV(sceneManager.getTrainingHistory());
    triggerBrowserDownload("aethersim-ppo-training.csv", csv, "text/csv;charset=utf-8");
  });

  const expBundleBtn = el(
    "button",
    "action-btn",
    "Export Full Experiment Bundle (.json)",
    "Download reproducible JSON manifest with faults, Monte Carlo CI, training & flight data"
  );
  expBundleBtn.type = "button";
  expBundleBtn.addEventListener("click", () => {
    const tel = sceneManager.getFlightTelemetry();
    const json = buildExperimentBundleJSON({
      aethersimVersion: APP_VERSION,
      planet: tel.planetId,
      mission: tel.missionMode,
      pilot: tel.controlMode,
      faultConfig: sceneManager.getFaultConfig(),
      monteCarloSummary: mcSummary,
      trainingHistory: sceneManager.getTrainingHistory(),
      flightSeries: sceneManager.getFlightLog(),
    });
    triggerBrowserDownload(
      `aethersim-experiment-${tel.planetId}-${tel.missionMode}.json`,
      json,
      "application/json"
    );
  });

  const expInfo = el(
    "div",
    "planet-subtitle",
    "Exports include true physical state, active faults, Clopper-Pearson Monte Carlo statistics, and PPO training telemetry."
  );
  exportView.append(expFlightBtn, expTrainBtn, expBundleBtn, expInfo);
  tabViews.set("export", exportView);

  labPanel.append(labHead, tabBar, plotsView, nnView, faultsView, mcView, exportView);
  setActiveTab("plots");

  const setLabOpen = (open: boolean) => {
    labOpen = open;
    labPanel.style.display = open ? "flex" : "none";
    labToggleBtn.classList.toggle("active", open);
    if (open) {
      lastChartRepaintMs = 0;
      repaintResearchCanvases(true);
    }
  };
  labToggleBtn.addEventListener("click", () => setLabOpen(!labOpen));
  labCloseBtn.addEventListener("click", () => setLabOpen(false));

  leftToggleBtn.addEventListener("click", () => {
    leftDeckOpen = !leftDeckOpen;
    leftDeck.style.display = leftDeckOpen ? "flex" : "none";
    leftToggleBtn.classList.toggle("active", leftDeckOpen);
  });

  midRow.append(leftDeck, labPanel);

  // =========================================================================
  // 3. BOTTOM SPACEX WEBCAST TELEMETRY STRIP
  // =========================================================================
  const bottomStrip = el("footer", "hud-card hud-bottom-strip");
  const webcastMain = el("div", "webcast-main");

  const gauges = el("div", "webcast-gauges");
  const tClockEl = el("span", "tclock-label", "T-00:10.0");
  const phaseBadge = el("span", "phase-badge", "PRELAUNCH");
  gauges.append(tClockEl, phaseBadge);

  const makeGauge = (label: string) => {
    const item = el("div", "telemetry-item");
    const val = el("span", "telemetry-value", "-");
    item.append(el("span", "telemetry-label", label), val);
    gauges.append(item);
    return val;
  };
  const altVal = makeGauge("ALT");
  const spdVal = makeGauge("SPEED");
  const vyVal = makeGauge("VERT VEL");
  const thrVal = makeGauge("THROTTLE");
  const gVal = makeGauge("G-LOAD");
  const qVal = makeGauge("DYN PRESS");

  const fuelInline = el("div", "fuel-bars-inline");
  const makeFuelMini = (label: string) => {
    const wrap = el("div", "fuel-mini");
    const track = el("div", "fuel-track");
    const fill = el("div", "fuel-fill");
    fill.style.width = "100%";
    track.append(fill);
    const pct = el("span", undefined, "100%");
    wrap.append(el("span", undefined, label), track, pct);
    fuelInline.append(wrap);
    return { fill, pct };
  };
  const boosterBar = makeFuelMini("BOOSTER");
  const shipBar = makeFuelMini("SHIP");

  const verdictBanner = el("div", "status-banner");
  verdictBanner.style.display = "none";

  webcastMain.append(gauges, fuelInline, verdictBanner);

  const manualHint = el(
    "div",
    "manual-hint",
    "MANUAL: W/Shift +Thr · S/Ctrl -Thr · Z 100% · X 0% · Arrows/IJKL Tilt · Q/E Roll · T SAS · G Legs · Space Start/Sep"
  );
  manualHint.style.display = "none";

  const footerMeta = el("div", "webcast-footer");
  const metaLeft = el("div", "topbar-group");
  const fpsPill = el("span", "status-pill");
  const fpsStrong = el("strong", undefined, "--");
  fpsPill.append(document.createTextNode("FPS "), fpsStrong);

  const drawPill = el("span", "status-pill");
  const drawStrong = el("strong", undefined, "--");
  drawPill.append(document.createTextNode("DRAWS "), drawStrong);

  const envPill = el("span", "status-pill");
  envPill.append(
    document.createTextNode("MODE "),
    el("strong", undefined, isElectron ? "DESKTOP" : "BROWSER")
  );

  const faultPill = el("span", "status-pill");
  const faultStrong = el("strong", undefined, "NOMINAL");
  faultPill.append(document.createTextNode("FAULTS "), faultStrong);

  metaLeft.append(fpsPill, drawPill, envPill, faultPill);

  const metaRight = el("div", "topbar-group");
  const gpuPill = el("span", "status-pill");
  const gpuStrong = el("strong", "gpu-label", sceneManager.getRendererName());
  gpuStrong.title = sceneManager.getRendererName();
  gpuPill.append(document.createTextNode("GPU "), gpuStrong);

  const resetCamBtn = el("button", "action-btn", "Reset Cam", "Re-lock camera onto Starship");
  resetCamBtn.type = "button";
  resetCamBtn.addEventListener("click", () => sceneManager.resetCamera());
  metaRight.append(gpuPill, resetCamBtn);

  footerMeta.append(metaLeft, metaRight);
  bottomStrip.append(webcastMain, manualHint, footerMeta);

  // =========================================================================
  // 4. HELP / QUICK-REFERENCE MODAL
  // =========================================================================
  const helpBackdrop = el("div", "help-modal-backdrop");
  helpBackdrop.style.display = "none";
  const helpModal = el("div", "hud-card help-modal");
  helpModal.innerHTML = `
    <div class="panel-header">
      <h3>AetherSim v${APP_VERSION} — Quick Guide &amp; Controls</h3>
      <button type="button" class="action-btn" id="close-help-btn">CLOSE</button>
    </div>
    <p><strong>3-Step Neural AI Workflow:</strong></p>
    <ul>
      <li><strong>1. Pre-Train Brain (Fast):</strong> Imitates classical guidance (~1–2s), runs 5 deterministic evals, and saves the best brain.</li>
      <li><strong>2. Fast Train (PPO):</strong> Fine-tunes silently in a background Web Worker while protecting the Best Saved Brain from collapse.</li>
      <li><strong>3. Fly Trained AI (3D):</strong> One click pauses training, loads the Best Saved Brain, resets Starship, and flies deterministically in 3D.</li>
    </ul>
    <p><strong>Keyboard Shortcuts:</strong></p>
    <ul>
      <li><code>1 / 2 / 3</code> Switch Mars / Earth / Moon</li>
      <li><code>F1 – F5</code> Camera Presets (Pad, Drone, Engine, Station, Free Orbit)</li>
      <li><code>Space</code> Start mission / Trigger Stage Separation · <code>R</code> Reset &amp; Re-lock Camera</li>
      <li><code>T</code> Toggle SAS · <code>G</code> Toggle Landing Legs</li>
      <li><code>Manual Pilot:</code> <code>W/Shift</code> &amp; <code>S/Ctrl</code> Throttle · <code>Z/X</code> 100%/0% · <code>Arrows/IJKL</code> Tilt · <code>Q/E</code> Roll</li>
    </ul>
  `;
  helpBackdrop.append(helpModal);
  const closeHelpBtn = helpModal.querySelector("#close-help-btn") as HTMLButtonElement;
  closeHelpBtn.addEventListener("click", () => {
    helpBackdrop.style.display = "none";
  });
  helpBackdrop.addEventListener("click", (e) => {
    if (e.target === helpBackdrop) helpBackdrop.style.display = "none";
  });
  helpBtn.addEventListener("click", () => {
    helpBackdrop.style.display = helpBackdrop.style.display === "none" ? "flex" : "none";
  });

  hudRoot.append(topBar, midRow, bottomStrip, helpBackdrop);

  // =========================================================================
  // 5. UI SYNCHRONIZATION & 15 Hz RESEARCH CANVAS THROTTLING
  // =========================================================================
  function repaintResearchCanvases(force = false): void {
    if (!labOpen) return;
    const now = performance.now();
    if (!force && now - lastChartRepaintMs < 62) {
      return; // ~16 Hz cap so WebGL stays 60 FPS
    }
    lastChartRepaintMs = now;
    if (activeTab === "plots") {
      charts.render(sceneManager.getFlightLog(), sceneManager.getTrainingHistory());
    } else if (activeTab === "nn") {
      nnViz.render(sceneManager.getLastAIActivations());
    }
  }

  function updateUI(t: SceneTelemetry): void {
    const cfg = sceneManager.getPlanet();
    for (const [id, btn] of planetBtns.entries()) {
      btn.classList.toggle("active", id === cfg.id);
    }
    planetSub.textContent = `${cfg.name} · ${cfg.physics.gravityMps2.toFixed(2)} m/s²`;

    const f = t.flight;
    launchBtn.classList.toggle("active", f.missionMode === "launch");
    landingBtn.classList.toggle("active", f.missionMode === "landing");
    aiPilotBtn.classList.toggle("active", f.controlMode === "ai_ppo");
    pidPilotBtn.classList.toggle("active", f.controlMode === "autopilot");
    manPilotBtn.classList.toggle("active", f.controlMode === "manual");

    for (const [p, b] of camBtns.entries()) {
      b.classList.toggle("active", p === t.cameraPreset);
    }
    autoDirBtn.classList.toggle("active", t.autoDirector);
    for (const [q, b] of qualBtns.entries()) {
      b.classList.toggle("active", q === t.quality);
    }
    audioBtn.textContent = t.audioMuted ? "AUDIO: OFF" : "AUDIO: ON";
    audioBtn.classList.toggle("active", !t.audioMuted);

    sasBtn.classList.toggle("active", f.sasEnabled);
    sasBtn.textContent = f.sasEnabled ? "SAS: ON [T]" : "SAS: OFF [T]";
    pauseBtn.textContent = f.paused ? "RESUME" : "PAUSE";
    focusBtn.textContent =
      sceneManager.getFocusMode() === "rocket" ? "FOCUS: ROCKET" : "FOCUS: PAD";
    manualHint.style.display = f.controlMode === "manual" ? "block" : "none";

    // Crystal-Clear AI Status Banner, Scorecard & Controls
    const ai = t.ai;
    const m = ai.metrics;
    const best = ai.bestBrain;

    aiStatePill.textContent =
      ai.mode === "pre_training"
        ? "PRE-TRAIN"
        : ai.mode === "live_train"
          ? "LIVE 3D"
          : ai.mode === "turbo_train"
            ? "TRAINING"
            : ai.mode === "eval"
              ? "FLYING AI"
              : "IDLE";
    aiStatePill.className = `ai-state-pill ${
      ai.mode === "pre_training" || ai.mode === "live_train" || ai.mode === "turbo_train"
        ? "training"
        : ai.mode === "eval"
          ? "eval"
          : ""
    }`;

    if (ai.mode === "pre_training") {
      aiStatusBanner.className = "ai-status-banner status-pretrain";
      aiStatusDot.className = "ai-status-dot pulsing";
      aiStatusText.textContent = "PRE-TRAINING BRAIN... (Imitating Guidance)";
    } else if (ai.mode === "turbo_train") {
      aiStatusBanner.className = "ai-status-banner status-turbo";
      aiStatusDot.className = "ai-status-dot pulsing";
      aiStatusText.textContent = `TRAINING IN BACKGROUND... (Ep ${m.episodesCompleted} | ${m.stepsPerSec.toLocaleString("en-US")} st/s)`;
    } else if (ai.mode === "live_train") {
      aiStatusBanner.className = "ai-status-banner status-live";
      aiStatusDot.className = "ai-status-dot pulsing";
      aiStatusText.textContent = `WATCHING AI LEARN LIVE (3D Ep ${m.episodesCompleted})`;
    } else if (ai.mode === "eval") {
      aiStatusBanner.className = best.hasTrainedWeights
        ? "ai-status-banner status-eval"
        : "ai-status-banner status-idle-untrained";
      aiStatusDot.className = "ai-status-dot";
      aiStatusText.textContent = best.hasTrainedWeights
        ? "FLYING BEST TRAINED AI (DETERMINISTIC)"
        : "FLYING UNTRAINED BRAIN (Will Crash)";
    } else if (best.hasTrainedWeights) {
      aiStatusBanner.className = "ai-status-banner status-idle-ready";
      aiStatusDot.className = "ai-status-dot";
      aiStatusText.textContent = `IDLE — READY (${best.evalSafeRatePct.toFixed(0)}% Safe · ${best.evalSuccessCount}/${best.evalEpisodes} Nom)`;
    } else {
      aiStatusBanner.className = "ai-status-banner status-idle-untrained";
      aiStatusDot.className = "ai-status-dot";
      aiStatusText.textContent = "IDLE — UNTRAINED BRAIN (Will Crash)";
    }

    aiStatusNote.textContent = ai.statusMessage;

    warmStartBtn.disabled = ai.mode === "pre_training";
    warmStartBtn.textContent =
      ai.mode === "pre_training" ? "PRE-TRAINING..." : "1. PRE-TRAIN BRAIN (FAST)";
    turboTrainBtn.textContent =
      ai.mode === "turbo_train" ? "STOP TRAINING" : "2. FAST TRAIN (PPO)";
    turboTrainBtn.classList.toggle("btn-stop-active", ai.mode === "turbo_train");
    turboTrainBtn.classList.toggle("active", ai.mode === "turbo_train");
    flyTrainedBtn.classList.toggle("active", ai.mode === "eval");
    liveTrainBtn.textContent =
      ai.mode === "live_train" ? "STOP LIVE 3D" : "WATCH AI CRASH & LEARN (3D)";
    liveTrainBtn.classList.toggle("active", ai.mode === "live_train");

    randBtn.classList.toggle("active", ai.randomizeSpawn);
    randBtn.textContent = ai.randomizeSpawn ? "RAND: ON" : "RAND: OFF";
    for (const [lr, b] of lrBtns.entries()) {
      b.classList.toggle("active", Math.abs(ai.learningRate - lr) < 1e-6);
    }

    const levelLabel =
      ai.brainLevel === "ppo_trained"
        ? "PPO TRAINED"
        : ai.brainLevel === "pre_trained"
          ? "PRE-TRAINED"
          : "UNTRAINED";
    aiBrainLevelRow.val.textContent = levelLabel;
    aiBrainLevelRow.val.className = `telemetry-value brain-level-badge ${ai.brainLevel}`;

    aiBestSuccessRow.lbl.textContent =
      f.missionMode === "landing" ? "Best Landing" : "Best Launch";
    if (!best.hasTrainedWeights || best.evalEpisodes === 0) {
      aiBestSuccessRow.val.textContent = "Not Eval";
    } else if (f.missionMode === "landing") {
      aiBestSuccessRow.val.textContent =
        best.evalSuccessCount === best.evalEpisodes
          ? `100% (${best.evalEpisodes}/${best.evalEpisodes} nom)`
          : `${best.evalSafeRatePct.toFixed(0)}% safe (${best.evalSuccessCount}/${best.evalEpisodes} nom)`;
    } else {
      aiBestSuccessRow.val.textContent = `${best.evalSuccessRatePct.toFixed(0)}% (${best.evalSuccessCount}/${best.evalEpisodes})`;
    }

    aiEpRow.val.textContent = `${m.episodesCompleted}`;
    aiRateRow.val.textContent =
      m.stepsPerSec > 0 ? `${m.stepsPerSec.toLocaleString("en-US")} st/s` : "0 st/s";
    aiMeanRetRow.val.textContent =
      m.episodesCompleted > 0 ? m.rollingMeanReturn.toFixed(1) : "—";
    aiBestRetRow.val.textContent = best.hasTrainedWeights
      ? best.evalMeanReturn.toFixed(1)
      : "—";

    if (ai.lastError) {
      aiErrBanner.style.display = "block";
      aiErrBanner.textContent = `AI ERROR: ${ai.lastError}`;
    } else {
      aiErrBanner.style.display = "none";
    }

    // Bottom webcast telemetry
    tClockEl.textContent = formatTClock(f.tClockSec);
    phaseBadge.textContent = f.phase;
    altVal.textContent =
      f.altitudeM >= 1000 ? `${(f.altitudeM / 1000).toFixed(2)} km` : `${f.altitudeM.toFixed(1)} m`;
    spdVal.textContent = `${f.speedMps.toFixed(1)} m/s`;
    vyVal.textContent = `${f.verticalSpeedMps >= 0 ? "+" : ""}${f.verticalSpeedMps.toFixed(1)} m/s`;
    thrVal.textContent = `${Math.round(f.throttle * 100)}%`;
    gVal.textContent = `${f.gLoad.toFixed(2)} g`;
    qVal.textContent = `${(f.dynamicPressurePa / 1000).toFixed(2)} kPa`;

    const bPct = Math.round(f.boosterFuel * 100);
    boosterBar.fill.style.width = `${bPct}%`;
    boosterBar.pct.textContent = `${bPct}%`;
    const sPct = Math.round(f.shipFuel * 100);
    shipBar.fill.style.width = `${sPct}%`;
    shipBar.pct.textContent = `${sPct}%`;

    if (f.crashEvent) {
      verdictBanner.style.display = "block";
      verdictBanner.className = "status-banner crash";
      verdictBanner.textContent = `RUD (${f.crashEvent.cause}) · ${f.crashEvent.impactSpeedMps.toFixed(1)} m/s`;
    } else if (f.landingVerdict !== "NONE") {
      verdictBanner.style.display = "block";
      const cls =
        f.landingVerdict === "NOMINAL LANDING"
          ? "nominal"
          : f.landingVerdict === "HARD LANDING"
            ? "hard"
            : "crash";
      verdictBanner.className = `status-banner ${cls}`;
      verdictBanner.textContent = `${f.landingVerdict} · |vy|=${f.touchdownVerticalSpeedMps?.toFixed(2) ?? "-"} m/s`;
    } else if (f.maxQReached && f.missionMode === "launch") {
      verdictBanner.style.display = "block";
      verdictBanner.className = "status-banner maxq";
      verdictBanner.textContent = `MAX-Q ${(f.maxQPa / 1000).toFixed(1)} kPa`;
    } else {
      verdictBanner.style.display = "none";
    }

    fpsStrong.textContent = String(t.fps);
    drawStrong.textContent = `${t.drawCalls}`;
    faultStrong.textContent = f.activeFaults;
    gpuStrong.textContent = t.rendererName;

    repaintResearchCanvases(false);
  }

  function syncNow(): void {
    const snap: SceneTelemetry = {
      fps: latestTelemetry?.fps ?? 0,
      rendererName: sceneManager.getRendererName(),
      drawCalls: latestTelemetry?.drawCalls ?? 0,
      triangles: latestTelemetry?.triangles ?? 0,
      quality: sceneManager.getQualityPreset(),
      cameraPreset: sceneManager.getCameraPreset(),
      autoDirector: sceneManager.getAutoDirector(),
      audioMuted: sceneManager.isAudioMuted(),
      flight: sceneManager.getFlightTelemetry(),
      ai: sceneManager.getAIStatus(),
    };
    updateUI(snap);
    if (window.__STARSHIP_SIM__) {
      window.__STARSHIP_SIM__.version = APP_VERSION;
      window.__STARSHIP_SIM__.planet = snap.flight.planetId;
      window.__STARSHIP_SIM__.missionMode = snap.flight.missionMode;
      window.__STARSHIP_SIM__.controlMode = snap.flight.controlMode;
      window.__STARSHIP_SIM__.phase = snap.flight.phase;
      window.__STARSHIP_SIM__.quality = snap.quality;
      window.__STARSHIP_SIM__.sasEnabled = snap.flight.sasEnabled;
      window.__STARSHIP_SIM__.crashed = snap.flight.phase === "CRASHED";
      window.__STARSHIP_SIM__.aiState = snap.ai.mode;
      window.__STARSHIP_SIM__.aiBrainLevel = snap.ai.brainLevel;
      window.__STARSHIP_SIM__.aiBestSuccessPct = snap.ai.bestBrain.evalSuccessRatePct;
      window.__STARSHIP_SIM__.aiEpisodes = snap.ai.metrics.episodesCompleted;
      window.__STARSHIP_SIM__.aiTotalSteps = snap.ai.metrics.totalSteps;
      window.__STARSHIP_SIM__.aiMeanReturn = snap.ai.metrics.rollingMeanReturn;
      window.__STARSHIP_SIM__.cameraPreset = snap.cameraPreset;
      window.__STARSHIP_SIM__.audioMuted = snap.audioMuted;
    }
  }

  function selectPlanet(id: PlanetId): void {
    sceneManager.setPlanet(id);
    syncNow();
  }

  syncNow();
  const initialTel = sceneManager.getFlightTelemetry();
  const initialAI = sceneManager.getAIStatus();
  window.__STARSHIP_SIM__ = {
    ready: true,
    version: APP_VERSION,
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
    aiState: initialAI.mode,
    aiBrainLevel: initialAI.brainLevel,
    aiBestSuccessPct: initialAI.bestBrain.evalSuccessRatePct,
    aiEpisodes: initialAI.metrics.episodesCompleted,
    aiTotalSteps: initialAI.metrics.totalSteps,
    aiMeanReturn: initialAI.metrics.rollingMeanReturn,
    cameraPreset: sceneManager.getCameraPreset(),
    audioMuted: sceneManager.isAudioMuted(),
  };

  window.__AETHERSIM_PROFILER__ = {
    setPlanet: (id) => {
      selectPlanet(id);
    },
    setQuality: (q) => {
      sceneManager.setQualityPreset(q);
      syncNow();
    },
    startMission: () => {
      sceneManager.startMission();
      syncNow();
    },
    resetMission: () => {
      sceneManager.resetMission();
      syncNow();
    },
    sampleFrames: (durationMs = 3000) =>
      new Promise((resolve) => {
        const frameDeltas: number[] = [];
        let last = performance.now();
        const start = last;
        const step = (now: number) => {
          const dtMs = now - last;
          last = now;
          if (dtMs > 0) {
            frameDeltas.push(dtMs);
          }
          if (now - start >= durationMs && frameDeltas.length >= 2) {
            const sorted = [...frameDeltas].sort((a, b) => a - b);
            const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
            const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1] ?? 0;
            const elapsedSec = Math.max(0.001, (now - start) / 1000);
            const rect = canvas.getBoundingClientRect();
            const perfMem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
            const sim = window.__STARSHIP_SIM__;
            resolve({
              frames: frameDeltas.length,
              durationMs: Math.round(now - start),
              avgFps: frameDeltas.length / elapsedSec,
              p50FrameMs: p50,
              p95FrameMs: p95,
              drawCalls: sim?.drawCalls ?? 0,
              triangles: sim?.triangles ?? 0,
              rendererName: sceneManager.getRendererName(),
              jsHeapUsedMB: perfMem
                ? Number((perfMem.usedJSHeapSize / (1024 * 1024)).toFixed(1))
                : null,
              canvasWidth: Math.round(rect.width),
              canvasHeight: Math.round(rect.height),
            });
            return;
          }
          window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
      }),
  };

  // Keyboard bindings (preserving all M1/M2 controls + F1-F5 cameras)
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
    } else if (event.code === "F1") {
      event.preventDefault();
      sceneManager.setCameraPreset("pad");
      syncNow();
    } else if (event.code === "F2") {
      event.preventDefault();
      sceneManager.setCameraPreset("drone");
      syncNow();
    } else if (event.code === "F3") {
      event.preventDefault();
      sceneManager.setCameraPreset("engine");
      syncNow();
    } else if (event.code === "F4") {
      event.preventDefault();
      sceneManager.setCameraPreset("station");
      syncNow();
    } else if (event.code === "F5") {
      event.preventDefault();
      sceneManager.setCameraPreset("orbit");
      syncNow();
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
