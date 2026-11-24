import type { PlanetId } from "../config/planets";
import type { MissionMode } from "../sim/FlightController";
import type { PolicyCheckpoint } from "./NeuralNetwork";
import { type EvalBatchSummary, PPOTrainer, type TrainingMetrics } from "./PPOTrainer";
import type { WorkerInboundMessage, WorkerOutboundMessage } from "./ppoWorker";

export interface PPOWorkerCallbacks {
  onProgress?: (
    metrics: TrainingMetrics,
    checkpoint: PolicyCheckpoint,
    historyTail: TrainingMetrics[],
    running: boolean
  ) => void;
  onPaused?: (metrics: TrainingMetrics, checkpoint: PolicyCheckpoint) => void;
  onReady?: (metrics: TrainingMetrics, checkpoint: PolicyCheckpoint) => void;
  onEvalResult?: (summary: EvalBatchSummary) => void;
  onError?: (message: string) => void;
}

/**
 * Main-thread bridge for the PPO training Web Worker (`ppoWorker.ts`),
 * with graceful async fallback if a constrained runtime disallows module Workers.
 */
export class PPOWorkerClient {
  private worker: Worker | null = null;
  private fallbackTrainer: PPOTrainer | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackRunning = false;
  private callbacks: PPOWorkerCallbacks;
  private disposed = false;

  constructor(callbacks: PPOWorkerCallbacks) {
    this.callbacks = callbacks;
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
    switch (msg.type) {
      case "READY":
        this.callbacks.onReady?.(msg.metrics, msg.checkpoint);
        break;
      case "TRAINING_PROGRESS":
        this.callbacks.onProgress?.(
          msg.metrics,
          msg.checkpoint,
          msg.historyTail,
          msg.running
        );
        break;
      case "PAUSED":
        this.callbacks.onPaused?.(msg.metrics, msg.checkpoint);
        break;
      case "EVAL_RESULT":
        this.callbacks.onEvalResult?.(msg.summary);
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
    if (!this.fallbackTrainer) {
      return;
    }
    const t = this.fallbackTrainer;
    switch (msg.type) {
      case "INIT":
        t.setEnvConfig(msg.planetId, msg.missionMode, msg.randomizeSpawn);
        t.setLearningRate(msg.learningRate);
        this.callbacks.onReady?.(t.getLastMetrics(), t.exportCheckpoint());
        break;
      case "START_TURBO_TRAIN": {
        t.setEnvConfig(msg.planetId, msg.missionMode, msg.randomizeSpawn);
        t.setLearningRate(msg.learningRate);
        this.fallbackRunning = true;
        const tick = () => {
          if (!this.fallbackRunning || this.disposed) {
            return;
          }
          const metrics = t.trainOneUpdate();
          this.callbacks.onProgress?.(
            metrics,
            t.exportCheckpoint(),
            t.getHistory().slice(-60),
            true
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
        this.callbacks.onPaused?.(t.getLastMetrics(), t.exportCheckpoint());
        break;
      case "WARM_START": {
        const metrics = t.warmStartFromGuidance(msg.episodes ?? 12, msg.epochs ?? 8);
        this.callbacks.onProgress?.(
          metrics,
          t.exportCheckpoint(),
          t.getHistory().slice(-60),
          this.fallbackRunning
        );
        break;
      }
      case "SYNC_WEIGHTS":
      case "LOAD_CHECKPOINT":
        t.loadCheckpoint(msg.checkpoint);
        this.callbacks.onReady?.(t.getLastMetrics(), t.exportCheckpoint());
        break;
      case "RESET_WEIGHTS":
        this.fallbackRunning = false;
        t.resetWeights(msg.seed ?? 42);
        this.callbacks.onReady?.(t.getLastMetrics(), t.exportCheckpoint());
        break;
      case "EVALUATE_BATCH":
        this.callbacks.onEvalResult?.(
          t.evaluateBatch(msg.episodes ?? 10, msg.deterministic ?? true)
        );
        break;
    }
  }

  init(
    planetId: PlanetId,
    missionMode: MissionMode,
    randomizeSpawn: boolean,
    learningRate: number
  ): void {
    this.ensureWorkerOrFallback(planetId, missionMode, randomizeSpawn, learningRate);
    this.post({ type: "INIT", planetId, missionMode, randomizeSpawn, learningRate });
  }

  startTurboTrain(
    planetId: PlanetId,
    missionMode: MissionMode,
    randomizeSpawn: boolean,
    learningRate: number,
    maxUpdates?: number
  ): void {
    this.ensureWorkerOrFallback(planetId, missionMode, randomizeSpawn, learningRate);
    this.post({
      type: "START_TURBO_TRAIN",
      planetId,
      missionMode,
      randomizeSpawn,
      learningRate,
      maxUpdates,
    });
  }

  pause(): void {
    if (!this.worker && !this.fallbackTrainer) {
      return;
    }
    this.post({ type: "PAUSE_TRAIN" });
  }

  warmStart(episodes = 12, epochs = 8): void {
    this.ensureWorkerOrFallback();
    this.post({ type: "WARM_START", episodes, epochs });
  }

  syncWeights(checkpoint: PolicyCheckpoint): void {
    this.ensureWorkerOrFallback();
    this.post({ type: "SYNC_WEIGHTS", checkpoint });
  }

  loadCheckpoint(checkpoint: PolicyCheckpoint): void {
    this.ensureWorkerOrFallback();
    this.post({ type: "LOAD_CHECKPOINT", checkpoint });
  }

  resetWeights(seed = 42): void {
    this.ensureWorkerOrFallback();
    this.post({ type: "RESET_WEIGHTS", seed });
  }

  evaluateBatch(episodes = 10): void {
    this.ensureWorkerOrFallback();
    this.post({ type: "EVALUATE_BATCH", episodes, deterministic: true });
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
