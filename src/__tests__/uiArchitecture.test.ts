import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLANET_ID,
  DESTINATION_DISPLAY_ORDER,
  PLANET_ORDER,
} from "../config/planets";
import type { BoosterState } from "../sim/FlightController";
import {
  SITE_CATALOG,
  VEHICLE_CATALOG,
  formatAltitude,
  formatBoosterStatusLabel,
  formatCoordinates,
  formatDynamicPressure,
  formatMissionPillLabel,
  formatOrbitalAltitude,
  formatSignedVelocity,
  formatSpeed,
  formatTClock,
  getDefaultSiteForPlanet,
  resolveReducedMotion,
} from "../ui/formatters";
import {
  AutoQualityGuard,
  closeActiveOverlayOnEscape,
  createInitialOverlayState,
  setDrawerSlotOpen,
} from "../ui/uiGuards";

describe("Milestone 6 Stage 6A — Earth-First Defaults, Catalog Slots & UI Formatting", () => {
  it("defaults startup destination to Earth while keeping Moon and Mars valid", () => {
    expect(DEFAULT_PLANET_ID).toBe("earth");
    expect(DESTINATION_DISPLAY_ORDER).toEqual(["earth", "moon", "mars"]);
    expect(PLANET_ORDER).toEqual(["mars", "earth", "moon"]);

    const earthSite = getDefaultSiteForPlanet("earth");
    const moonSite = getDefaultSiteForPlanet("moon");
    const marsSite = getDefaultSiteForPlanet("mars");
    expect(earthSite.id).toBe("earth-starbase");
    expect(moonSite.id).toBe("moon-shackleton");
    expect(marsSite.id).toBe("mars-jezero");
    expect(SITE_CATALOG.length).toBeGreaterThanOrEqual(3);
    expect(VEHICLE_CATALOG[0].id).toBe("starship-sh");
    expect(VEHICLE_CATALOG[0].rtlsCapable).toBe(true);
  });

  it("resolves reduced-motion state across OS preference and explicit user overrides", () => {
    expect(resolveReducedMotion(false, null)).toBe(false);
    expect(resolveReducedMotion(true, null)).toBe(true);
    expect(resolveReducedMotion(false, true)).toBe(true);
    expect(resolveReducedMotion(true, false)).toBe(false);
  });

  it("formats tabular telemetry, coordinates, mission pills, and booster RTLS status cleanly", () => {
    expect(formatTClock(-10)).toBe("T-00:10.0");
    expect(formatTClock(75.4)).toBe("T+01:15.4");
    expect(formatAltitude(420.24)).toBe("420.2 m");
    expect(formatAltitude(12_450)).toBe("12.45 km");
    expect(formatSpeed(812.34)).toBe("812.3 m/s");
    expect(formatSignedVelocity(-14.2)).toBe("-14.2 m/s");
    expect(formatSignedVelocity(32.5)).toBe("+32.5 m/s");
    expect(formatOrbitalAltitude(-500)).toBe("SUBORB");
    expect(formatOrbitalAltitude(Infinity)).toBe("ESCAPE");
    expect(formatOrbitalAltitude(41_800)).toBe("41.80 km");
    expect(formatDynamicPressure(32_450)).toBe("32.45 kPa");
    expect(formatCoordinates(25.997, -97.156)).toBe("26.00°N, 97.16°W");
    expect(formatMissionPillLabel("earth", "launch")).toBe(
      "EARTH · STARBASE · STARSHIP · LAUNCH"
    );

    const mockBooster: BoosterState = {
      active: true,
      status: "BOOSTER_BOOSTBACK",
      position: { x: 100, y: 8200, z: 0 },
      velocity: { x: -40, y: 120, z: 0 },
      pitch: -1.1,
      yaw: 0,
      roll: 0,
      throttle: 0.85,
      fuel: 0.14,
      altitudeM: 8200,
      verticalSpeedMps: 120,
      padOffsetM: 100,
      gridFinPitch: 0,
      gridFinYaw: 0,
      touchdownVerticalSpeedMps: null,
      touchdownOffsetM: null,
      impactEvent: null,
    };
    expect(formatBoosterStatusLabel(mockBooster)).toEqual({
      text: "BSTR: BOOSTBACK · 8.2km",
      tone: "active",
    });

    const caughtBooster: BoosterState = {
      ...mockBooster,
      active: false,
      status: "BOOSTER_CAUGHT",
      touchdownOffsetM: 0.4,
      touchdownVerticalSpeedMps: 1.4,
    };
    expect(formatBoosterStatusLabel(caughtBooster)).toEqual({
      text: "BSTR: CAUGHT (0.4m · 1.4m/s)",
      tone: "ok",
    });
  });

  it("enforces mutually exclusive left/right drawers and layered Escape dismissal", () => {
    let state = createInitialOverlayState();
    state = { ...state, settingsOpen: true };

    // Opening Mission on the left closes Settings; opening AI on the left closes Mission
    state = setDrawerSlotOpen(state, "mission", true);
    expect(state.missionOpen).toBe(true);
    expect(state.settingsOpen).toBe(false);

    state = setDrawerSlotOpen(state, "ai", true);
    expect(state.aiOpen).toBe(true);
    expect(state.missionOpen).toBe(false);

    // Opening Orbits on the right leaves left slot alone; opening Research closes Orbits
    state = setDrawerSlotOpen(state, "orbits", true);
    expect(state.orbitsOpen).toBe(true);
    expect(state.aiOpen).toBe(true);

    state = setDrawerSlotOpen(state, "research", true);
    expect(state.researchOpen).toBe(true);
    expect(state.orbitsOpen).toBe(false);

    // Layered Escape closes Help -> Settings -> open Drawers in order
    state = { ...state, helpOpen: true, settingsOpen: true };
    const esc1 = closeActiveOverlayOnEscape(state);
    expect(esc1.closedAny).toBe(true);
    expect(esc1.nextState.helpOpen).toBe(false);
    expect(esc1.nextState.settingsOpen).toBe(true);

    const esc2 = closeActiveOverlayOnEscape(esc1.nextState);
    expect(esc2.closedAny).toBe(true);
    expect(esc2.nextState.settingsOpen).toBe(false);
    expect(esc2.nextState.researchOpen).toBe(true);

    const esc3 = closeActiveOverlayOnEscape(esc2.nextState);
    expect(esc3.closedAny).toBe(true);
    expect(esc3.nextState.aiOpen).toBe(false);
    expect(esc3.nextState.researchOpen).toBe(false);

    const esc4 = closeActiveOverlayOnEscape(esc3.nextState);
    expect(esc4.closedAny).toBe(false);
  });

  it("steps down HIGH -> MED -> LOW in AutoQualityGuard only on sustained < 32 FPS", () => {
    const guard = new AutoQualityGuard({
      lowFpsThreshold: 32,
      sustainSec: 4.0,
      cooldownSec: 10.0,
    });

    // Disabled by default -> never steps down
    expect(guard.isEnabled()).toBe(false);
    for (let i = 0; i < 20; i++) {
      expect(guard.sample(15, 0.5, "high")).toBeNull();
    }

    guard.setEnabled(true);
    // Transient 2-second dip recovers when FPS returns to 60
    expect(guard.sample(24, 1.0, "high")).toBeNull();
    expect(guard.sample(24, 1.0, "high")).toBeNull();
    expect(guard.sample(60, 2.0, "high")).toBeNull();

    // Sustained 4 seconds below 32 FPS -> steps down high -> med
    expect(guard.sample(22, 1.0, "high")).toBeNull();
    expect(guard.sample(22, 1.0, "high")).toBeNull();
    expect(guard.sample(22, 1.0, "high")).toBeNull();
    expect(guard.sample(22, 1.0, "high")).toBe("med");

    // Cooldown suppresses immediate double-drop
    expect(guard.sample(20, 5.0, "med")).toBeNull();
    expect(guard.sample(20, 5.0, "med")).toBeNull();

    // After 10s cooldown, another sustained 4s dip steps med -> low
    expect(guard.sample(20, 2.0, "med")).toBeNull();
    expect(guard.sample(20, 2.0, "med")).toBe("low");

    // Never steps below low
    expect(guard.sample(15, 15.0, "low")).toBeNull();
  });
});
