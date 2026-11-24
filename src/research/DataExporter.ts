import type { TrainingMetrics } from "../ai/PPOTrainer";
import type { PlanetId } from "../config/planets";
import type { FaultConfig } from "../sim/FaultInjector";
import type { ControlMode, MissionMode } from "../sim/FlightController";
import type { MonteCarloSummary } from "./MonteCarloRunner";

export interface FlightLogSample {
  readonly tSec: number;
  readonly phase: string;
  readonly planet: PlanetId;
  readonly mission: MissionMode;
  readonly pilot: ControlMode;
  readonly x: number;
  readonly altM: number;
  readonly z: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly speedMps: number;
  readonly tiltDeg: number;
  readonly throttle: number;
  readonly qKpa: number;
  readonly gLoad: number;
  readonly fuelFrac: number;
  readonly rcsPitch: number;
  readonly rcsYaw: number;
  readonly activeFaults: string;
}

export interface ExperimentBundleInput {
  readonly aethersimVersion: string;
  readonly planet: PlanetId;
  readonly mission: MissionMode;
  readonly pilot: ControlMode;
  readonly faultConfig: FaultConfig;
  readonly monteCarloSummary: MonteCarloSummary | null;
  readonly trainingHistory: readonly TrainingMetrics[];
  readonly flightSeries: readonly FlightLogSample[];
}

function csvEscape(val: string | number): string {
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function formatFlightTelemetryCSV(samples: readonly FlightLogSample[]): string {
  const header = [
    "t_sec",
    "phase",
    "planet",
    "mission",
    "pilot",
    "x_m",
    "alt_m",
    "z_m",
    "vx_mps",
    "vy_mps",
    "vz_mps",
    "speed_mps",
    "tilt_deg",
    "throttle",
    "q_kpa",
    "g_load",
    "fuel_frac",
    "rcs_pitch",
    "rcs_yaw",
    "active_faults",
  ].join(",");

  const rows = samples.map((s) =>
    [
      s.tSec.toFixed(3),
      csvEscape(s.phase),
      s.planet,
      s.mission,
      s.pilot,
      s.x.toFixed(3),
      s.altM.toFixed(3),
      s.z.toFixed(3),
      s.vx.toFixed(3),
      s.vy.toFixed(3),
      s.vz.toFixed(3),
      s.speedMps.toFixed(3),
      s.tiltDeg.toFixed(3),
      s.throttle.toFixed(4),
      s.qKpa.toFixed(4),
      s.gLoad.toFixed(3),
      s.fuelFrac.toFixed(4),
      s.rcsPitch.toFixed(4),
      s.rcsYaw.toFixed(4),
      csvEscape(s.activeFaults),
    ].join(",")
  );

  return [header, ...rows].join("\n");
}

export function formatTrainingHistoryCSV(history: readonly TrainingMetrics[]): string {
  const header = [
    "update_index",
    "episodes_completed",
    "total_steps",
    "steps_per_sec",
    "last_episode_return",
    "rolling_mean_return",
    "success_rate_pct",
    "crash_rate_pct",
    "mean_touchdown_vy",
    "policy_loss",
    "value_loss",
    "entropy",
    "approx_kl",
    "clip_fraction",
  ].join(",");

  const rows = history.map((m) =>
    [
      m.updateIndex,
      m.episodesCompleted,
      m.totalSteps,
      m.stepsPerSec,
      m.lastEpisodeReturn.toFixed(4),
      m.rollingMeanReturn.toFixed(4),
      m.landingSuccessRatePct.toFixed(2),
      m.crashRatePct.toFixed(2),
      m.meanTouchdownVy !== null ? m.meanTouchdownVy.toFixed(4) : "",
      m.policyLoss.toFixed(6),
      m.valueLoss.toFixed(6),
      m.entropy.toFixed(6),
      m.approxKL.toFixed(6),
      m.clipFraction.toFixed(4),
    ].join(",")
  );

  return [header, ...rows].join("\n");
}

export function buildExperimentBundleJSON(input: ExperimentBundleInput): string {
  const payload = {
    schemaVersion: 1,
    exportedAtIso: new Date().toISOString(),
    aethersimVersion: input.aethersimVersion,
    planet: input.planet,
    mission: input.mission,
    pilot: input.pilot,
    faultConfig: input.faultConfig,
    monteCarloSummary: input.monteCarloSummary,
    trainingMetrics: input.trainingHistory,
    flightSeriesCount: input.flightSeries.length,
    flightSeries: input.flightSeries,
  };
  return JSON.stringify(payload, null, 2);
}

export function triggerBrowserDownload(
  filename: string,
  content: string,
  mimeType = "text/plain;charset=utf-8"
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
