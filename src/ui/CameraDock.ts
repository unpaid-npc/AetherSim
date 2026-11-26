import type {
  CameraDirectorState,
  CameraMode,
  CameraPreset,
  SceneTelemetry,
  TrackTarget,
} from "../scene/SceneManager";
import { createIcon, el } from "./dom";

export interface CameraDockCallbacks {
  onSelectPreset: (preset: CameraPreset) => void;
  onToggleAutoDirector: () => void;
  onSelectTrackTarget: (target: TrackTarget) => void;
  onResetCamera: () => void;
}

const CAMERA_SPECS: ReadonlyArray<{
  mode: CameraMode;
  key: string;
  label: string;
  tip: string;
}> = [
  { mode: "pad", key: "F1", label: "Pad", tip: "Pad Apron Camera (F1)" },
  { mode: "chase", key: "F2", label: "Chase", tip: "3/4 Quarter Chase Camera (F2)" },
  { mode: "engine", key: "F3", label: "Engine", tip: "Aft Skirt & Raptor Nozzle Camera (F3)" },
  { mode: "station", key: "F4", label: "Station", tip: "Orbital Space Station Camera (F4)" },
  { mode: "free", key: "F5", label: "Free", tip: "Free Interactive Globe Zoom Camera (F5)" },
  { mode: "map", key: "F6", label: "Map", tip: "Orbital Map Overview Camera (F6)" },
  { mode: "booster", key: "F7", label: "Booster", tip: "Super Heavy Booster RTLS Camera (F7)" },
];

/** Floating bottom-center Camera & Vehicle Tracking switcher bar. */
export class CameraDock {
  public readonly root: HTMLDivElement;

  private readonly padHintEl: HTMLDivElement;
  private readonly camBtns = new Map<CameraMode, HTMLButtonElement>();
  private readonly autoBtn: HTMLButtonElement;
  private readonly trackDivider: HTMLDivElement;
  private readonly trackGroup: HTMLDivElement;
  private readonly trackBtns = new Map<TrackTarget, HTMLButtonElement>();

  constructor(callbacks: CameraDockCallbacks) {
    this.root = el("div", "camera-dock-wrap");

    this.padHintEl = el("div", "camera-pad-hint tabular");
    this.padHintEl.style.display = "none";

    const dock = el("nav", "camera-dock");
    dock.setAttribute("aria-label", "Camera Views and Vehicle Tracking");

    const camGroup = el("div", "pill-group");
    for (const spec of CAMERA_SPECS) {
      const b = el("button", "pill-btn", undefined, spec.tip);
      b.type = "button";
      b.dataset.camMode = spec.mode;
      b.append(el("span", "kbd-chip", spec.key), document.createTextNode(spec.label));
      b.addEventListener("click", () => callbacks.onSelectPreset(spec.mode));
      camGroup.append(b);
      this.camBtns.set(spec.mode, b);
    }

    this.autoBtn = el(
      "button",
      "pill-btn",
      undefined,
      "Auto Director switches views along the mission [F8 / V]"
    );
    this.autoBtn.type = "button";
    this.autoBtn.dataset.camAction = "auto";
    this.autoBtn.append(el("span", "kbd-chip", "F8"), document.createTextNode("Auto"));
    this.autoBtn.addEventListener("click", callbacks.onToggleAutoDirector);
    camGroup.append(this.autoBtn);

    this.trackDivider = el("div", "dock-divider");
    this.trackGroup = el("div", "pill-group");
    (
      [
        { target: "ship", label: "Ship", tip: "Track Starship Upper Stage" },
        { target: "booster", label: "Booster", tip: "Track Super Heavy Booster" },
      ] as const
    ).forEach((item) => {
      const tb = el("button", "pill-btn", item.label, item.tip);
      tb.type = "button";
      tb.dataset.trackTarget = item.target;
      tb.addEventListener("click", () => callbacks.onSelectTrackTarget(item.target));
      this.trackGroup.append(tb);
      this.trackBtns.set(item.target, tb);
    });

    const relockBtn = el("button", "pill-btn", undefined, "Re-lock camera onto active vehicle");
    relockBtn.type = "button";
    relockBtn.dataset.camAction = "relock";
    relockBtn.setAttribute("aria-label", "Re-lock camera");
    relockBtn.append(createIcon("target"), document.createTextNode("Re-lock"));
    relockBtn.addEventListener("click", callbacks.onResetCamera);

    dock.append(camGroup, this.trackDivider, this.trackGroup, relockBtn);
    this.root.append(this.padHintEl, dock);
  }

  syncCameraState(state: CameraDirectorState): void {
    for (const [mode, btn] of this.camBtns.entries()) {
      const active = mode === state.mode;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    }
    this.autoBtn.classList.toggle("active", state.autoDirector);
    this.autoBtn.setAttribute("aria-pressed", String(state.autoDirector));

    for (const [target, btn] of this.trackBtns.entries()) {
      const active = target === state.trackTarget;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    }

    if (state.padRangeHint) {
      this.padHintEl.textContent = state.padRangeHint;
      this.padHintEl.style.display = "inline-flex";
    } else {
      this.padHintEl.style.display = "none";
    }
  }

  update(t: SceneTelemetry): void {
    this.syncCameraState({
      mode: t.cameraPreset,
      trackTarget: t.trackTarget,
      autoDirector: t.autoDirector,
      padRangeM: 0,
      padRangeHint: t.padRangeHint,
    });

    const isLaunch = t.flight.missionMode === "launch";
    this.trackDivider.style.display = isLaunch ? "block" : "none";
    this.trackGroup.style.display = isLaunch ? "inline-flex" : "none";

    const boosterBtn = this.trackBtns.get("booster");
    if (boosterBtn) {
      boosterBtn.title = t.flight.stageSeparated
        ? "Track detached Super Heavy Booster RTLS"
        : "Track stacked Super Heavy Booster section (detached after Stage Sep)";
    }
  }
}
