import type { QualityPreset } from "../effects/PropulsionEffects";

export type DrawerSlotId = "mission" | "ai" | "orbits" | "research";

export interface OverlayState {
  readonly missionOpen: boolean;
  readonly aiOpen: boolean;
  readonly orbitsOpen: boolean;
  readonly researchOpen: boolean;
  readonly settingsOpen: boolean;
  readonly helpOpen: boolean;
}

export function createInitialOverlayState(): OverlayState {
  return {
    missionOpen: false,
    aiOpen: false,
    orbitsOpen: false,
    researchOpen: false,
    settingsOpen: false,
    helpOpen: false,
  };
}

/**
 * Enforces strictly mutually exclusive left-side (`mission` vs `ai`) and
 * right-side (`orbits` vs `research`) drawer slots so two panels never overlap,
 * while closing the Settings popover when a drawer opens.
 */
export function setDrawerSlotOpen(
  state: OverlayState,
  slot: DrawerSlotId,
  open: boolean
): OverlayState {
  if (slot === "mission") {
    return {
      ...state,
      missionOpen: open,
      aiOpen: open ? false : state.aiOpen,
      settingsOpen: open ? false : state.settingsOpen,
    };
  }
  if (slot === "ai") {
    return {
      ...state,
      aiOpen: open,
      missionOpen: open ? false : state.missionOpen,
      settingsOpen: open ? false : state.settingsOpen,
    };
  }
  if (slot === "orbits") {
    return {
      ...state,
      orbitsOpen: open,
      researchOpen: open ? false : state.researchOpen,
      settingsOpen: open ? false : state.settingsOpen,
    };
  }
  return {
    ...state,
    researchOpen: open,
    orbitsOpen: open ? false : state.orbitsOpen,
    settingsOpen: open ? false : state.settingsOpen,
  };
}

/**
 * Layered Escape-key dismissal: closes topmost modal (`Help`) first, then `Settings`
 * popover, and finally any open side drawers.
 */
export function closeActiveOverlayOnEscape(state: OverlayState): {
  readonly nextState: OverlayState;
  readonly closedAny: boolean;
} {
  if (state.helpOpen) {
    return { nextState: { ...state, helpOpen: false }, closedAny: true };
  }
  if (state.settingsOpen) {
    return { nextState: { ...state, settingsOpen: false }, closedAny: true };
  }
  if (
    state.missionOpen ||
    state.aiOpen ||
    state.orbitsOpen ||
    state.researchOpen
  ) {
    return {
      nextState: {
        ...state,
        missionOpen: false,
        aiOpen: false,
        orbitsOpen: false,
        researchOpen: false,
      },
      closedAny: true,
    };
  }
  return { nextState: state, closedAny: false };
}

export interface AutoQualityGuardOptions {
  readonly lowFpsThreshold?: number;
  readonly sustainSec?: number;
  readonly cooldownSec?: number;
}

/**
 * Optional Auto-LOD / Quality Guard that monitors rolling FPS and steps down
 * `high -> med -> low` only when FPS stays below `lowFpsThreshold` (default 32 FPS)
 * continuously for `sustainSec` (default 4.0 s), preventing unexpected sluggishness.
 */
export class AutoQualityGuard {
  private enabled = false;
  private lowFpsAccumSec = 0;
  private cooldownRemainingSec = 0;
  private readonly lowFpsThreshold: number;
  private readonly sustainSec: number;
  private readonly cooldownSec: number;

  constructor(options: AutoQualityGuardOptions = {}) {
    this.lowFpsThreshold = options.lowFpsThreshold ?? 32;
    this.sustainSec = options.sustainSec ?? 4.0;
    this.cooldownSec = options.cooldownSec ?? 10.0;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.resetWindow();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  resetWindow(): void {
    this.lowFpsAccumSec = 0;
    this.cooldownRemainingSec = 0;
  }

  sample(
    fps: number,
    dtSec: number,
    currentQuality: QualityPreset
  ): QualityPreset | null {
    if (!this.enabled || dtSec <= 0 || !Number.isFinite(fps) || fps <= 0) {
      return null;
    }

    if (this.cooldownRemainingSec > 0) {
      this.cooldownRemainingSec = Math.max(0, this.cooldownRemainingSec - dtSec);
      return null;
    }

    if (currentQuality === "low") {
      this.lowFpsAccumSec = 0;
      return null;
    }

    if (fps < this.lowFpsThreshold) {
      this.lowFpsAccumSec += dtSec;
      if (this.lowFpsAccumSec >= this.sustainSec) {
        this.lowFpsAccumSec = 0;
        this.cooldownRemainingSec = this.cooldownSec;
        return currentQuality === "high" ? "med" : "low";
      }
    } else {
      // Decay accumulated dip cleanly when FPS recovers
      this.lowFpsAccumSec = Math.max(0, this.lowFpsAccumSec - dtSec * 1.5);
    }

    return null;
  }
}
