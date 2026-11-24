import { describe, expect, it } from "vitest";
import {
  buildExperimentBundleJSON,
  formatFlightTelemetryCSV,
  formatTrainingHistoryCSV,
} from "../research/DataExporter";
import {
  computeClopperPearsonCI,
  runMonteCarloEvaluation,
} from "../research/MonteCarloRunner";
import { createDefaultFaultConfig } from "../sim/FaultInjector";
import { FlightController } from "../sim/FlightController";

describe("Milestone 3 — Fault Injection, Monte Carlo & Research Export", () => {
  it("applies thrust loss, atmospheric-scaled crosswind (0 on Moon), and IMU drift without corrupting physics truth", () => {
    // 1. Thrust loss reduces vertical acceleration & velocity on Mars launch
    const nomCtrl = new FlightController("mars", 2.2, "launch");
    const faultCtrl = new FlightController("mars", 2.2, "launch");
    faultCtrl.setFaultConfig({ thrustLossPct: 35, thrustLossTriggerAltM: 0 });
    nomCtrl.startMission();
    faultCtrl.startMission();

    for (let i = 0; i < 60 * 18; i++) {
      nomCtrl.update(1 / 60);
      faultCtrl.update(1 / 60);
    }
    const nomTel = nomCtrl.getTelemetry();
    const faultTel = faultCtrl.getTelemetry();
    expect(faultTel.altitudeM).toBeLessThan(nomTel.altitudeM * 0.75);
    expect(faultTel.activeFaults).toContain("ENG-35%");

    // 2. Crosswind pushes laterally on Earth, strictly zero on Moon vacuum
    const earthWind = new FlightController("earth", 18.0, "launch");
    earthWind.setFaultConfig({ windSpeedMps: 30, windDirectionDeg: 0 });
    earthWind.startMission();
    for (let i = 0; i < 60 * 16; i++) {
      earthWind.update(1 / 60);
    }
    expect(Math.abs(earthWind.getTelemetry().velocity.x)).toBeGreaterThan(0.5);

    const moonWind = new FlightController("moon", 1.6, "landing");
    moonWind.setFaultConfig({ windSpeedMps: 40, windDirectionDeg: 0 });
    moonWind.configureRLSpawn({
      planetId: "moon",
      missionMode: "landing",
      position: { x: 0, y: 200, z: 0 },
      velocity: { x: 0, y: -10, z: 0 },
      pitch: 0,
      roll: 0,
      running: true,
    });
    for (let i = 0; i < 60 * 3; i++) {
      moonWind.stepFixedDirect(1 / 60, { throttle: 0.2, pitchCmd: 0, yawCmd: 0 });
    }
    expect(moonWind.getTelemetry().velocity.x).toBeCloseTo(0, 4);

    // 3. IMU bias shifts getSensedTelemetry() without altering true physics state
    moonWind.setFaultConfig({ imuBiasDeg: 6.0, imuNoiseDeg: 0 });
    const truth = moonWind.getTelemetry();
    const sensed = moonWind.getSensedTelemetry(0, 0);
    expect(sensed.pitch - truth.pitch).toBeCloseTo((6.0 * Math.PI) / 180, 5);
    expect(truth.pitch).toBeCloseTo(0, 3);
  });

  it("computes valid Clopper-Pearson intervals and aggregates Monte Carlo outcomes", () => {
    const ciZero = computeClopperPearsonCI(0, 50, 0.95);
    const ciMid = computeClopperPearsonCI(15, 20, 0.95);
    const ciFull = computeClopperPearsonCI(50, 50, 0.95);
    expect(ciZero.lowPct).toBe(0);
    expect(ciZero.highPct).toBeGreaterThan(0);
    expect(ciZero.highPct).toBeLessThan(10);
    expect(ciMid.lowPct).toBeGreaterThan(45);
    expect(ciMid.highPct).toBeLessThan(95);
    expect(ciFull.lowPct).toBeGreaterThan(90);
    expect(ciFull.highPct).toBe(100);

    const pidSummary = runMonteCarloEvaluation({
      episodes: 10,
      pilot: "autopilot",
      planetId: "mars",
      missionMode: "landing",
      faultConfig: createDefaultFaultConfig(),
      seed: 2026,
    });
    expect(pidSummary.episodes).toBe(10);
    expect(
      pidSummary.successCount +
        pidSummary.hardLandingCount +
        pidSummary.crashCount +
        pidSummary.outOfBoundsCount +
        pidSummary.timeoutCount
    ).toBe(10);
    expect(pidSummary.successRatePct).toBeGreaterThan(50);
    expect(pidSummary.ciLowPct).toBeGreaterThanOrEqual(0);
    expect(pidSummary.ciHighPct).toBeLessThanOrEqual(100);

    const aiSummary = runMonteCarloEvaluation({
      episodes: 5,
      pilot: "ai_ppo",
      planetId: "moon",
      missionMode: "landing",
      seed: 42,
    });
    expect(aiSummary.episodes).toBe(5);
    expect(Number.isFinite(aiSummary.meanReturn)).toBe(true);
  });

  it("exports valid flight CSV, training CSV, and reproducible JSON experiment bundles", () => {
    const flightCsv = formatFlightTelemetryCSV([
      {
        tSec: 1.5,
        phase: "ASCENT",
        planet: "mars",
        mission: "launch",
        pilot: "autopilot",
        x: 1.2,
        altM: 120.4,
        z: -0.3,
        vx: 2.1,
        vy: 34.5,
        vz: -0.4,
        speedMps: 34.6,
        tiltDeg: 3.2,
        throttle: 0.9,
        qKpa: 0.12,
        gLoad: 1.4,
        fuelFrac: 0.88,
        rcsPitch: 0.1,
        rcsYaw: 0,
        activeFaults: "NOMINAL",
      },
    ]);
    const flightLines = flightCsv.split("\n");
    expect(flightLines.length).toBe(2);
    expect(flightLines[0]).toContain("t_sec,phase,planet");
    expect(flightLines[1]).toContain("ASCENT,mars,launch,autopilot");

    const trainCsv = formatTrainingHistoryCSV([
      {
        updateIndex: 1,
        episodesCompleted: 3,
        totalSteps: 512,
        stepsPerSec: 32000,
        lastEpisodeReturn: -40,
        rollingMeanReturn: -55,
        landingSuccessRatePct: 33.3,
        crashRatePct: 66.7,
        meanTouchdownVy: 2.4,
        policyLoss: -0.012,
        valueLoss: 45.2,
        entropy: 3.1,
        approxKL: 0.008,
        clipFraction: 0.12,
      },
    ]);
    expect(trainCsv.split("\n").length).toBe(2);
    expect(trainCsv).toContain("update_index,episodes_completed");

    const jsonStr = buildExperimentBundleJSON({
      aethersimVersion: "0.5.0",
      planet: "mars",
      mission: "launch",
      pilot: "ai_ppo",
      faultConfig: createDefaultFaultConfig(),
      monteCarloSummary: null,
      trainingHistory: [],
      flightSeries: [],
    });
    const parsed = JSON.parse(jsonStr);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.aethersimVersion).toBe("0.5.0");
    expect(parsed.planet).toBe("mars");
    expect(parsed.flightSeriesCount).toBe(0);
  });
});
