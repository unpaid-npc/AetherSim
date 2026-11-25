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
import type { WorkerInboundMessage, WorkerOutboundMessage } from "./ppoWorker";

export interface PPOWorkerCallbacks {
  onProgress?: (
    metrics: TrainingMetrics,
    checkpoint: PolicyCheckpoint,
    historyTail: TrainingMetrics[],
    running: boolean,
    bestBrain: BestBrainSummary,
    bestCheckpoint: PolicyCheckpoint
  ) => void;
  onWarmStartComplete?: (payload: {
    metrics: TrainingMetrics;
    evalSummary: EvalBatchSummary;
    bestBrain: BestBrainSummary;
    checkpoint: PolicyCheckpoint;
    bestCheckpoint: PolicyCheckpoint;
    statusMessage: string;
  }) => void;
  onPaused?: (
    metrics: TrainingMetrics,
    checkpoint: PolicyCheckpoint,
    bestBrain: BestBrainSummary,
    bestCheckpoint: PolicyCheckpoint
  ) => void;
  onReady?: (
    metrics: TrainingMetrics,
    checkpoint: PolicyCheckpoint,
    bestBrain: BestBrainSummary,
    bestCheckpoint: PolicyCheckpoint
  ) => void;
  onEvalResult?: (summary: EvalBatchSummary) => void;
  onMonteCarloResult?: (summary: MonteCarloSummary) => void;
  onError?: (message: string) => void;
}

/**
 * Main-thread bridge for the PPO training Web Worker (`ppoWorker.ts`),
 * with session-ID staleness filtering and graceful async fallback.
 */
export class PPOWorkerClient {
  private worker: Worker | null = null;
  private fallbackTrainer: PPOTrainer | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackRunning = false;
  private callbacks: PPOWorkerCallbacks;
  private disposed = false;
  private currentSessionId = 1;

  constructor(callbacks: PPOWorkerCallbacks) {
    this.callbacks = callbacks;
  }

  getSessionId(): number {
    return this.currentSessionId;
  }

  bumpSession(): number {
    this.currentSessionId += 1;
    this.fallbackRunning = false;
    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    return this.currentSessionId;
  }

  private ensureWorkerOrFallback(
    planetId: PlanetId = "mars",
    missionMode: MissionMode = "landing",
    randomizeSpawn = true,
    learningRate = 6e-4
  ): void {
    if (this.worker || this.fallbackTrainer || this.disposed) {
      return;
    }
    if (typeof Worker !== "undefined") {
      try {
        const w = new Worker(new URL("./ppoWorker.ts", import.meta.url), {
          type: "module",
        });
        w.onmessage = (ev: MessageEvent<WorkerOutboundMessage>) => {
          this.handleOutbound(ev.data);
        };
        w.onerror = (err) => {
          this.callbacks.onError?.(err.message || "PPO Worker error");
        };
        this.worker = w;
        return;
      } catch {
        // Fallback to chunked async trainer
      }
    }
    this.fallbackTrainer = new PPOTrainer(
      { planetId, missionMode, randomizeSpawn },
      { learningRate, rolloutSteps: 512 },
      42
    );
  }

  private handleOutbound(msg: WorkerOutboundMessage): void {
    if (msg.sessionId !== this.currentSessionId) {
      return;
    }
    switch (msg.type) {
      case "READY":
        this.callbacks.onReady?.(
          msg.metrics,
          msg.checkpoint,
          msg.bestBrain,
          msg.bestCheckpoint
        );
        break;
      case "WARM_START_COMPLETE":
        this.callbacks.onWarmStartComplete?.({
          metrics: msg.metrics,
          evalSummary: msg.evalSummary,
          bestBrain: msg.bestBrain,
          checkpoint: msg.checkpoint,
          bestCheckpoint: msg.bestCheckpoint,
          statusMessage: msg.statusMessage,
        });
        break;
      case "TRAINING_PROGRESS":
        this.callbacks.onProgress?.(
          msg.metrics,
          msg.checkpoint,
          msg.historyTail,
          msg.running,
          msg.bestBrain,
          msg.bestCheckpoint
        );
        break;
      case "PAUSED":
        this.callbacks.onPaused?.(
          msg.metrics,
          msg.checkpoint,
          msg.bestBrain,
          msg.bestCheckpoint
        );
        break;
      case "EVAL_RESULT":
        this.callbacks.onEvalResult?.(msg.summary);
        break;
      case "MONTE_CARLO_RESULT":
        this.callbacks.onMonteCarloResult?.(msg.summary);
        break;
      case "ERROR":
        this.callbacks.onError?.(msg.message);
        break;
    }
  }

  private post(msg: WorkerInboundMessage): void {
    if (this.worker) {
      this.worker.postMessage(msg);
      return;
    }
    this.handleFallback(msg);
  }

  private handleFallback(msg: WorkerInboundMessage): void {
    if (!this.fallbackTrainer || msg.sessionId !== this.currentSessionId) {
      return;
    }
    const t = this.fallbackTrainer;
    const msgSession = msg.sessionId;
    switch (msg.type) {
      case "INIT":
        this.fallbackRunning = false;
        t.setEnvConfig(
          msg.planetId,
          msg.missionMode,
          msg.randomizeSpawn,
          msg.faultConfig
        );
        t.setLearningRate(msg.learningRate);
        this.callbacks.onReady?.(
          { ...t.getLastMetrics(), stepsPerSec: 0 },
          t.exportCheckpoint(),
          t.getBestBrain(),
          t.exportBestCheckpoint()
        );
        break;
      case "START_TURBO_TRAIN": {
        t.setEnvConfig(
          msg.planetId,
          msg.missionMode,
          msg.randomizeSpawn,
          msg.faultConfig
        );
        t.setLearningRate(msg.learningRate);
        this.fallbackRunning = true;
        const tick = () => {
          if (!this.fallbackRunning || this.disposed || msgSession !== this.currentSessionId) {
            return;
          }
          const metrics = t.trainOneUpdate();
          if (msgSession !== this.currentSessionId) {
            return;
          }
          this.callbacks.onProgress?.(
            metrics,
            t.exportCheckpoint(),
            t.getHistory().slice(-60),
            true,
            t.getBestBrain(),
            t.exportBestCheckpoint()
          );
          this.fallbackTimer = setTimeout(tick, 4);
        };
        tick();
        break;
      }
      case "PAUSE_TRAIN":
        this.fallbackRunning = false;
        if (this.fallbackTimer !== null) {
          clearTimeout(this.fallbackTimer);
          this.fallbackTimer = null;
        }
        this.callbacks.onPaused?.(
          { ...t.getLastMetrics(), stepsPerSec: 0 },
          t.exportCheckpoint(),
          t.getBestBrain(),
          t.exportBestCheckpoint()
        );
        break;
      case "WARM_START": {
        this.fallbackRunning = false;
        if (this.fallbackTimer !== null) {
          clearTimeout(this.fallbackTimer);
          this.fallbackTimer = null;
        }
        setTimeout(() => {
          if (this.disposed || msgSession !== this.currentSessionId) {
            return;
          }
          t.setEnvConfig(
            msg.planetId,
            msg.missionMode,
            msg.randomizeSpawn,
            msg.faultConfig
          );
          t.setLearningRate(msg.learningRate);
          const res = t.warmStartWithSummary(msg.episodes ?? 12, msg.epochs ?? 14);
          if (msgSession !== this.currentSessionId) {
            return;
          }
          this.callbacks.onWarmStartComplete?.({
            metrics: res.metrics,
            evalSummary: res.evalSummary,
            bestBrain: res.bestBrain,
            checkpoint: res.checkpoint,
            bestCheckpoint: res.bestCheckpoint,
            statusMessage: res.statusMessage,
          });
        }, 0);
        break;
      }
      case "SYNC_WEIGHTS":
      case "LOAD_CHECKPOINT":
        t.loadCheckpoint(msg.checkpoint);
        this.callbacks.onReady?.(
          { ...t.getLastMetrics(), stepsPerSec: 0 },
          t.exportCheckpoint(),
          t.getBestBrain(),
          t.exportBestCheckpoint()
        );
        break;
      case "RESET_WEIGHTS":
        this.fallbackRunning = false;
        t.resetWeights(msg.seed ?? 42);
        this.callbacks.onReady?.(
          t.getLastMetrics(),
          t.exportCheckpoint(),
          t.getBestBrain(),
          t.exportBestCheckpoint()
        );
        break;
      case "EVALUATE_BATCH":
        this.callbacks.onEvalResult?.(
          t.evaluateBatch(msg.episodes ?? 10, msg.deterministic ?? true)
        );
        break;
      case "RUN_MONTE_CARLO":
        this.callbacks.onMonteCarloResult?.(
          runMonteCarloEvaluation({
            episodes: msg.episodes,
            pilot: msg.pilot,
            planetId: msg.planetId,
            missionMode: msg.missionMode,
            faultConfig: msg.faultConfig,
            checkpoint: msg.pilot === "ai_ppo" ? t.exportBestCheckpoint() : undefined,
            seed: msg.seed ?? 2026,
          })
        );
        break;
    }
  }

  init(
    planetId: PlanetId,
    missionMode: MissionMode,
    randomizeSpawn: boolean,
    learningRate: number,
    faultConfig?: FaultConfig
  ): void {
    this.ensureWorkerOrFallback(planetId, missionMode, randomizeSpawn, learningRate);
    this.post({
      type: "INIT",
      sessionId: this.currentSessionId,
      planetId,
      missionMode,
      randomizeSpawn,
      learningRate,
      faultConfig,
    });
  }

  startTurboTrain(
    planetId: PlanetId,
    missionMode: MissionMode,
    randomizeSpawn: boolean,
    learningRate: number,
    faultConfig?: FaultConfig,
    maxUpdates?: number
  ): void {
    this.ensureWorkerOrFallback(planetId, missionMode, randomizeSpawn, learningRate);
    this.post({
      type: "START_TURBO_TRAIN",
      sessionId: this.currentSessionId,
      planetId,
      missionMode,
      randomizeSpawn,
      learningRate,
      faultConfig,
      maxUpdates,
    });
  }

  runMonteCarlo(
    episodes: number,
    pilot: MonteCarloPilot,
    planetId: PlanetId,
    missionMode: MissionMode,
    faultConfig?: FaultConfig,
    seed = 2026
  ): void {
    this.ensureWorkerOrFallback(planetId, missionMode, true, 6e-4);
    this.post({
      type: "RUN_MONTE_CARLO",
      sessionId: this.currentSessionId,
      episodes,
      pilot,
      planetId,
      missionMode,
      faultConfig,
      seed,
    });
  }

  pause(): void {
    if (!this.worker && !this.fallbackTrainer) {
      return;
    }
    this.post({ type: "PAUSE_TRAIN", sessionId: this.currentSessionId });
  }

  warmStart(
    planetId: PlanetId,
    missionMode: MissionMode,
    randomizeSpawn: boolean,
    learningRate: number,
    faultConfig?: FaultConfig,
    episodes = 12,
    epochs = 14
  ): void {
    this.ensureWorkerOrFallback(planetId, missionMode, randomizeSpawn, learningRate);
    this.post({
      type: "WARM_START",
      sessionId: this.currentSessionId,
      planetId,
      missionMode,
      randomizeSpawn,
      learningRate,
      faultConfig,
      episodes,
      epochs,
    });
  }

  syncWeights(checkpoint: PolicyCheckpoint): void {
    this.ensureWorkerOrFallback();
    this.post({
      type: "SYNC_WEIGHTS",
      sessionId: this.currentSessionId,
      checkpoint,
    });
  }

  loadCheckpoint(checkpoint: PolicyCheckpoint): void {
    this.ensureWorkerOrFallback();
    this.post({
      type: "LOAD_CHECKPOINT",
      sessionId: this.currentSessionId,
      checkpoint,
    });
  }

  resetWeights(seed = 42): void {
    this.ensureWorkerOrFallback();
    this.post({
      type: "RESET_WEIGHTS",
      sessionId: this.currentSessionId,
      seed,
    });
  }

  evaluateBatch(episodes = 10): void {
    this.ensureWorkerOrFallback();
    this.post({
      type: "EVALUATE_BATCH",
      sessionId: this.currentSessionId,
      episodes,
      deterministic: true,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.fallbackRunning = false;
    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.fallbackTrainer = null;
  }
}
