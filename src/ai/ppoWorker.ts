import type { PlanetId } from "../config/planets";
import {
  type MonteCarloPilot,
  type MonteCarloSummary,
  runMonteCarloEvaluation,
} from "../research/MonteCarloRunner";
import type { FaultConfig } from "../sim/FaultInjector";
import type { MissionMode } from "../sim/FlightController";
import type { PolicyCheckpoint } from "./NeuralNetwork";
import {
  type BestBrainSummary,
  type EvalBatchSummary,
  PPOTrainer,
  type TrainingMetrics,
} from "./PPOTrainer";

export type WorkerInboundMessage =
  | {
      type: "INIT";
      sessionId: number;
      planetId: PlanetId;
      missionMode: MissionMode;
      randomizeSpawn: boolean;
      learningRate: number;
      faultConfig?: FaultConfig;
      seed?: number;
    }
  | {
      type: "START_TURBO_TRAIN";
      sessionId: number;
      planetId: PlanetId;
      missionMode: MissionMode;
      randomizeSpawn: boolean;
      learningRate: number;
      faultConfig?: FaultConfig;
      maxUpdates?: number;
    }
  | { type: "PAUSE_TRAIN"; sessionId: number }
  | { type: "STEP_SINGLE_UPDATE"; sessionId: number }
  | {
      type: "WARM_START";
      sessionId: number;
      planetId: PlanetId;
      missionMode: MissionMode;
      randomizeSpawn: boolean;
      learningRate: number;
      faultConfig?: FaultConfig;
      episodes?: number;
      epochs?: number;
    }
  | {
      type: "EVALUATE_BATCH";
      sessionId: number;
      episodes?: number;
      deterministic?: boolean;
    }
  | {
      type: "RUN_MONTE_CARLO";
      sessionId: number;
      episodes: number;
      pilot: MonteCarloPilot;
      planetId: PlanetId;
      missionMode: MissionMode;
      faultConfig?: FaultConfig;
      seed?: number;
    }
  | {
      type: "SYNC_WEIGHTS";
      sessionId: number;
      checkpoint: PolicyCheckpoint;
    }
  | {
      type: "LOAD_CHECKPOINT";
      sessionId: number;
      checkpoint: PolicyCheckpoint;
    }
  | { type: "EXPORT_CHECKPOINT"; sessionId: number }
  | {
      type: "RESET_WEIGHTS";
      sessionId: number;
      seed?: number;
    };

export type WorkerOutboundMessage =
  | {
      type: "READY";
      sessionId: number;
      metrics: TrainingMetrics;
      checkpoint: PolicyCheckpoint;
      bestBrain: BestBrainSummary;
      bestCheckpoint: PolicyCheckpoint;
    }
  | {
      type: "WARM_START_COMPLETE";
      sessionId: number;
      metrics: TrainingMetrics;
      evalSummary: EvalBatchSummary;
      bestBrain: BestBrainSummary;
      checkpoint: PolicyCheckpoint;
      bestCheckpoint: PolicyCheckpoint;
      statusMessage: string;
    }
  | {
      type: "TRAINING_PROGRESS";
      sessionId: number;
      running: boolean;
      metrics: TrainingMetrics;
      checkpoint: PolicyCheckpoint;
      bestBrain: BestBrainSummary;
      bestCheckpoint: PolicyCheckpoint;
      historyTail: TrainingMetrics[];
    }
  | {
      type: "PAUSED";
      sessionId: number;
      metrics: TrainingMetrics;
      checkpoint: PolicyCheckpoint;
      bestBrain: BestBrainSummary;
      bestCheckpoint: PolicyCheckpoint;
    }
  | {
      type: "EVAL_RESULT";
      sessionId: number;
      summary: EvalBatchSummary;
    }
  | {
      type: "MONTE_CARLO_RESULT";
      sessionId: number;
      summary: MonteCarloSummary;
    }
  | {
      type: "CHECKPOINT_EXPORT";
      sessionId: number;
      checkpoint: PolicyCheckpoint;
      metrics: TrainingMetrics;
    }
  | {
      type: "ERROR";
      sessionId: number;
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
let activeSessionId = 0;

function stopTurboLoop(): void {
  turboRunning = false;
  if (loopTimer !== null) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

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
  const tickSession = activeSessionId;
  if (remainingUpdates <= 0) {
    turboRunning = false;
    workerScope.postMessage({
      type: "PAUSED",
      sessionId: tickSession,
      metrics: { ...trainer.getLastMetrics(), stepsPerSec: 0 },
      checkpoint: trainer.exportCheckpoint(),
      bestBrain: trainer.getBestBrain(),
      bestCheckpoint: trainer.exportBestCheckpoint(),
    });
    return;
  }

  loopTimer = setTimeout(() => {
    if (!turboRunning || !trainer || tickSession !== activeSessionId) {
      return;
    }
    try {
      const metrics = trainer.trainOneUpdate();
      if (tickSession !== activeSessionId || !turboRunning) {
        return;
      }
      remainingUpdates -= 1;
      const history = trainer.getHistory();
      workerScope.postMessage({
        type: "TRAINING_PROGRESS",
        sessionId: tickSession,
        running: turboRunning && remainingUpdates > 0,
        metrics,
        checkpoint: trainer.exportCheckpoint(),
        bestBrain: trainer.getBestBrain(),
        bestCheckpoint: trainer.exportBestCheckpoint(),
        historyTail: history.slice(-60),
      });
      if (remainingUpdates <= 0) {
        turboRunning = false;
        workerScope.postMessage({
          type: "PAUSED",
          sessionId: tickSession,
          metrics: { ...metrics, stepsPerSec: 0 },
          checkpoint: trainer.exportCheckpoint(),
          bestBrain: trainer.getBestBrain(),
          bestCheckpoint: trainer.exportBestCheckpoint(),
        });
      } else {
        scheduleNextTurboTick();
      }
    } catch (err) {
      turboRunning = false;
      workerScope.postMessage({
        type: "ERROR",
        sessionId: tickSession,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, 0);
}

workerScope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.sessionId < activeSessionId) {
    return;
  }
  if (msg.sessionId > activeSessionId) {
    activeSessionId = msg.sessionId;
    if (
      msg.type === "INIT" ||
      msg.type === "WARM_START" ||
      msg.type === "PAUSE_TRAIN" ||
      msg.type === "RESET_WEIGHTS"
    ) {
      stopTurboLoop();
    }
  }
  const msgSession = msg.sessionId;

  try {
    switch (msg.type) {
      case "INIT": {
        stopTurboLoop();
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
          sessionId: msgSession,
          metrics: { ...t.getLastMetrics(), stepsPerSec: 0 },
          checkpoint: t.exportCheckpoint(),
          bestBrain: t.getBestBrain(),
          bestCheckpoint: t.exportBestCheckpoint(),
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
        stopTurboLoop();
        if (trainer) {
          workerScope.postMessage({
            type: "PAUSED",
            sessionId: msgSession,
            metrics: { ...trainer.getLastMetrics(), stepsPerSec: 0 },
            checkpoint: trainer.exportCheckpoint(),
            bestBrain: trainer.getBestBrain(),
            bestCheckpoint: trainer.exportBestCheckpoint(),
          });
        }
        break;
      }
      case "STEP_SINGLE_UPDATE": {
        const t = ensureTrainer();
        const metrics = t.trainOneUpdate();
        workerScope.postMessage({
          type: "TRAINING_PROGRESS",
          sessionId: msgSession,
          running: false,
          metrics,
          checkpoint: t.exportCheckpoint(),
          bestBrain: t.getBestBrain(),
          bestCheckpoint: t.exportBestCheckpoint(),
          historyTail: t.getHistory().slice(-60),
        });
        break;
      }
      case "WARM_START": {
        stopTurboLoop();
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
        const res = t.warmStartWithSummary(msg.episodes ?? 12, msg.epochs ?? 14);
        if (msgSession !== activeSessionId) {
          return;
        }
        workerScope.postMessage({
          type: "WARM_START_COMPLETE",
          sessionId: msgSession,
          metrics: res.metrics,
          evalSummary: res.evalSummary,
          bestBrain: res.bestBrain,
          checkpoint: res.checkpoint,
          bestCheckpoint: res.bestCheckpoint,
          statusMessage: res.statusMessage,
        });
        break;
      }
      case "EVALUATE_BATCH": {
        const t = ensureTrainer();
        const summary = t.evaluateBatch(msg.episodes ?? 10, msg.deterministic ?? true);
        workerScope.postMessage({ type: "EVAL_RESULT", sessionId: msgSession, summary });
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
          checkpoint: msg.pilot === "ai_ppo" ? t.exportBestCheckpoint() : undefined,
          seed: msg.seed ?? 2026,
        });
        workerScope.postMessage({ type: "MONTE_CARLO_RESULT", sessionId: msgSession, summary });
        break;
      }
      case "SYNC_WEIGHTS":
      case "LOAD_CHECKPOINT": {
        const t = ensureTrainer();
        t.loadCheckpoint(msg.checkpoint);
        workerScope.postMessage({
          type: "READY",
          sessionId: msgSession,
          metrics: { ...t.getLastMetrics(), stepsPerSec: 0 },
          checkpoint: t.exportCheckpoint(),
          bestBrain: t.getBestBrain(),
          bestCheckpoint: t.exportBestCheckpoint(),
        });
        break;
      }
      case "EXPORT_CHECKPOINT": {
        const t = ensureTrainer();
        workerScope.postMessage({
          type: "CHECKPOINT_EXPORT",
          sessionId: msgSession,
          checkpoint: t.exportBestCheckpoint(),
          metrics: t.getLastMetrics(),
        });
        break;
      }
      case "RESET_WEIGHTS": {
        stopTurboLoop();
        const t = ensureTrainer();
        t.resetWeights(msg.seed ?? 42);
        workerScope.postMessage({
          type: "READY",
          sessionId: msgSession,
          metrics: t.getLastMetrics(),
          checkpoint: t.exportCheckpoint(),
          bestBrain: t.getBestBrain(),
          bestCheckpoint: t.exportBestCheckpoint(),
        });
        break;
      }
    }
  } catch (err) {
    stopTurboLoop();
    workerScope.postMessage({
      type: "ERROR",
      sessionId: msgSession,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
