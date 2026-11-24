import { describe, expect, it } from "vitest";
import { PLANET_ORDER, type PlanetId } from "../config/planets";
import { FlightController, type FlightPhase } from "../sim/FlightController";

function stepSeconds(ctrl: FlightController, seconds: number, dt = 1 / 60) {
  const steps = Math.round(seconds / dt);
  let last = ctrl.getTelemetry();
  for (let i = 0; i < steps; i++) {
    last = ctrl.update(dt);
  }
  return last;
}

describe("FlightController planetary launch & landing simulation", () => {
  it("progresses cleanly through countdown, liftoff, ascent, and stage separation across all planets", () => {
    const padHeights: Record<PlanetId, number> = {
      earth: 18.0,
      mars: 2.2,
      moon: 1.6,
    };

    for (const planet of PLANET_ORDER) {
      const ctrl = new FlightController(planet, padHeights[planet], "launch");
      const seenPhases = new Set<FlightPhase>([ctrl.getTelemetry().phase]);

      ctrl.startMission();
      let tel = ctrl.getTelemetry();
      seenPhases.add(tel.phase);
      expect(tel.phase).toBe("COUNTDOWN");

      for (let i = 0; i < 60 * 55; i++) {
        tel = ctrl.update(1 / 60);
        seenPhases.add(tel.phase);
      }

      expect(seenPhases.has("COUNTDOWN")).toBe(true);
      expect(seenPhases.has("LIFTOFF")).toBe(true);
      expect(seenPhases.has("ASCENT")).toBe(true);
      expect(seenPhases.has("STAGE_SEP")).toBe(true);
      expect(tel.stageSeparated).toBe(true);
      expect(tel.altitudeM).toBeGreaterThan(2500);
      expect(tel.speedMps).toBeGreaterThan(100);
      expect(tel.umbilicalRetracted).toBe(1);
      expect(tel.frostLevel).toBeLessThan(0.5);
      expect(tel.boosterFuel).toBeLessThan(1.0);
      expect(tel.shipFuel).toBeLessThan(1.0);
    }
  });

  it("models higher Max-Q on Earth than Mars and strictly zero dynamic pressure on Moon", () => {
    const peakQ: Record<PlanetId, number> = { mars: 0, earth: 0, moon: 0 };

    for (const planet of PLANET_ORDER) {
      const ctrl = new FlightController(planet, 2.0, "launch");
      ctrl.startMission();
      const tel = stepSeconds(ctrl, 45);
      peakQ[planet] = tel.maxQPa;
    }

    expect(peakQ.moon).toBe(0);
    expect(peakQ.mars).toBeGreaterThan(0);
    expect(peakQ.earth).toBeGreaterThan(peakQ.mars * 10);
  });

  it("executes autopilot propulsive landing to NOMINAL LANDING on Mars, Earth, and Moon", () => {
    const padHeights: Record<PlanetId, number> = {
      earth: 18.0,
      mars: 2.2,
      moon: 1.6,
    };

    for (const planet of PLANET_ORDER) {
      const ctrl = new FlightController(planet, padHeights[planet], "landing");
      ctrl.startMission();

      let tel = ctrl.getTelemetry();
      for (let i = 0; i < 60 * 60; i++) {
        tel = ctrl.update(1 / 60);
        if (tel.phase === "TOUCHDOWN" || tel.phase === "CRASHED") {
          break;
        }
      }

      expect(tel.phase).toBe("TOUCHDOWN");
      expect(tel.landingVerdict).toBe("NOMINAL LANDING");
      expect(tel.crashEvent).toBeNull();
      expect(tel.touchdownVerticalSpeedMps).not.toBeNull();
      expect(tel.touchdownVerticalSpeedMps!).toBeLessThanOrEqual(4.5);
      expect(tel.touchdownTiltDeg!).toBeLessThanOrEqual(12.0);
      expect(tel.touchdownOffsetM!).toBeLessThanOrEqual(44.0);
      expect(tel.landingLegsDeployed).toBeGreaterThanOrEqual(0.7);
    }
  });

  it("triggers CRASHED and emits CrashEvent when falling back to surface after ascent throttle cutoff", () => {
    const ctrl = new FlightController("mars", 2.2, "launch");
    ctrl.startMission();
    // Climb cleanly above pad
    let tel = stepSeconds(ctrl, 24);
    expect(tel.phase).toBe("ASCENT");
    expect(tel.altitudeM).toBeGreaterThan(300);

    // Cut engines in manual mode and fall back to surface
    ctrl.setControlMode("manual");
    for (let i = 0; i < 60 * 110; i++) {
      tel = ctrl.update(1 / 60, {
        throttleDelta: 0,
        throttleSet: 0,
        pitchInput: 0,
        yawInput: 0,
      });
      if (tel.phase === "CRASHED") {
        break;
      }
    }

    expect(tel.phase).toBe("CRASHED");
    expect(tel.landingVerdict).toBe("CRASH_RUD");
    expect(tel.running).toBe(false);
    expect(tel.crashEvent).not.toBeNull();
    expect(tel.crashEvent!.cause).toBe("SURFACE_IMPACT");
    expect(tel.crashEvent!.impactSpeedMps).toBeGreaterThan(20);
  });

  it("triggers CRASH_RUD on unbraked landing descent", () => {
    const ctrl = new FlightController("earth", 18.0, "landing");
    ctrl.setControlMode("manual");
    ctrl.startMission();

    let tel = ctrl.getTelemetry();
    for (let i = 0; i < 60 * 45; i++) {
      tel = ctrl.update(1 / 60, {
        throttleDelta: 0,
        throttleSet: 0,
        pitchInput: 0,
        yawInput: 0,
      });
      if (tel.phase === "CRASHED" || tel.phase === "TOUCHDOWN") {
        break;
      }
    }

    expect(tel.phase).toBe("CRASHED");
    expect(tel.landingVerdict).toBe("CRASH_RUD");
    expect(tel.crashEvent).not.toBeNull();
  });

  it("provides responsive manual TVC/RCS authority and SAS angular damping", () => {
    const ctrl = new FlightController("moon", 1.6, "landing");
    ctrl.setControlMode("manual");
    ctrl.setSasEnabled(true);
    ctrl.startMission();

    const startPitch = ctrl.getTelemetry().pitch;
    let tel = ctrl.getTelemetry();
    // Steer pitch for 0.5s with 0% throttle (pure cold-gas RCS)
    for (let i = 0; i < 30; i++) {
      tel = ctrl.update(1 / 60, {
        throttleDelta: 0,
        throttleSet: 0,
        pitchInput: 1.0,
        yawInput: 0,
        rollInput: 0.6,
      });
    }

    expect(tel.pitch - startPitch).toBeGreaterThan(0.18);
    expect(Math.abs(tel.angularVelocity.pitch)).toBeGreaterThan(0.5);
    expect(Math.abs(tel.rcsThrust.pitch)).toBeGreaterThan(0.1);
    expect(Math.abs(tel.rcsThrust.yaw)).toBeGreaterThan(0.1);

    // Release inputs with SAS ON -> angular velocity damps cleanly near 0
    for (let i = 0; i < 45; i++) {
      tel = ctrl.update(1 / 60, {
        throttleDelta: 0,
        throttleSet: 0.8,
        pitchInput: 0,
        yawInput: 0,
        rollInput: 0,
      });
    }
    expect(tel.throttle).toBeCloseTo(0.8, 5);
    expect(Math.abs(tel.angularVelocity.pitch)).toBeLessThan(0.05);
    expect(Math.abs(tel.angularVelocity.yaw)).toBeLessThan(0.05);
  });
});
