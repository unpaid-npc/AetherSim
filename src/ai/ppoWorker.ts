import type { PlanetId } from "../config/planets";
import {
  type MonteCarloPilot,
  type MonteCarloSummary,
  runMonteCarloEvaluation,
} from "../research/MonteCarloRunner";
import type { FaultConfig } from "../sim/FaultInjector";
import type { MissionMode } from "../sim/FlightController";
import type { PolicyCheckpoint } from "./NeuralNetwork";
import { type EvalBatchSummary, PPOTrainer, type TrainingMetrics } from "./PPOTrainer";

export type WorkerInboundMessage =
  | {
      type: "INIT";
      planetId: PlanetId;
      missionMode: MissionMode;
      randomizeSpawn: boolean;
      learningRate: number;
      faultConfig?: FaultConfig;
      seed?: number;
    }
  | {
      type: "START_TURBO_TRAIN";
      planetId: PlanetId;
      missionMode: MissionMode;
      randomizeSpawn: boolean;
      learningRate: number;
      faultConfig?: FaultConfig;
      maxUpdates?: number;
    }
  | { type: "PAUSE_TRAIN" }
  | { type: "STEP_SINGLE_UPDATE" }
  | {
      type: "WARM_START";
      episodes?: number;
      epochs?: number;
    }
  | {
      type: "EVALUATE_BATCH";
      episodes?: number;
      deterministic?: boolean;
    }
  | {
      type: "RUN_MONTE_CARLO";
      episodes: number;
      pilot: MonteCarloPilot;
      planetId: PlanetId;
      missionMode: MissionMode;
      faultConfig?: FaultConfig;
      seed?: number;
    }
  | {
      type: "SYNC_WEIGHTS";
      checkpoint: PolicyCheckpoint;
    }
  | {
      type: "LOAD_CHECKPOINT";
      checkpoint: PolicyCheckpoint;
    }
  | { type: "EXPORT_CHECKPOINT" }
  | {
      type: "RESET_WEIGHTS";
      seed?: number;
    };

export type WorkerOutboundMessage =
  | {
      type: "READY";
      metrics: TrainingMetrics;
      checkpoint: PolicyCheckpoint;
    }
  | {
      type: "TRAINING_PROGRESS";
      running: boolean;
      metrics: TrainingMetrics;
      checkpoint: PolicyCheckpoint;
      historyTail: TrainingMetrics[];
    }
  | {
      type: "PAUSED";
      metrics: TrainingMetrics;
      checkpoint: PolicyCheckpoint;
    }
  | {
      type: "EVAL_RESULT";
      summary: EvalBatchSummary;
    }
  | {
      type: "MONTE_CARLO_RESULT";
      summary: MonteCarloSummary;
    }
  | {
      type: "CHECKPOINT_EXPORT";
      checkpoint: PolicyCheckpoint;
      metrics: TrainingMetrics;
    }
  | {
      type: "ERROR";
      message: string;
    };

interface WorkerGlobalScopeLike {
  onmessage: ((ev: { data: WorkerInboundMessage }) => void) | null;
  postMessage: (msg: WorkerOutboundMessage) => void;
}

const workerScope = globalThis as unknown as WorkerGlobalScopeLike;

let trainer: PPOTrainer | null = null;
let turboRunning = false;
let remainingUpdates = Number.POSITIVE_INFINITY;
let loopTimer: ReturnType<typeof setTimeout> | null = null;

function ensureTrainer(
  planetId: PlanetId = "mars",
  missionMode: MissionMode = "landing",
  randomizeSpawn = true,
  learningRate = 6e-4,
  seed = 42
): PPOTrainer {
  if (!trainer) {
    trainer = new PPOTrainer(
      { planetId, missionMode, randomizeSpawn },
      { learningRate, rolloutSteps: 512 },
      seed
    );
  }
  return trainer;
}

function scheduleNextTurboTick(): void {
  if (!turboRunning || !trainer) {
    return;
  }
  if (remainingUpdates <= 0) {
    turboRunning = false;
    workerScope.postMessage({
      type: "PAUSED",
      metrics: trainer.getLastMetrics(),
      checkpoint: trainer.exportCheckpoint(),
    });
    return;
  }

  loopTimer = setTimeout(() => {
    if (!turboRunning || !trainer) {
      return;
    }
    try {
      const metrics = trainer.trainOneUpdate();
      remainingUpdates -= 1;
      const history = trainer.getHistory();
      workerScope.postMessage({
        type: "TRAINING_PROGRESS",
        running: turboRunning && remainingUpdates > 0,
        metrics,
        checkpoint: trainer.exportCheckpoint(),
        historyTail: history.slice(-60),
      });
      if (remainingUpdates <= 0) {
        turboRunning = false;
        workerScope.postMessage({
          type: "PAUSED",
          metrics,
          checkpoint: trainer.exportCheckpoint(),
        });
      } else {
        scheduleNextTurboTick();
      }
    } catch (err) {
      turboRunning = false;
      workerScope.postMessage({
        type: "ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, 0);
}

workerScope.onmessage = (ev) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case "INIT": {
        const t = ensureTrainer(
          msg.planetId,
          msg.missionMode,
          msg.randomizeSpawn,
          msg.learningRate,
          msg.seed ?? 42
        );
        t.setEnvConfig(
          msg.planetId,
          msg.missionMode,
          msg.randomizeSpawn,
          msg.faultConfig
        );
        t.setLearningRate(msg.learningRate);
        workerScope.postMessage({
          type: "READY",
          metrics: t.getLastMetrics(),
          checkpoint: t.exportCheckpoint(),
        });
        break;
      }
      case "START_TURBO_TRAIN": {
        const t = ensureTrainer(
          msg.planetId,
          msg.missionMode,
          msg.randomizeSpawn,
          msg.learningRate
        );
        t.setEnvConfig(
          msg.planetId,
          msg.missionMode,
          msg.randomizeSpawn,
          msg.faultConfig
        );
        t.setLearningRate(msg.learningRate);
        remainingUpdates =
          msg.maxUpdates && msg.maxUpdates > 0 ? msg.maxUpdates : Number.POSITIVE_INFINITY;
        if (!turboRunning) {
          turboRunning = true;
          scheduleNextTurboTick();
        }
        break;
      }
      case "PAUSE_TRAIN": {
        turboRunning = false;
        if (loopTimer !== null) {
          clearTimeout(loopTimer);
          loopTimer = null;
        }
        if (trainer) {
          workerScope.postMessage({
            type: "PAUSED",
            metrics: trainer.getLastMetrics(),
            checkpoint: trainer.exportCheckpoint(),
          });
        }
        break;
      }
      case "STEP_SINGLE_UPDATE": {
        const t = ensureTrainer();
        const metrics = t.trainOneUpdate();
        workerScope.postMessage({
          type: "TRAINING_PROGRESS",
          running: false,
          metrics,
          checkpoint: t.exportCheckpoint(),
          historyTail: t.getHistory().slice(-60),
        });
        break;
      }
      case "WARM_START": {
        const t = ensureTrainer();
        const metrics = t.warmStartFromGuidance(msg.episodes ?? 12, msg.epochs ?? 8);
        workerScope.postMessage({
          type: "TRAINING_PROGRESS",
          running: turboRunning,
          metrics,
          checkpoint: t.exportCheckpoint(),
          historyTail: t.getHistory().slice(-60),
        });
        break;
      }
      case "EVALUATE_BATCH": {
        const t = ensureTrainer();
        const summary = t.evaluateBatch(msg.episodes ?? 10, msg.deterministic ?? true);
        workerScope.postMessage({ type: "EVAL_RESULT", summary });
        break;
      }
      case "RUN_MONTE_CARLO": {
        const t = ensureTrainer(msg.planetId, msg.missionMode, true, 6e-4);
        const summary = runMonteCarloEvaluation({
          episodes: msg.episodes,
          pilot: msg.pilot,
          planetId: msg.planetId,
          missionMode: msg.missionMode,
          faultConfig: msg.faultConfig,
          checkpoint: msg.pilot === "ai_ppo" ? t.exportCheckpoint() : undefined,
          seed: msg.seed ?? 2026,
        });
        workerScope.postMessage({ type: "MONTE_CARLO_RESULT", summary });
        break;
      }
      case "SYNC_WEIGHTS":
      case "LOAD_CHECKPOINT": {
        const t = ensureTrainer();
        t.loadCheckpoint(msg.checkpoint);
        workerScope.postMessage({
          type: "READY",
          metrics: t.getLastMetrics(),
          checkpoint: t.exportCheckpoint(),
        });
        break;
      }
      case "EXPORT_CHECKPOINT": {
        const t = ensureTrainer();
        workerScope.postMessage({
          type: "CHECKPOINT_EXPORT",
          checkpoint: t.exportCheckpoint(),
          metrics: t.getLastMetrics(),
        });
        break;
      }
      case "RESET_WEIGHTS": {
        turboRunning = false;
        if (loopTimer !== null) {
          clearTimeout(loopTimer);
          loopTimer = null;
        }
        const t = ensureTrainer();
        t.resetWeights(msg.seed ?? 42);
        workerScope.postMessage({
          type: "READY",
          metrics: t.getLastMetrics(),
          checkpoint: t.exportCheckpoint(),
        });
        break;
      }
    }
  } catch (err) {
    turboRunning = false;
    workerScope.postMessage({
      type: "ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
