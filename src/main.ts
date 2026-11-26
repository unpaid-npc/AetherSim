import "./style.css";
import gsap from "gsap";
import pkg from "../package.json";
import { getLaunchSiteConfig } from "./config/launchSites";
import { DEFAULT_PLANET_ID, type PlanetId } from "./config/planets";
import { getVehicleConfig } from "./config/vehicles";
import { triggerBrowserDownload } from "./research/DataExporter";
import { SceneManager, type SceneTelemetry } from "./scene/SceneManager";
import type { BoosterStatus, FlightPhase, TimeWarp } from "./sim/FlightController";
import { AIPilotDrawer } from "./ui/AIPilotDrawer";
import { CameraDock } from "./ui/CameraDock";
import { el } from "./ui/dom";
import { FlightHud } from "./ui/FlightHud";
import {
  applyReducedMotionToDocument,
  loadReducedMotionOverride,
  resolveReducedMotion,
  saveReducedMotionOverride,
} from "./ui/formatters";
import { HelpModal } from "./ui/HelpModal";
import { MissionDrawer } from "./ui/MissionDrawer";
import { OrbitalDrawer } from "./ui/OrbitalDrawer";
import { ResearchDrawer } from "./ui/ResearchDrawer";
import { ToastSystem } from "./ui/ToastSystem";
import { TopBar } from "./ui/TopBar";
import {
  type DrawerSlotId,
  type OverlayState,
  closeActiveOverlayOnEscape,
  createInitialOverlayState,
  setDrawerSlotOpen,
} from "./ui/uiGuards";

const APP_VERSION = pkg.version;
const WARP_LEVELS: readonly TimeWarp[] = [1, 2, 5, 10, 25, 50];

function showFatalStartupBanner(title: string, detail: string): void {
  const existing = document.getElementById("aether-fatal-banner");
  const container = existing ?? document.createElement("div");
  container.id = "aether-fatal-banner";
  container.style.cssText = [
    "position:fixed",
    "inset:24px",
    "z-index:99999",
    "display:flex",
    "flex-direction:column",
    "gap:12px",
    "padding:20px 24px",
    "border-radius:12px",
    "border:1px solid #f87171",
    "background:rgba(10,14,24,0.96)",
    "color:#f8fafc",
    "font-family:'Segoe UI',system-ui,sans-serif",
    "box-shadow:0 20px 50px rgba(0,0,0,0.7)",
    "overflow:auto",
  ].join(";");

  container.innerHTML = "";
  const heading = document.createElement("h2");
  heading.textContent = title;
  heading.style.cssText = "margin:0;color:#fca5a5;font-size:18px;font-weight:700;";

  const pre = document.createElement("pre");
  pre.textContent = detail;
  pre.style.cssText =
    "margin:0;padding:12px;border-radius:8px;background:#05070d;border:1px solid rgba(248,113,113,0.3);color:#e2e8f0;font-family:'Cascadia Mono','Consolas',monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;overflow:auto;flex:1;";

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:10px;align-items:center;";
  const reloadBtn = document.createElement("button");
  reloadBtn.type = "button";
  reloadBtn.textContent = "Reload Simulator";
  reloadBtn.style.cssText =
    "padding:8px 16px;border-radius:8px;border:1px solid #38bdf8;background:rgba(56,189,248,0.2);color:#eef4fb;font-weight:600;cursor:pointer;";
  reloadBtn.addEventListener("click", () => window.location.reload());
  actions.append(reloadBtn);

  container.append(heading, pre, actions);
  if (!existing) {
    (document.body ?? document.documentElement).append(container);
  }
}

window.addEventListener("error", (event) => {
  const detail =
    event.error instanceof Error
      ? event.error.stack ?? event.error.message
      : `${event.message} (${event.filename}:${event.lineno})`;
  console.error("[AetherSim Error]", detail);
  if (!window.__STARSHIP_SIM__?.ready) {
    showFatalStartupBanner("AetherSim failed to initialize", detail);
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const detail =
    event.reason instanceof Error ? event.reason.stack ?? event.reason.message : String(event.reason);
  console.error("[AetherSim Unhandled Rejection]", detail);
  if (!window.__STARSHIP_SIM__?.ready) {
    showFatalStartupBanner("AetherSim async startup failure", detail);
  }
});

interface EventSnapshot {
  planet: PlanetId;
  phase: FlightPhase;
  maxQReached: boolean;
  sideBoostersSeparated: boolean;
  stageSeparated: boolean;
  orbitAchieved: boolean;
  boosterStatus: BoosterStatus;
}

function bootstrap(): void {
  const canvas = document.getElementById("sim-canvas");
  const hudRoot = document.getElementById("hud-root");
  if (!(canvas instanceof HTMLCanvasElement) || !(hudRoot instanceof HTMLElement)) {
    throw new Error("Missing #sim-canvas or #hud-root in index.html");
  }

  const isElectron = Boolean(window.desktopApp?.isElectron);

  // Reduced motion state (honors OS media preference + explicit user toggle)
  const motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotionOverride = loadReducedMotionOverride();
  let reducedMotion = resolveReducedMotion(motionMedia.matches, reducedMotionOverride);
  applyReducedMotionToDocument(reducedMotion);
  gsap.defaults({ duration: reducedMotion ? 0 : 0.24 });

  let latestTelemetry: SceneTelemetry | null = null;
  let prevEvent: EventSnapshot | null = null;

  const toasts = new ToastSystem();
  const helpModal = new HelpModal(APP_VERSION);

  let topBar: TopBar;
  let missionDrawer: MissionDrawer;
  let orbitalDrawer: OrbitalDrawer;
  let aiDrawer: AIPilotDrawer;
  let researchDrawer: ResearchDrawer;
  let cameraDock: CameraDock;
  let flightHud: FlightHud;

  const syncDiagnostics = (t: SceneTelemetry): void => {
    window.__STARSHIP_SIM__ = {
      ready: true,
      version: APP_VERSION,
      planet: t.flight.planetId,
      launchSiteId: t.launchSiteId,
      vehicleId: t.vehicleId,
      missionMode: t.flight.missionMode,
      controlMode: t.flight.controlMode,
      phase: t.flight.phase,
      quality: t.quality,
      autoQualityEnabled: t.autoQualityEnabled,
      sasEnabled: t.flight.sasEnabled,
      crashed: t.flight.phase === "CRASHED",
      fps: t.fps,
      rendererName: t.rendererName,
      cpuModel: t.hardware.cpuModel,
      cpuCores: t.hardware.cpuCores,
      totalRamGb: t.hardware.totalRamGb,
      gpuShortName: t.hardware.gpuShortName,
      gpuTier: t.hardware.gpuTier,
      gpuTag: t.hardware.gpuTag,
      isHybridOnIgpu: t.hardware.isHybridOnIgpu,
      detectedDiscreteGpuName: t.hardware.detectedDiscreteGpuName,
      estimatedVramMB: t.hardware.estimatedVramMB,
      glbLoadedCount: t.hardware.glbLoadedCount,
      shadowCascades: t.hardware.shadowCascades,
      isElectron,
      drawCalls: t.drawCalls,
      triangles: t.triangles,
      canvasNonBlackPct: t.canvasNonBlackPct,
      canvasMeanRgb: t.canvasMeanRgb,
      aiState: t.ai.mode,
      aiBrainLevel: t.ai.brainLevel,
      aiBestSuccessPct: t.ai.bestBrain.evalSuccessRatePct,
      aiEpisodes: t.ai.metrics.episodesCompleted,
      aiTotalSteps: t.ai.metrics.totalSteps,
      aiMeanReturn: t.ai.metrics.rollingMeanReturn,
      cameraPreset: t.cameraPreset,
      trackTarget: t.trackTarget,
      boosterStatus: t.flight.booster.status,
      audioMuted: t.audioMuted,
      orbitAchieved: t.flight.orbital.orbitAchieved,
      timeWarp: t.flight.orbital.timeWarp,
      reducedMotion,
      gibsTilesLoaded: t.gibsTilesLoaded,
      orbitalObjectCount: t.orbitalObjects.length,
      orbitalDataSource: t.orbitalProvenance.dataSource,
      selectedOrbitalId: t.selectedOrbitalId,
      inspectedOrbitalId: t.inspectedOrbitalId,
    };
  };

  const checkFlightToasts = (t: SceneTelemetry): void => {
    const f = t.flight;
    const curr: EventSnapshot = {
      planet: f.planetId,
      phase: f.phase,
      maxQReached: f.maxQReached,
      sideBoostersSeparated: f.sideBoostersSeparated,
      stageSeparated: f.stageSeparated,
      orbitAchieved: f.orbital.orbitAchieved,
      boosterStatus: f.booster.status,
    };

    if (!prevEvent || prevEvent.planet !== curr.planet || f.phase === "PRELAUNCH") {
      prevEvent = curr;
      return;
    }

    if (
      curr.phase === "LIFTOFF" &&
      (prevEvent.phase === "COUNTDOWN" || prevEvent.phase === "PRELAUNCH")
    ) {
      const site = getLaunchSiteConfig(t.launchSiteId);
      const veh = getVehicleConfig(t.vehicleId);
      toasts.show("Liftoff!", `${veh.shortName} ascending from ${site.shortName}`, "info");
    }
    if (curr.maxQReached && !prevEvent.maxQReached && f.missionMode === "launch") {
      toasts.show("Max-Q", `${(f.maxQPa / 1000).toFixed(1)} kPa peak dynamic pressure`, "warn");
    }
    if (curr.sideBoostersSeparated && !prevEvent.sideBoostersSeparated && f.missionMode === "launch") {
      const veh = getVehicleConfig(t.vehicleId);
      toasts.show(
        "Strap-on Separation",
        `${veh.sideBoosterLabel} burnout & clean jettison`,
        "info"
      );
    }
    if (curr.stageSeparated && !prevEvent.stageSeparated && f.missionMode === "launch") {
      const veh = getVehicleConfig(t.vehicleId);
      toasts.show(
        "Stage Separation",
        veh.rtlsCapable
          ? "Stage separated · Booster RTLS active"
          : "Core separation · Upper stage ignition",
        "info"
      );
    }
    if (curr.boosterStatus !== prevEvent.boosterStatus) {
      if (curr.boosterStatus === "BOOSTER_CAUGHT") {
        toasts.show(
          "Booster Caught!",
          `Mechazilla catch at ${f.booster.touchdownOffsetM?.toFixed(1) ?? "0.0"} m`,
          "ok"
        );
      } else if (curr.boosterStatus === "BOOSTER_LANDED") {
        toasts.show(
          "Booster Landed!",
          `RTLS touchdown ${f.booster.touchdownOffsetM?.toFixed(1) ?? "0.0"} m from pad`,
          "ok"
        );
      } else if (curr.boosterStatus === "BOOSTER_CRASHED") {
        toasts.show("Booster RUD", "Booster failed RTLS recovery", "danger");
      }
    }
    if (curr.orbitAchieved && !prevEvent.orbitAchieved && f.missionMode === "launch") {
      toasts.show(
        "Orbit Achieved!",
        `Ap ${(f.orbital.apoapsisAltM / 1000).toFixed(1)} km · Pe ${(f.orbital.periapsisAltM / 1000).toFixed(1)} km`,
        "ok"
      );
    }
    if (curr.phase === "TOUCHDOWN" && prevEvent.phase !== "TOUCHDOWN") {
      toasts.show(
        f.landingVerdict === "NOMINAL LANDING" ? "Nominal Landing!" : "Hard Landing",
        `|vy|=${f.touchdownVerticalSpeedMps?.toFixed(2) ?? "-"} m/s`,
        f.landingVerdict === "NOMINAL LANDING" ? "ok" : "warn"
      );
    }
    if (curr.phase === "CRASHED" && prevEvent.phase !== "CRASHED") {
      toasts.show("Vehicle RUD", f.crashEvent?.cause ?? "SURFACE_IMPACT", "danger");
    }

    prevEvent = curr;
  };

  const sceneManager = new SceneManager(
    canvas,
    DEFAULT_PLANET_ID,
    (telemetry) => {
      latestTelemetry = telemetry;
      updateUI(telemetry);
      syncDiagnostics(telemetry);
    },
    (summary) => {
      researchDrawer.renderMonteCarloSummary(summary);
    }
  );

  // Fetch host CPU / RAM / PCI GPU adapters from Electron main process when running in desktop shell
  if (window.aetherDesktop?.getSystemHardware) {
    void window.aetherDesktop
      .getSystemHardware()
      .then((hwInfo) => {
        sceneManager.setSystemHardwareInfo(hwInfo);
      })
      .catch(() => {
        // Browser or restricted preload — WebGL hardware parser still works cleanly
      });
  }

  const buildSnapshot = (): SceneTelemetry => {
    const orb = sceneManager.getOrbitalStateSnapshot();
    return {
      fps: latestTelemetry?.fps ?? 0,
      rendererName: sceneManager.getRendererName(),
      hardware: sceneManager.getHardwareDiagnostics(),
      drawCalls: latestTelemetry?.drawCalls ?? 0,
      triangles: latestTelemetry?.triangles ?? 0,
      canvasNonBlackPct: latestTelemetry?.canvasNonBlackPct ?? 0,
      canvasMeanRgb: latestTelemetry?.canvasMeanRgb ?? [0, 0, 0],
      quality: sceneManager.getQualityPreset(),
      autoQualityEnabled: sceneManager.isAutoQualityEnabled(),
      launchSiteId: sceneManager.getLaunchSite().id,
      vehicleId: sceneManager.getVehicle().id,
      cameraPreset: sceneManager.getCameraPreset(),
      trackTarget: sceneManager.getTrackTarget(),
      autoDirector: sceneManager.getAutoDirector(),
      padRangeHint: latestTelemetry?.padRangeHint ?? null,
      audioMuted: sceneManager.isAudioMuted(),
      orbitPathEnabled: sceneManager.isOrbitPathEnabled(),
      gibsTilesLoaded: sceneManager.isGibsTilesLoaded(),
      orbitalObjects: orb.objects,
      selectedOrbitalId: orb.selectedId,
      inspectedOrbitalId: orb.inspectedId,
      orbitalProvenance: orb.provenance,
      orbitalVisibility: orb.visibility,
      flight: sceneManager.getFlightTelemetry(),
      ai: sceneManager.getAIStatus(),
    };
  };

  function updateUI(t: SceneTelemetry): void {
    topBar.update(t);
    missionDrawer.update(t);
    orbitalDrawer.update(t);
    aiDrawer.update(t);
    cameraDock.update(t);
    flightHud.update(t);
    researchDrawer.repaintCanvases(false);
    checkFlightToasts(t);
  }

  function syncNow(): void {
    const snap = buildSnapshot();
    updateUI(snap);
    syncDiagnostics(snap);
  }

  let overlayState: OverlayState = createInitialOverlayState();

  const readLiveOverlayState = (): OverlayState => ({
    missionOpen: missionDrawer.isOpen(),
    aiOpen: aiDrawer.isOpen(),
    orbitsOpen: orbitalDrawer.isOpen(),
    researchOpen: researchDrawer.isOpen(),
    settingsOpen: topBar.isSettingsOpen(),
    helpOpen: helpModal.isOpen(),
  });

  const applyOverlayState = (next: OverlayState): void => {
    overlayState = next;
    missionDrawer.setOpen(next.missionOpen);
    aiDrawer.setOpen(next.aiOpen);
    orbitalDrawer.setOpen(next.orbitsOpen);
    researchDrawer.setOpen(next.researchOpen);
    topBar.setSettingsOpen(next.settingsOpen);
    helpModal.setOpen(next.helpOpen);
    topBar.setPanelStates({
      missionOpen: next.missionOpen,
      orbitsOpen: next.orbitsOpen,
      aiOpen: next.aiOpen,
      researchOpen: next.researchOpen,
    });
  };

  const syncDrawerStates = (): void => {
    overlayState = readLiveOverlayState();
    topBar.setPanelStates({
      missionOpen: overlayState.missionOpen,
      orbitsOpen: overlayState.orbitsOpen,
      aiOpen: overlayState.aiOpen,
      researchOpen: overlayState.researchOpen,
    });
  };

  const setDrawerSlot = (slot: DrawerSlotId, open: boolean): void => {
    const current = readLiveOverlayState();
    applyOverlayState(setDrawerSlotOpen(current, slot, open));
  };

  const setMissionOpen = (open: boolean): void => setDrawerSlot("mission", open);
  const setOrbitsOpen = (open: boolean): void => setDrawerSlot("orbits", open);
  const setAIOpen = (open: boolean): void => setDrawerSlot("ai", open);
  const setResearchOpen = (open: boolean): void => setDrawerSlot("research", open);

  const selectPlanet = (id: PlanetId): void => {
    sceneManager.setPlanet(id);
    prevEvent = null;
    syncNow();
  };

  topBar = new TopBar({
    version: APP_VERSION,
    onToggleMission: () => setMissionOpen(!missionDrawer.isOpen()),
    onToggleOrbits: () => setOrbitsOpen(!orbitalDrawer.isOpen()),
    onToggleAI: () => setAIOpen(!aiDrawer.isOpen()),
    onToggleResearch: () => setResearchOpen(!researchDrawer.isOpen()),
    onToggleHelp: () => helpModal.setOpen(!helpModal.isOpen()),
    onStartMission: () => {
      sceneManager.startMission();
      syncNow();
    },
    onTogglePause: () => {
      sceneManager.togglePause();
      syncNow();
    },
    onStageSep: () => {
      sceneManager.triggerStageSeparation();
      syncNow();
    },
    onResetMission: () => {
      sceneManager.resetMission();
      prevEvent = null;
      syncNow();
    },
    onSetTimeWarp: (warp) => {
      sceneManager.setTimeWarp(warp);
      syncNow();
    },
    onSetQuality: (q) => {
      sceneManager.setQualityPreset(q);
      syncNow();
    },
    onToggleAutoQuality: () => {
      const next = !sceneManager.isAutoQualityEnabled();
      sceneManager.setAutoQualityEnabled(next);
      toasts.show(
        next ? "Auto Quality Guard Enabled" : "Auto Quality Guard Disabled",
        next ? "Will step down HIGH → MED → LOW if FPS < 32 for 4s" : "Manual graphics preset locked",
        "info"
      );
      syncNow();
    },
    onToggleAudio: () => {
      sceneManager.setAudioMuted(!sceneManager.isAudioMuted());
      syncNow();
    },
    onToggleOrbitPath: () => {
      sceneManager.setOrbitPathEnabled(!sceneManager.isOrbitPathEnabled());
      syncNow();
    },
    onToggleSas: () => {
      sceneManager.toggleSas();
      syncNow();
    },
    onToggleLegs: () => {
      sceneManager.toggleLandingLegs();
      syncNow();
    },
    onToggleFocusMode: () => {
      const next = sceneManager.getFocusMode() === "rocket" ? "base" : "rocket";
      sceneManager.setFocusMode(next);
      syncNow();
    },
    onToggleReducedMotion: () => {
      reducedMotion = !reducedMotion;
      reducedMotionOverride = reducedMotion;
      saveReducedMotionOverride(reducedMotion);
      applyReducedMotionToDocument(reducedMotion);
      gsap.defaults({ duration: reducedMotion ? 0 : 0.24 });
      toasts.show(
        reducedMotion ? "Reduced Motion Enabled" : "Full Motion Restored",
        "UI transitions updated",
        "info"
      );
      syncNow();
    },
    getFocusMode: () => sceneManager.getFocusMode(),
    getReducedMotion: () => reducedMotion,
  });

  missionDrawer = new MissionDrawer({
    onSelectPlanet: selectPlanet,
    onSelectLaunchSite: (siteId) => {
      const site = sceneManager.setLaunchSite(siteId);
      prevEvent = null;
      toasts.show("Launch Site", `${site.name} (${site.country})`, "info");
      syncNow();
    },
    onSelectVehicle: (vehicleId) => {
      const veh = sceneManager.setVehicle(vehicleId);
      prevEvent = null;
      toasts.show("Launch Vehicle", `${veh.name} · ${veh.enginesSummary}`, "info");
      syncNow();
    },
    onSelectMissionMode: (mode) => {
      const veh = sceneManager.getVehicle();
      if (mode === "landing" && !veh.supportsLandingMode) {
        toasts.show("Orbital Launcher", `${veh.shortName} supports Orbital Launch only`, "info");
      }
      sceneManager.setMissionMode(mode);
      prevEvent = null;
      syncNow();
    },
    onSelectControlMode: (mode) => {
      sceneManager.setControlMode(mode);
      syncNow();
    },
    onClose: () => setMissionOpen(false),
  });

  orbitalDrawer = new OrbitalDrawer({
    onSelectObject: (id) => {
      sceneManager.selectOrbitalObject(id);
      syncNow();
    },
    onInspectObject: (id) => {
      sceneManager.inspectOrbitalObject(id);
      const snap = sceneManager
        .getOrbitalStateSnapshot()
        .objects.find((o) => o.id === id);
      if (snap) {
        toasts.show(
          "Inspecting Orbital Object",
          `${snap.name} · ${Math.round(snap.altitudeKm).toLocaleString()} km`,
          "info"
        );
      }
      syncNow();
    },
    onViewInMap: (id) => {
      sceneManager.selectOrbitalObject(id);
      sceneManager.setCameraPreset("map");
      syncNow();
    },
    onBackToVehicle: () => {
      sceneManager.returnToVehicleFromOrbital();
      syncNow();
    },
    onToggleVisibility: (next) => {
      sceneManager.setOrbitalVisibility(next);
      syncNow();
    },
    onRefreshLive: () => {
      void sceneManager.refreshCelesTrakData(true).then((prov) => {
        toasts.show(
          prov.dataSource === "live_celestrak" ? "CelesTrak Live Sync" : "Orbital Data",
          prov.lastError ??
            `${prov.liveCount}/${prov.totalCatalogCount} GP elements updated (${prov.lastUpdatedUtc})`,
          prov.dataSource === "live_celestrak" ? "ok" : "info"
        );
        syncNow();
      });
      syncNow();
    },
    onClose: () => setOrbitsOpen(false),
  });

  sceneManager.setAutoQualityStepDownListener((from, to, fps) => {
    toasts.show(
      "Auto Quality Guard",
      `Stepped down ${from.toUpperCase()} → ${to.toUpperCase()} (${fps} FPS)`,
      "warn"
    );
    syncNow();
  });

  sceneManager.setOrbitalObjectPickedListener((snap) => {
    setOrbitsOpen(true);
    toasts.show(
      "Orbital Object Selected",
      `${snap.name} · ${Math.round(snap.altitudeKm).toLocaleString()} km`,
      "info"
    );
    syncNow();
  });

  aiDrawer = new AIPilotDrawer({
    onStartPreTrain: () => {
      sceneManager.startPreTrain();
      syncNow();
    },
    onToggleTurboTrain: () => {
      sceneManager.toggleTurboTrain();
      syncNow();
    },
    onStartAIEval: () => {
      sceneManager.startAIEval();
      syncNow();
    },
    onStartLiveTrain: () => {
      sceneManager.startLiveTrain();
      syncNow();
    },
    onResetAIWeights: () => {
      sceneManager.resetAIWeights();
      syncNow();
      researchDrawer.repaintCanvases(true);
    },
    onSetLearningRate: (lr) => {
      sceneManager.setAILearningRate(lr);
      syncNow();
    },
    onToggleDomainRandomization: () => {
      sceneManager.setDomainRandomization(!sceneManager.getAIStatus().randomizeSpawn);
      syncNow();
    },
    onExportCheckpoint: () => sceneManager.exportPolicyCheckpoint(),
    onImportCheckpoint: (json) => {
      sceneManager.importPolicyCheckpoint(json);
      syncNow();
    },
    onDownloadFile: triggerBrowserDownload,
    onClose: () => setAIOpen(false),
  });

  researchDrawer = new ResearchDrawer({
    appVersion: APP_VERSION,
    onSetFaults: (cfg) => {
      sceneManager.setFaultConfig(cfg);
      syncNow();
    },
    onResetFaults: () => {
      sceneManager.resetFaults();
      const def = sceneManager.getFaultConfig();
      syncNow();
      return def;
    },
    onGetFaults: () => sceneManager.getFaultConfig(),
    onRunMonteCarlo: (episodes, pilot) => sceneManager.runMonteCarlo(episodes, pilot),
    onIsMonteCarloRunning: () => sceneManager.isMonteCarloRunning(),
    onGetFlightLog: () => sceneManager.getFlightLog(),
    onGetTrainingHistory: () => sceneManager.getTrainingHistory(),
    onGetLastActivations: () => sceneManager.getLastAIActivations(),
    onGetFlightTelemetry: () => sceneManager.getFlightTelemetry(),
    onClose: () => setResearchOpen(false),
  });

  window.__AETHERSIM_BOOT_ID__ =
    window.__AETHERSIM_BOOT_ID__ ?? Math.random().toString(36).slice(2);

  cameraDock = new CameraDock({
    onSelectPreset: (preset) => {
      sceneManager.setCameraPreset(preset);
    },
    onToggleAutoDirector: () => {
      sceneManager.setAutoDirector(!sceneManager.getAutoDirector());
    },
    onSelectTrackTarget: (target) => {
      sceneManager.setTrackTarget(target);
    },
    onResetCamera: () => sceneManager.resetCamera(),
  });

  sceneManager.setCameraStateListener((camState) => {
    cameraDock.syncCameraState(camState);
    if (window.__STARSHIP_SIM__) {
      window.__STARSHIP_SIM__.cameraPreset = camState.mode;
      window.__STARSHIP_SIM__.trackTarget = camState.trackTarget;
    }
  });

  flightHud = new FlightHud(isElectron, sceneManager.getRendererName());

  const workspace = el("div", "hud-workspace");
  workspace.append(missionDrawer.root, orbitalDrawer.root, aiDrawer.root, researchDrawer.root);

  const bottomCluster = el("div", undefined);
  bottomCluster.style.cssText = "display:flex;flex-direction:column;gap:8px;pointer-events:none;";
  bottomCluster.append(cameraDock.root, flightHud.root);

  hudRoot.append(topBar.root, workspace, bottomCluster, toasts.root, helpModal.root);

  motionMedia.addEventListener("change", (ev) => {
    if (reducedMotionOverride === null) {
      reducedMotion = resolveReducedMotion(ev.matches, null);
      applyReducedMotionToDocument(reducedMotion);
      gsap.defaults({ duration: reducedMotion ? 0 : 0.24 });
      syncNow();
    }
  });

  syncDrawerStates();
  syncNow();

  // Keyboard bindings (Earth-first 1/2/3, capture-phase F1–F8, Space/R/G/T/Z/X/M/V/Esc & Manual axes)
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

  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      const targetEl = event.target as HTMLElement | null;
      const targetTag = targetEl?.tagName;
      if (
        targetTag === "INPUT" ||
        targetTag === "TEXTAREA" ||
        targetTag === "SELECT" ||
        targetEl?.isContentEditable
      ) {
        return;
      }

      keysDown.add(event.code);

      if (event.key === "Escape") {
        const res = closeActiveOverlayOnEscape(readLiveOverlayState());
        if (res.closedAny) {
          event.preventDefault();
          applyOverlayState(res.nextState);
        }
        return;
      }

      if (event.key === "1") {
        selectPlanet("earth");
      } else if (event.key === "2") {
        selectPlanet("moon");
      } else if (event.key === "3") {
        selectPlanet("mars");
      } else if (event.code === "F1") {
        event.preventDefault();
        event.stopPropagation();
        sceneManager.setCameraPreset("pad");
      } else if (event.code === "F2") {
        event.preventDefault();
        event.stopPropagation();
        sceneManager.setCameraPreset("chase");
      } else if (event.code === "F3") {
        event.preventDefault();
        event.stopPropagation();
        sceneManager.setCameraPreset("engine");
      } else if (event.code === "F4") {
        event.preventDefault();
        event.stopPropagation();
        sceneManager.setCameraPreset("station");
      } else if (event.code === "F5") {
        event.preventDefault();
        event.stopPropagation();
        sceneManager.setCameraPreset("free");
      } else if (event.code === "F6") {
        event.preventDefault();
        event.stopPropagation();
        sceneManager.setCameraPreset("map");
      } else if (event.code === "F7") {
        event.preventDefault();
        event.stopPropagation();
        sceneManager.setCameraPreset("booster");
      } else if (event.code === "F8") {
        event.preventDefault();
        event.stopPropagation();
        sceneManager.toggleAutoDirector();
      } else if (event.code === "BracketLeft" || event.code === "BracketRight") {
        const idx = WARP_LEVELS.indexOf(sceneManager.getTimeWarp());
        const nextIdx =
          event.code === "BracketLeft"
            ? Math.max(0, idx - 1)
            : Math.min(WARP_LEVELS.length - 1, idx + 1);
        sceneManager.setTimeWarp(WARP_LEVELS[nextIdx]);
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
        prevEvent = null;
        syncNow();
      } else if (event.key === "g" || event.key === "G") {
        sceneManager.toggleLandingLegs();
        syncNow();
      } else if (event.key === "t" || event.key === "T") {
        sceneManager.toggleSas();
        syncNow();
      } else if (event.key === "m" || event.key === "M") {
        sceneManager.setAudioMuted(!sceneManager.isAudioMuted());
        syncNow();
      } else if (event.key === "v" || event.key === "V") {
        sceneManager.toggleAutoDirector();
      } else if (event.key === "z" || event.key === "Z") {
        sceneManager.setManualInput({ throttleSet: 1.0 });
      } else if (event.key === "x" || event.key === "X") {
        sceneManager.setManualInput({ throttleSet: 0.0 });
      }
      recomputeManualAxes();
    },
    true
  );

  window.addEventListener("keyup", (event: KeyboardEvent) => {
    keysDown.delete(event.code);
    recomputeManualAxes();
  });

  window.__AETHERSIM_PROFILER__ = {
    setPlanet: (id) => {
      selectPlanet(id);
    },
    setLaunchSite: (id) => {
      sceneManager.setLaunchSite(id);
      prevEvent = null;
      syncNow();
    },
    setVehicle: (id) => {
      sceneManager.setVehicle(id);
      prevEvent = null;
      syncNow();
    },
    selectOrbitalObject: (id) => {
      sceneManager.selectOrbitalObject(id);
      syncNow();
    },
    inspectOrbitalObject: (id) => {
      sceneManager.inspectOrbitalObject(id);
      syncNow();
    },
    returnToVehicle: () => {
      sceneManager.returnToVehicleFromOrbital();
      syncNow();
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
    setCameraPreset: (mode) => {
      sceneManager.setCameraPreset(mode);
    },
    setTrackTarget: (target) => {
      sceneManager.setTrackTarget(target);
    },
    setAutoDirector: (enabled) => {
      sceneManager.setAutoDirector(enabled);
    },
    resetCamera: () => {
      sceneManager.resetCamera();
    },
    probeCanvas: () => sceneManager.probeCanvasNonBlackNow(),
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
            const hw = sceneManager.getHardwareDiagnostics();
            resolve({
              frames: frameDeltas.length,
              durationMs: Math.round(now - start),
              avgFps: frameDeltas.length / elapsedSec,
              p50FrameMs: p50,
              p95FrameMs: p95,
              drawCalls: sim?.drawCalls ?? 0,
              triangles: sim?.triangles ?? 0,
              rendererName: sceneManager.getRendererName(),
              cpuModel: hw.cpuModel,
              cpuCores: hw.cpuCores,
              gpuShortName: hw.gpuShortName,
              gpuTier: hw.gpuTier,
              isHybridOnIgpu: hw.isHybridOnIgpu,
              estimatedVramMB: hw.estimatedVramMB,
              glbLoadedCount: hw.glbLoadedCount,
              shadowCascades: hw.shadowCascades,
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

  window.addEventListener("beforeunload", () => {
    sceneManager.dispose();
  });
}

try {
  bootstrap();
} catch (err) {
  console.error("[AetherSim Bootstrap Error]", err);
  showFatalStartupBanner(
    "AetherSim failed to initialize",
    err instanceof Error ? (err.stack ?? err.message) : String(err)
  );
}
