import { getLaunchSiteConfig } from "../config/launchSites";
import { getVehicleConfig } from "../config/vehicles";
import type { QualityPreset } from "../effects/PropulsionEffects";
import type { SceneTelemetry } from "../scene/SceneManager";
import type { TimeWarp } from "../sim/FlightController";
import { createIcon, el } from "./dom";
import { formatMissionPillLabel } from "./formatters";

export interface TopBarCallbacks {
  version: string;
  onToggleMission: () => void;
  onToggleOrbits: () => void;
  onToggleAI: () => void;
  onToggleResearch: () => void;
  onToggleHelp: () => void;
  onStartMission: () => void;
  onTogglePause: () => void;
  onStageSep: () => void;
  onResetMission: () => void;
  onSetTimeWarp: (warp: TimeWarp) => void;
  onSetQuality: (q: QualityPreset) => void;
  onToggleAutoQuality: () => void;
  onToggleAudio: () => void;
  onToggleOrbitPath: () => void;
  onToggleSas: () => void;
  onToggleLegs: () => void;
  onToggleFocusMode: () => void;
  onToggleReducedMotion: () => void;
  getFocusMode: () => "rocket" | "base";
  getReducedMotion: () => boolean;
}

const WARP_LEVELS: readonly TimeWarp[] = [1, 2, 5, 10, 25, 50];

/** Sleek single-row aerospace command bar + anchored Settings popover. */
export class TopBar {
  public readonly root: HTMLElement;

  private readonly missionPillBtn: HTMLButtonElement;
  private readonly missionPillText: HTMLSpanElement;

  private readonly startBtn: HTMLButtonElement;
  private readonly pauseBtn: HTMLButtonElement;
  private readonly sepBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;
  private readonly warpBtns = new Map<TimeWarp, HTMLButtonElement>();

  private readonly orbitsBtn: HTMLButtonElement;
  private readonly aiBtn: HTMLButtonElement;
  private readonly aiNavDot: HTMLSpanElement;
  private readonly labBtn: HTMLButtonElement;
  private readonly settingsBtn: HTMLButtonElement;
  private readonly helpBtn: HTMLButtonElement;

  private readonly settingsPopover: HTMLDivElement;
  private readonly qualBtns = new Map<QualityPreset, HTMLButtonElement>();
  private readonly autoQualityToggleBtn: HTMLButtonElement;
  private readonly audioToggleBtn: HTMLButtonElement;
  private readonly pathToggleBtn: HTMLButtonElement;
  private readonly sasToggleBtn: HTMLButtonElement;
  private readonly legsToggleBtn: HTMLButtonElement;
  private readonly focusToggleBtn: HTMLButtonElement;
  private readonly motionToggleBtn: HTMLButtonElement;

  private readonly hwCpuValEl: HTMLSpanElement;
  private readonly hwRamValEl: HTMLSpanElement;
  private readonly hwGpuValEl: HTMLSpanElement;
  private readonly hwGpuBadgeEl: HTMLSpanElement;
  private readonly hwVramValEl: HTMLSpanElement;
  private readonly hwWarnEl: HTMLDivElement;

  private readonly cb: TopBarCallbacks;
  private settingsOpen = false;

  constructor(callbacks: TopBarCallbacks) {
    this.cb = callbacks;
    this.root = el("header", "glass-panel hud-topbar");

    // --- Left: Wordmark + Mission Configurator Pill ---
    const left = el("div", "topbar-left");
    const brand = el("div", "brand-lockup");
    brand.append(
      el("span", "brand-wordmark", "AETHERSIM"),
      el("span", "brand-version tabular", `v${callbacks.version}`)
    );

    this.missionPillBtn = el(
      "button",
      "mission-pill-btn",
      undefined,
      "Configure Destination, Launch Site, Vehicle & Pilot"
    );
    this.missionPillBtn.type = "button";
    this.missionPillBtn.setAttribute("aria-expanded", "false");
    this.missionPillBtn.setAttribute("aria-label", "Open Mission Setup drawer");
    this.missionPillText = el("span", "tabular", "EARTH · STARBASE · STARSHIP · LAUNCH");
    this.missionPillBtn.append(
      el("span", "mission-pill-dot"),
      this.missionPillText,
      createIcon("chevronDown")
    );
    this.missionPillBtn.addEventListener("click", callbacks.onToggleMission);
    left.append(brand, this.missionPillBtn);

    // --- Center: Primary Flight Actions + Time Warp ---
    const center = el("div", "topbar-center");
    this.startBtn = el("button", "ui-btn primary", "LAUNCH", "Start mission countdown/flight [Space]");
    this.startBtn.type = "button";
    this.startBtn.prepend(createIcon("play"));
    this.startBtn.addEventListener("click", callbacks.onStartMission);

    this.pauseBtn = el("button", "ui-btn", "PAUSE", "Pause or resume simulation");
    this.pauseBtn.type = "button";
    this.pauseBtn.prepend(createIcon("pause"));
    this.pauseBtn.addEventListener("click", callbacks.onTogglePause);

    this.sepBtn = el("button", "ui-btn", "STAGE SEP", "Hot-stage separate Starship from Super Heavy [Space]");
    this.sepBtn.type = "button";
    this.sepBtn.prepend(createIcon("stage"));
    this.sepBtn.addEventListener("click", callbacks.onStageSep);

    this.resetBtn = el("button", "ui-btn", "RESET", "Reset vehicle & re-lock camera [R]");
    this.resetBtn.type = "button";
    this.resetBtn.prepend(createIcon("reset"));
    this.resetBtn.addEventListener("click", callbacks.onResetMission);

    const warpGroup = el("div", "pill-group");
    warpGroup.setAttribute("role", "group");
    warpGroup.setAttribute("aria-label", "Physics Time Warp");
    for (const w of WARP_LEVELS) {
      const wb = el("button", "pill-btn tabular", `${w}x`, `Time warp ${w}x ([ / ])`);
      wb.type = "button";
      wb.addEventListener("click", () => callbacks.onSetTimeWarp(w));
      warpGroup.append(wb);
      this.warpBtns.set(w, wb);
    }

    center.append(this.startBtn, this.pauseBtn, this.sepBtn, this.resetBtn, warpGroup);

    // --- Right: Orbits, AI Pilot, Research Lab, Settings Popover, Help ---
    const right = el("div", "topbar-right");
    this.orbitsBtn = el("button", "ui-btn", "ORBITS", "Open Explorable Satellites, ISS & Ground Track Inspector");
    this.orbitsBtn.type = "button";
    this.orbitsBtn.setAttribute("aria-expanded", "false");
    this.orbitsBtn.prepend(createIcon("orbit"));
    this.orbitsBtn.addEventListener("click", callbacks.onToggleOrbits);

    this.aiBtn = el("button", "ui-btn", "AI PILOT", "Open Neural AI Pilot & Training drawer");
    this.aiBtn.type = "button";
    this.aiBtn.setAttribute("aria-expanded", "false");
    this.aiNavDot = el("span", "ai-nav-dot");
    this.aiBtn.prepend(createIcon("brain"), this.aiNavDot);
    this.aiBtn.addEventListener("click", callbacks.onToggleAI);

    this.labBtn = el("button", "ui-btn", "RESEARCH LAB", "Open Telemetry Plots, Neural Net, Faults, Monte Carlo & Export");
    this.labBtn.type = "button";
    this.labBtn.setAttribute("aria-expanded", "false");
    this.labBtn.prepend(createIcon("flask"));
    this.labBtn.addEventListener("click", callbacks.onToggleResearch);

    const settingsWrap = el("div", "settings-wrap");
    this.settingsBtn = el("button", "ui-btn icon-only", undefined, "Graphics, Audio, Assist & Accessibility Settings");
    this.settingsBtn.type = "button";
    this.settingsBtn.setAttribute("aria-label", "Simulator Settings");
    this.settingsBtn.setAttribute("aria-expanded", "false");
    this.settingsBtn.append(createIcon("sliders"));
    this.settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setSettingsOpen(!this.settingsOpen);
    });

    this.settingsPopover = el("div", "settings-popover");
    this.settingsPopover.setAttribute("role", "dialog");
    this.settingsPopover.setAttribute("aria-label", "Simulator Settings");

    // Quality Row
    const qualRow = el("div", "popover-row");
    const qualLbl = el("div", "popover-label");
    qualLbl.append(el("strong", undefined, "Graphics Quality"), el("span", undefined, "4x MSAA, Bloom & Globe LOD"));
    const qualGroup = el("div", "pill-group");
    (["low", "med", "high"] as const).forEach((q) => {
      const qb = el("button", "pill-btn", q.toUpperCase());
      qb.type = "button";
      qb.addEventListener("click", () => callbacks.onSetQuality(q));
      qualGroup.append(qb);
      this.qualBtns.set(q, qb);
    });
    qualRow.append(qualLbl, qualGroup);

    // Helper for toggle rows
    const makeToggleRow = (
      title: string,
      subtitle: string,
      initialLabel: string,
      onClick: () => void
    ): HTMLButtonElement => {
      const row = el("div", "popover-row");
      const lbl = el("div", "popover-label");
      lbl.append(el("strong", undefined, title), el("span", undefined, subtitle));
      const btn = el("button", "ui-btn", initialLabel);
      btn.type = "button";
      btn.addEventListener("click", onClick);
      row.append(lbl, btn);
      this.settingsPopover.append(row);
      return btn;
    };

    this.settingsPopover.append(qualRow);
    this.autoQualityToggleBtn = makeToggleRow(
      "Auto Quality Guard",
      "Steps down HIGH → MED → LOW if FPS < 32 for 4s",
      "OFF",
      callbacks.onToggleAutoQuality
    );
    this.audioToggleBtn = makeToggleRow(
      "Procedural Audio",
      "Raptor roar, cryo vent & acoustics [M]",
      "OFF",
      callbacks.onToggleAudio
    );
    this.pathToggleBtn = makeToggleRow(
      "3D Orbital Path",
      "Orbit ring, predicted arc & markers",
      "ON",
      callbacks.onToggleOrbitPath
    );
    this.sasToggleBtn = makeToggleRow(
      "SAS Stability Assist",
      "Angular rate damping [T]",
      "ON",
      callbacks.onToggleSas
    );
    this.legsToggleBtn = makeToggleRow(
      "Landing Legs",
      "Deploy/stow Starship landing legs [G]",
      "STOWED",
      callbacks.onToggleLegs
    );
    this.focusToggleBtn = makeToggleRow(
      "Free Orbit Focus",
      "Center orbit camera on Vehicle or Pad",
      "ROCKET",
      callbacks.onToggleFocusMode
    );
    this.motionToggleBtn = makeToggleRow(
      "Reduced Motion",
      "Minimize UI transitions & pulse effects",
      "OFF",
      callbacks.onToggleReducedMotion
    );

    // System Hardware Diagnostics section inside Settings popover
    const hwSection = el("div", "hw-panel");
    const hwHeader = el("div", "hw-header");
    hwHeader.append(el("span", "hw-title", "SYSTEM HARDWARE"));
    const hwGrid = el("div", "hw-grid");

    const makeHwRow = (label: string, initial: string): HTMLSpanElement => {
      const row = el("div", "hw-row");
      const val = el("span", "hw-val tabular", initial);
      row.append(el("span", "hw-key", label), val);
      hwGrid.append(row);
      return val;
    };

    this.hwCpuValEl = makeHwRow("CPU", "Detecting...");
    this.hwRamValEl = makeHwRow("RAM", "--");

    const gpuRow = el("div", "hw-row");
    const gpuRight = el("span", "hw-gpu-wrap tabular");
    this.hwGpuValEl = el("span", "hw-val hw-gpu-name", "Detecting...");
    this.hwGpuBadgeEl = el("span", "gpu-tier-badge tier-unknown", "[GPU]");
    gpuRight.append(this.hwGpuValEl, this.hwGpuBadgeEl);
    gpuRow.append(el("span", "hw-key", "Active GPU"), gpuRight);
    hwGrid.append(gpuRow);

    this.hwVramValEl = makeHwRow("VRAM / Assets", "0.0 MB · 0 GLB");

    this.hwWarnEl = el("div", "hw-warning");
    this.hwWarnEl.style.display = "none";
    this.hwWarnEl.textContent =
      "Discrete GPU detected but app is using integrated graphics. Set Windows Graphics Preference to High Performance for electron.exe.";

    hwSection.append(hwHeader, hwGrid, this.hwWarnEl);
    this.settingsPopover.append(hwSection);

    settingsWrap.append(this.settingsBtn, this.settingsPopover);

    this.helpBtn = el("button", "ui-btn icon-only", undefined, "Quick-Reference Guide & Controls");
    this.helpBtn.type = "button";
    this.helpBtn.setAttribute("aria-label", "Help & Keyboard Shortcuts");
    this.helpBtn.append(createIcon("help"));
    this.helpBtn.addEventListener("click", callbacks.onToggleHelp);

    right.append(this.orbitsBtn, this.aiBtn, this.labBtn, settingsWrap, this.helpBtn);
    this.root.append(left, center, right);

    document.addEventListener("click", (e) => {
      if (this.settingsOpen && !settingsWrap.contains(e.target as Node)) {
        this.setSettingsOpen(false);
      }
    });
  }

  setSettingsOpen(open: boolean): void {
    this.settingsOpen = open;
    this.settingsPopover.classList.toggle("open", open);
    this.settingsBtn.classList.toggle("active", open);
    this.settingsBtn.setAttribute("aria-expanded", String(open));
  }

  isSettingsOpen(): boolean {
    return this.settingsOpen;
  }

  setPanelStates(states: {
    missionOpen: boolean;
    orbitsOpen: boolean;
    aiOpen: boolean;
    researchOpen: boolean;
  }): void {
    this.missionPillBtn.setAttribute("aria-expanded", String(states.missionOpen));
    this.orbitsBtn.classList.toggle("active", states.orbitsOpen);
    this.orbitsBtn.setAttribute("aria-expanded", String(states.orbitsOpen));
    this.aiBtn.classList.toggle("active", states.aiOpen);
    this.aiBtn.setAttribute("aria-expanded", String(states.aiOpen));
    this.labBtn.classList.toggle("active", states.researchOpen);
    this.labBtn.setAttribute("aria-expanded", String(states.researchOpen));
  }

  update(t: SceneTelemetry): void {
    const f = t.flight;
    const site = getLaunchSiteConfig(t.launchSiteId);
    const veh = getVehicleConfig(t.vehicleId);
    this.missionPillText.textContent = formatMissionPillLabel(
      f.planetId,
      f.missionMode,
      veh.shortName,
      site.shortName
    );

    if (this.startBtn.lastChild) {
      this.startBtn.lastChild.textContent = f.missionMode === "launch" ? "LAUNCH" : "START";
    }
    if (this.pauseBtn.lastChild) {
      this.pauseBtn.lastChild.textContent = f.paused ? "RESUME" : "PAUSE";
    }
    this.pauseBtn.classList.toggle("active", f.paused);

    const canSep =
      f.missionMode === "launch" &&
      f.running &&
      !f.stageSeparated &&
      f.phase !== "PRELAUNCH" &&
      f.phase !== "COUNTDOWN" &&
      f.phase !== "CRASHED";
    this.sepBtn.style.display = f.missionMode === "launch" ? "inline-flex" : "none";
    this.sepBtn.disabled = !canSep;

    for (const [w, btn] of this.warpBtns.entries()) {
      btn.classList.toggle("active", w === f.orbital.timeWarp);
    }

    const aiMode = t.ai.mode;
    this.aiNavDot.className = "ai-nav-dot";
    if (aiMode === "pre_training" || aiMode === "live_train" || aiMode === "turbo_train") {
      this.aiNavDot.classList.add("training");
    } else if (aiMode === "eval") {
      this.aiNavDot.classList.add("eval");
    } else if (t.ai.bestBrain.hasTrainedWeights) {
      this.aiNavDot.classList.add("ready");
    }

    for (const [q, btn] of this.qualBtns.entries()) {
      const isActive = q === t.quality;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    }

    this.autoQualityToggleBtn.textContent = t.autoQualityEnabled ? "ON" : "OFF";
    this.autoQualityToggleBtn.classList.toggle("active", t.autoQualityEnabled);
    this.autoQualityToggleBtn.setAttribute("aria-pressed", String(t.autoQualityEnabled));

    this.audioToggleBtn.textContent = t.audioMuted ? "OFF" : "ON";
    this.audioToggleBtn.classList.toggle("active", !t.audioMuted);
    this.audioToggleBtn.setAttribute("aria-pressed", String(!t.audioMuted));

    this.pathToggleBtn.textContent = t.orbitPathEnabled ? "ON" : "OFF";
    this.pathToggleBtn.classList.toggle("active", t.orbitPathEnabled);
    this.pathToggleBtn.setAttribute("aria-pressed", String(t.orbitPathEnabled));

    this.sasToggleBtn.textContent = f.sasEnabled ? "ON" : "OFF";
    this.sasToggleBtn.classList.toggle("active", f.sasEnabled);
    this.sasToggleBtn.setAttribute("aria-pressed", String(f.sasEnabled));

    const legsOut = f.targetLandingLegs > 0.5;
    this.legsToggleBtn.textContent = legsOut ? "DEPLOYED" : "STOWED";
    this.legsToggleBtn.classList.toggle("active", legsOut);

    const focusMode = this.cb.getFocusMode();
    this.focusToggleBtn.textContent = focusMode === "rocket" ? "ROCKET" : "PAD";
    this.focusToggleBtn.classList.toggle("active", focusMode === "base");

    const rm = this.cb.getReducedMotion();
    this.motionToggleBtn.textContent = rm ? "ON" : "OFF";
    this.motionToggleBtn.classList.toggle("active", rm);
    this.motionToggleBtn.setAttribute("aria-pressed", String(rm));

    const hw = t.hardware;
    this.hwCpuValEl.textContent =
      hw.cpuCores > 0 ? `${hw.cpuModel} (${hw.cpuCores}T)` : hw.cpuModel;
    this.hwRamValEl.textContent = hw.totalRamGb > 0 ? `${hw.totalRamGb.toFixed(1)} GB` : "Browser Managed";
    this.hwGpuValEl.textContent = hw.gpuShortName;
    this.hwGpuValEl.title = hw.rawRenderer;
    this.hwGpuBadgeEl.textContent = `[${hw.gpuTag}]`;
    this.hwGpuBadgeEl.className = `gpu-tier-badge tier-${hw.gpuTier}`;
    this.hwVramValEl.textContent = `${hw.estimatedVramMB.toFixed(1)} MB · ${hw.glbLoadedCount} GLB · ${hw.shadowCascades}× CSM`;
    if (hw.isHybridOnIgpu) {
      this.hwWarnEl.style.display = "block";
      const dgpuLabel = hw.detectedDiscreteGpuName ? ` (${hw.detectedDiscreteGpuName})` : "";
      this.hwWarnEl.textContent = `Discrete GPU detected${dgpuLabel} but app is using integrated graphics. Set Windows Graphics Preference to High Performance for electron.exe.`;
    } else {
      this.hwWarnEl.style.display = "none";
    }
  }
}
