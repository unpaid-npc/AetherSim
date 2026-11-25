import { PPOTrainer } from "../ai/PPOTrainer";
import type { PlanetId } from "../config/planets";
import { createDefaultFaultConfig, type FaultConfig } from "../sim/FaultInjector";
import {
  type MonteCarloSummary,
  runMonteCarloEvaluation,
} from "./MonteCarloRunner";

export interface BenchmarkRow {
  readonly scenario: "nominal" | "fault_stress";
  readonly planet: PlanetId;
  readonly policy: "untrained_ppo" | "ppo_scratch" | "ppo_trained" | "pid_baseline";
  readonly protocol: string;
  readonly trainSteps: number;
  readonly trainWallMs: number;
  readonly evalSummary: MonteCarloSummary;
}

export interface BenchmarkReport {
  readonly generatedAtIso: string;
  readonly seedStart: number;
  readonly episodesPerCondition: number;
  readonly ppoProtocol: {
    readonly scratchUpdates: number;
    readonly scratchStepsPerUpdate: number;
    readonly warmStartEpisodes: number;
    readonly warmStartEpochs: number;
    readonly fineTuneUpdates: number;
    readonly fineTuneStepsPerUpdate: number;
  };
  readonly stressFaults: Record<PlanetId, FaultConfig>;
  readonly rows: readonly BenchmarkRow[];
  readonly totalWallMs: number;
}

const PLANETS: readonly PlanetId[] = ["mars", "earth", "moon"];
const SEED_START = 42;
const EPISODES = 20;

export function runV1BenchmarkSuite(): BenchmarkReport {
  const suiteStart = performance.now();

  const stressFaults: Record<PlanetId, FaultConfig> = {
    mars: { ...createDefaultFaultConfig(), thrustLossPct: 15, windSpeedMps: 15, windDirectionDeg: 0 },
    earth: { ...createDefaultFaultConfig(), thrustLossPct: 15, windSpeedMps: 15, windDirectionDeg: 0 },
    moon: { ...createDefaultFaultConfig(), thrustLossPct: 15, windSpeedMps: 0, windDirectionDeg: 0 },
  };

  const rows: BenchmarkRow[] = [];

  const scratchUpdates = 16;
  const scratchStepsPerUpdate = 512;
  const warmStartEpisodes = 12;
  const warmStartEpochs = 10;
  const fineTuneUpdates = 16;
  const fineTuneStepsPerUpdate = 512;

  for (const planet of PLANETS) {
    // 1. Untrained PPO baseline (0 updates)
    const untrained = new PPOTrainer(
      { planetId: planet, missionMode: "landing", randomizeSpawn: true },
      { rolloutSteps: scratchStepsPerUpdate },
      SEED_START
    );
    rows.push({
      scenario: "nominal",
      planet,
      policy: "untrained_ppo",
      protocol: "Seeded orthogonal init, 0 updates",
      trainSteps: 0,
      trainWallMs: 0,
      evalSummary: runMonteCarloEvaluation({
        episodes: EPISODES,
        pilot: "ai_ppo",
        planetId: planet,
        missionMode: "landing",
        checkpoint: untrained.exportCheckpoint(),
        seed: SEED_START,
      }),
    });

    // 2. Pure PPO from scratch (16 updates x 512 = 8,192 steps)
    const tScratch0 = performance.now();
    const scratchTrainer = new PPOTrainer(
      { planetId: planet, missionMode: "landing", randomizeSpawn: true },
      { learningRate: 8e-4, rolloutSteps: scratchStepsPerUpdate, epochs: 6, miniBatchSize: 64 },
      SEED_START
    );
    for (let u = 0; u < scratchUpdates; u++) {
      scratchTrainer.trainOneUpdate();
    }
    const scratchWall = Math.round(performance.now() - tScratch0);
    rows.push({
      scenario: "nominal",
      planet,
      policy: "ppo_scratch",
      protocol: `Pure PPO (${scratchUpdates}x${scratchStepsPerUpdate} = ${scratchUpdates * scratchStepsPerUpdate} steps, lr=8e-4)`,
      trainSteps: scratchTrainer.totalSteps,
      trainWallMs: scratchWall,
      evalSummary: runMonteCarloEvaluation({
        episodes: EPISODES,
        pilot: "ai_ppo",
        planetId: planet,
        missionMode: "landing",
        checkpoint: scratchTrainer.exportCheckpoint(),
        seed: SEED_START,
      }),
    });

    // 3. Warm-Start BC + PPO Fine-Tuning
    const tTrained0 = performance.now();
    const trainedTrainer = new PPOTrainer(
      { planetId: planet, missionMode: "landing", randomizeSpawn: true },
      { learningRate: 3e-4, rolloutSteps: fineTuneStepsPerUpdate, epochs: 6, miniBatchSize: 64 },
      SEED_START
    );
    trainedTrainer.warmStartFromGuidance(warmStartEpisodes, warmStartEpochs);
    for (let u = 0; u < fineTuneUpdates; u++) {
      trainedTrainer.trainOneUpdate();
    }
    const trainedWall = Math.round(performance.now() - tTrained0);
    const trainedCheckpoint = trainedTrainer.exportCheckpoint();

    rows.push({
      scenario: "nominal",
      planet,
      policy: "ppo_trained",
      protocol: `Warm-Start (${warmStartEpisodes} ep, ${warmStartEpochs} epochs) + PPO (${fineTuneUpdates}x${fineTuneStepsPerUpdate} steps, lr=3e-4)`,
      trainSteps: trainedTrainer.totalSteps,
      trainWallMs: trainedWall,
      evalSummary: runMonteCarloEvaluation({
        episodes: EPISODES,
        pilot: "ai_ppo",
        planetId: planet,
        missionMode: "landing",
        checkpoint: trainedCheckpoint,
        seed: SEED_START,
      }),
    });

    // 4. Classical PID Baseline (Nominal)
    rows.push({
      scenario: "nominal",
      planet,
      policy: "pid_baseline",
      protocol: "Classical FlightController PID_AUTO",
      trainSteps: 0,
      trainWallMs: 0,
      evalSummary: runMonteCarloEvaluation({
        episodes: EPISODES,
        pilot: "autopilot",
        planetId: planet,
        missionMode: "landing",
        seed: SEED_START,
      }),
    });

    // 5. Fault Stress Test (15% thrust loss + 15 m/s crosswind on Mars/Earth)
    const faults = stressFaults[planet];
    rows.push({
      scenario: "fault_stress",
      planet,
      policy: "ppo_trained",
      protocol: `Fault stress (${faults.thrustLossPct}% thrust loss, ${faults.windSpeedMps} m/s wind)`,
      trainSteps: trainedTrainer.totalSteps,
      trainWallMs: trainedWall,
      evalSummary: runMonteCarloEvaluation({
        episodes: EPISODES,
        pilot: "ai_ppo",
        planetId: planet,
        missionMode: "landing",
        faultConfig: faults,
        checkpoint: trainedCheckpoint,
        seed: SEED_START,
      }),
    });

    rows.push({
      scenario: "fault_stress",
      planet,
      policy: "pid_baseline",
      protocol: `Fault stress (${faults.thrustLossPct}% thrust loss, ${faults.windSpeedMps} m/s wind)`,
      trainSteps: 0,
      trainWallMs: 0,
      evalSummary: runMonteCarloEvaluation({
        episodes: EPISODES,
        pilot: "autopilot",
        planetId: planet,
        missionMode: "landing",
        faultConfig: faults,
        seed: SEED_START,
      }),
    });
  }

  return {
    generatedAtIso: new Date().toISOString(),
    seedStart: SEED_START,
    episodesPerCondition: EPISODES,
    ppoProtocol: {
      scratchUpdates,
      scratchStepsPerUpdate,
      warmStartEpisodes,
      warmStartEpochs,
      fineTuneUpdates,
      fineTuneStepsPerUpdate,
    },
    stressFaults,
    rows,
    totalWallMs: Math.round(performance.now() - suiteStart),
  };
}
