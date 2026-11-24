import {
  ActorCriticMLP,
  type PolicyCheckpoint,
} from "./NeuralNetwork";
import { SeededPRNG } from "./prng";
import {
  ACTION_DIM,
  OBS_DIM,
  RLEnvironment,
  type RLEnvConfig,
} from "./RLEnvironment";

export interface PPOConfig {
  gamma: number;
  gaeLambda: number;
  clipRange: number;
  learningRate: number;
  epochs: number;
  miniBatchSize: number;
  rolloutSteps: number;
  valueCoef: number;
  entropyCoef: number;
  maxGradNorm: number;
  targetKL: number;
  normalizeObs: boolean;
}

export interface TrainingMetrics {
  readonly updateIndex: number;
  readonly episodesCompleted: number;
  readonly totalSteps: number;
  readonly stepsPerSec: number;
  readonly lastEpisodeReturn: number;
  readonly rollingMeanReturn: number;
  readonly landingSuccessRatePct: number;
  readonly crashRatePct: number;
  readonly meanTouchdownVy: number | null;
  readonly policyLoss: number;
  readonly valueLoss: number;
  readonly entropy: number;
  readonly approxKL: number;
  readonly clipFraction: number;
}

export interface EvalBatchSummary {
  readonly episodes: number;
  readonly meanReturn: number;
  readonly successRatePct: number;
  readonly hardLandingRatePct: number;
  readonly crashRatePct: number;
  readonly meanTouchdownVy: number | null;
}

const DEFAULT_PPO_CONFIG: PPOConfig = {
  gamma: 0.99,
  gaeLambda: 0.95,
  clipRange: 0.2,
  learningRate: 6e-4,
  epochs: 6,
  miniBatchSize: 64,
  rolloutSteps: 512,
  valueCoef: 0.5,
  entropyCoef: 0.01,
  maxGradNorm: 0.5,
  targetKL: 0.03,
  normalizeObs: false,
};

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Fixed-capacity flat TypedArray rollout buffer with GAE computation.
 */
export class RolloutBuffer {
  public readonly capacity: number;
  public readonly obs: Float32Array;
  public readonly actions: Float32Array;
  public readonly logProbs: Float32Array;
  public readonly rewards: Float32Array;
  public readonly values: Float32Array;
  public readonly dones: Uint8Array;
  public readonly advantages: Float32Array;
  public readonly returns: Float32Array;
  public size = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.obs = new Float32Array(capacity * OBS_DIM);
    this.actions = new Float32Array(capacity * ACTION_DIM);
    this.logProbs = new Float32Array(capacity);
    this.rewards = new Float32Array(capacity);
    this.values = new Float32Array(capacity);
    this.dones = new Uint8Array(capacity);
    this.advantages = new Float32Array(capacity);
    this.returns = new Float32Array(capacity);
  }

  clear(): void {
    this.size = 0;
  }

  add(
    obs: ArrayLike<number>,
    action: ArrayLike<number>,
    logProb: number,
    reward: number,
    value: number,
    done: boolean
  ): boolean {
    if (this.size >= this.capacity) {
      return false;
    }
    const oOff = this.size * OBS_DIM;
    for (let i = 0; i < OBS_DIM; i++) {
      this.obs[oOff + i] = obs[i];
    }
    const aOff = this.size * ACTION_DIM;
    for (let i = 0; i < ACTION_DIM; i++) {
      this.actions[aOff + i] = action[i];
    }
    this.logProbs[this.size] = logProb;
    this.rewards[this.size] = reward;
    this.values[this.size] = value;
    this.dones[this.size] = done ? 1 : 0;
    this.size += 1;
    return true;
  }

  computeGAE(lastValue: number, lastDone: boolean, gamma: number, gaeLambda: number): void {
    let gae = 0;
    for (let t = this.size - 1; t >= 0; t--) {
      const nextNonTerminal = t === this.size - 1 ? (lastDone ? 0 : 1) : 1 - this.dones[t];
      const nextValue = t === this.size - 1 ? lastValue : this.values[t + 1];
      const delta = this.rewards[t] + gamma * nextValue * nextNonTerminal - this.values[t];
      gae = delta + gamma * gaeLambda * nextNonTerminal * gae;
      this.advantages[t] = gae;
      this.returns[t] = gae + this.values[t];
    }
  }
}

interface EpisodeStatsRecord {
  returnVal: number;
  success: boolean;
  crashed: boolean;
  touchdownVy: number | null;
}

/**
 * Pure TypeScript Continuous-Control Proximal Policy Optimization (PPO) Trainer.
 * Supports headless turbo rollouts, external 3D visual transitions, GAE, KL early-stopping,
 * optional behavioral cloning warm-start, deterministic batch evaluation, and checkpoints.
 */
export class PPOTrainer {
  public config: PPOConfig;
  public env: RLEnvironment;
  public policy: ActorCriticMLP;
  private prng: SeededPRNG;
  private buffer: RolloutBuffer;

  public updateIndex = 0;
  public episodesCompleted = 0;
  public totalSteps = 0;
  private currentEpReturn = 0;
  private currentObs = new Float32Array(OBS_DIM);
  private normedObs = new Float32Array(OBS_DIM);
  private envInitialized = false;

  private readonly recentEpisodes: EpisodeStatsRecord[] = [];
  private readonly metricsHistory: TrainingMetrics[] = [];
  private lastMetrics: TrainingMetrics;

  constructor(
    envConfig: RLEnvConfig,
    ppoConfig: Partial<PPOConfig> = {},
    seed = 42
  ) {
    this.config = { ...DEFAULT_PPO_CONFIG, ...ppoConfig };
    this.prng = new SeededPRNG(seed);
    this.env = new RLEnvironment(envConfig, seed + 101);
    this.policy = new ActorCriticMLP({ obsDim: OBS_DIM, hidden1: 64, hidden2: 64, actionDim: ACTION_DIM }, seed);
    this.buffer = new RolloutBuffer(this.config.rolloutSteps);

    this.lastMetrics = {
      updateIndex: 0,
      episodesCompleted: 0,
      totalSteps: 0,
      stepsPerSec: 0,
      lastEpisodeReturn: 0,
      rollingMeanReturn: 0,
      landingSuccessRatePct: 0,
      crashRatePct: 0,
      meanTouchdownVy: null,
      policyLoss: 0,
      valueLoss: 0,
      entropy: 0,
      approxKL: 0,
      clipFraction: 0,
    };
  }

  private normalizeObsIfEnabled(raw: Float32Array, updateStats: boolean, out = this.normedObs): Float32Array {
    if (!this.config.normalizeObs) {
      out.set(raw);
      return out;
    }
    if (updateStats) {
      this.policy.obsStats.update(raw);
    }
    return this.policy.obsStats.normalizeInto(raw, out, 5.0);
  }

  setLearningRate(lr: number): void {
    this.config.learningRate = clamp(lr, 1e-5, 1e-2);
  }

  setEnvConfig(planetId: RLEnvConfig["planetId"], missionMode: RLEnvConfig["missionMode"], randomizeSpawn: boolean): void {
    this.env.setPlanetAndMission(planetId, missionMode, randomizeSpawn);
    this.envInitialized = false;
  }

  resetWeights(seed = this.prng.initialSeed): void {
    this.prng = new SeededPRNG(seed);
    this.policy = new ActorCriticMLP(this.policy.arch, seed);
    this.buffer.clear();
    this.updateIndex = 0;
    this.episodesCompleted = 0;
    this.totalSteps = 0;
    this.currentEpReturn = 0;
    this.envInitialized = false;
    this.recentEpisodes.length = 0;
    this.metricsHistory.length = 0;
    this.lastMetrics = {
      ...this.lastMetrics,
      updateIndex: 0,
      episodesCompleted: 0,
      totalSteps: 0,
      stepsPerSec: 0,
      lastEpisodeReturn: 0,
      rollingMeanReturn: 0,
      landingSuccessRatePct: 0,
      crashRatePct: 0,
      meanTouchdownVy: null,
      policyLoss: 0,
      valueLoss: 0,
      entropy: 0,
      approxKL: 0,
      clipFraction: 0,
    };
  }

  private recordEpisodeOutcome(
    epReturn: number,
    success: boolean,
    crashed: boolean,
    touchdownVy: number | null
  ): void {
    this.episodesCompleted += 1;
    this.recentEpisodes.push({ returnVal: epReturn, success, crashed, touchdownVy });
    if (this.recentEpisodes.length > 20) {
      this.recentEpisodes.shift();
    }
  }

  /** Collects `rolloutSteps` in headless RLEnvironment and executes one PPO update. */
  trainOneUpdate(): TrainingMetrics {
    const startMs = performance.now();
    if (!this.envInitialized) {
      this.env.reset(this.currentObs);
      this.currentEpReturn = 0;
      this.envInitialized = true;
    }

    this.buffer.clear();
    const actionScratch = new Float32Array(ACTION_DIM);
    const nextRawObs = new Float32Array(OBS_DIM);
    let lastDone = false;

    for (let step = 0; step < this.config.rolloutSteps; step++) {
      const modelObs = this.normalizeObsIfEnabled(this.currentObs, true);
      const { action, logProb, value } = this.policy.sampleAction(
        modelObs,
        this.prng,
        false,
        actionScratch
      );

      const res = this.env.step(action, nextRawObs);
      this.buffer.add(modelObs, action, logProb, res.reward, value, res.done);
      this.currentEpReturn += res.reward;
      this.totalSteps += 1;
      lastDone = res.done;

      if (res.done) {
        const tel = res.telemetry;
        const success =
          tel.missionMode === "landing"
            ? tel.phase === "TOUCHDOWN" && tel.landingVerdict === "NOMINAL LANDING"
            : tel.phase === "COMPLETE";
        const crashed = tel.phase === "CRASHED";
        this.recordEpisodeOutcome(
          this.currentEpReturn,
          success,
          crashed,
          tel.touchdownVerticalSpeedMps
        );
        this.env.reset(this.currentObs);
        this.currentEpReturn = 0;
      } else {
        this.currentObs.set(nextRawObs);
      }
    }

    const lastNormObs = this.normalizeObsIfEnabled(this.currentObs, false);
    const lastVal = lastDone ? 0 : this.policy.forwardFast(lastNormObs).value;
    const elapsedSec = Math.max(1e-4, (performance.now() - startMs) / 1000);
    return this.runUpdateOnBuffer(lastVal, lastDone, this.config.rolloutSteps / elapsedSec);
  }

  /**
   * Feeds a live 3D transition into the PPO buffer; triggers an update automatically when full.
   */
  recordExternalTransition(
    obs: Float32Array,
    action: ArrayLike<number>,
    logProb: number,
    reward: number,
    value: number,
    done: boolean,
    episodeSummary?: {
      episodeReturn: number;
      success: boolean;
      crashed: boolean;
      touchdownVy: number | null;
    }
  ): TrainingMetrics | null {
    this.totalSteps += 1;
    this.buffer.add(obs, action, logProb, reward, value, done);
    if (done && episodeSummary) {
      this.recordEpisodeOutcome(
        episodeSummary.episodeReturn,
        episodeSummary.success,
        episodeSummary.crashed,
        episodeSummary.touchdownVy
      );
    }
    if (this.buffer.size >= this.buffer.capacity) {
      const lastVal = done ? 0 : value;
      return this.runUpdateOnBuffer(lastVal, done, 20);
    }
    return null;
  }

  /** Executes multi-epoch clipped PPO gradient updates on the populated RolloutBuffer. */
  runUpdateOnBuffer(
    lastValue: number,
    lastDone: boolean,
    measuredStepsPerSec = 0
  ): TrainingMetrics {
    const N = this.buffer.size;
    if (N < 8) {
      return this.lastMetrics;
    }

    this.buffer.computeGAE(lastValue, lastDone, this.config.gamma, this.config.gaeLambda);

    const indices = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      indices[i] = i;
    }

    const obsSlice = new Float32Array(OBS_DIM);
    const actSlice = new Float32Array(ACTION_DIM);
    const dMean = new Float32Array(ACTION_DIM);
    const dLogStd = new Float32Array(ACTION_DIM);

    let sumPolicyLoss = 0;
    let sumValueLoss = 0;
    let sumEntropy = 0;
    let sumKL = 0;
    let sumClipFrac = 0;
    let totalMinibatches = 0;
    let earlyStop = false;

    const batchSize = Math.min(this.config.miniBatchSize, N);

    for (let epoch = 0; epoch < this.config.epochs && !earlyStop; epoch++) {
      this.prng.shuffleInPlace(indices, N);

      for (let start = 0; start < N; start += batchSize) {
        const end = Math.min(N, start + batchSize);
        const mbCount = end - start;
        if (mbCount < 2) {
          continue;
        }

        // Standardize advantages per mini-batch
        let advMean = 0;
        for (let k = start; k < end; k++) {
          advMean += this.buffer.advantages[indices[k]];
        }
        advMean /= mbCount;
        let advVar = 0;
        for (let k = start; k < end; k++) {
          const d = this.buffer.advantages[indices[k]] - advMean;
          advVar += d * d;
        }
        const advStd = Math.sqrt(advVar / mbCount + 1e-8);

        this.policy.zeroGrad();
        let mbPolicyLoss = 0;
        let mbValueLoss = 0;
        let mbEntropy = 0;
        let mbKL = 0;
        let mbClips = 0;

        for (let k = start; k < end; k++) {
          const idx = indices[k];
          const oOff = idx * OBS_DIM;
          for (let d = 0; d < OBS_DIM; d++) {
            obsSlice[d] = this.buffer.obs[oOff + d];
          }
          const aOff = idx * ACTION_DIM;
          for (let d = 0; d < ACTION_DIM; d++) {
            actSlice[d] = this.buffer.actions[aOff + d];
          }

          const adv = (this.buffer.advantages[idx] - advMean) / advStd;
          const oldLogProb = this.buffer.logProbs[idx];
          const ret = this.buffer.returns[idx];

          const { logProb, value, entropy, mean } = this.policy.evaluateAction(obsSlice, actSlice);
          const logRatio = clamp(logProb - oldLogProb, -12, 12);
          const ratio = Math.exp(logRatio);

          // Unbiased Schulman approx KL: (ratio - 1) - logRatio
          mbKL += (ratio - 1) - logRatio;

          const unclipped = ratio * adv;
          const clippedRatio = clamp(
            ratio,
            1 - this.config.clipRange,
            1 + this.config.clipRange
          );
          const clipped = clippedRatio * adv;
          const isClipped = Math.abs(ratio - 1) > this.config.clipRange;
          if (isClipped) {
            mbClips += 1;
          }

          // Surrogate gradient wrt logProb:
          // Loss_pi = -min(ratio*adv, clippedRatio*adv)
          let dLossDLogProb = 0;
          if (unclipped <= clipped || !isClipped) {
            // Active branch is ratio * adv (or inside clip boundary)
            if (
              (adv >= 0 && ratio <= 1 + this.config.clipRange) ||
              (adv < 0 && ratio >= 1 - this.config.clipRange)
            ) {
              dLossDLogProb = -adv * ratio;
            }
          }
          mbPolicyLoss += -Math.min(unclipped, clipped);

          // Gaussian derivatives:
          // logProb = sum_i (-0.5*((a_i - mu_i)/std_i)^2 - logStd_i - c)
          // d(logProb)/d(mu_i) = (a_i - mu_i) / var_i
          // d(logProb)/d(logStd_i) = ((a_i - mu_i)^2 / var_i) - 1
          // d(entropy)/d(logStd_i) = 1
          for (let d = 0; d < ACTION_DIM; d++) {
            const ls = this.policy.logStd[d];
            const std = Math.exp(ls);
            const invVar = 1 / (std * std);
            const diff = actSlice[d] - mean[d];
            dMean[d] = dLossDLogProb * (diff * invVar);
            dLogStd[d] =
              dLossDLogProb * (diff * diff * invVar - 1.0) -
              this.config.entropyCoef * 1.0;
          }

          // Value loss: 0.5 * c1 * (value - ret)^2
          const valErr = value - ret;
          mbValueLoss += 0.5 * valErr * valErr;
          mbEntropy += entropy;

          this.policy.accumulateActorBackward(obsSlice, dMean, dLogStd);
          this.policy.accumulateCriticBackward(obsSlice, this.config.valueCoef * valErr);
        }

        const avgKL = mbKL / mbCount;
        sumPolicyLoss += mbPolicyLoss / mbCount;
        sumValueLoss += mbValueLoss / mbCount;
        sumEntropy += mbEntropy / mbCount;
        sumKL += avgKL;
        sumClipFrac += mbClips / mbCount;
        totalMinibatches += 1;

        this.policy.stepAdam(
          this.config.learningRate,
          this.config.maxGradNorm,
          1.0 / mbCount
        );

        if (this.config.targetKL > 0 && avgKL > 1.5 * this.config.targetKL) {
          earlyStop = true;
          break;
        }
      }
    }

    this.buffer.clear();
    this.updateIndex += 1;

    const epCount = this.recentEpisodes.length;
    let meanReturn = 0;
    let successes = 0;
    let crashes = 0;
    let vySum = 0;
    let vyCount = 0;
    for (const ep of this.recentEpisodes) {
      meanReturn += ep.returnVal;
      if (ep.success) {
        successes += 1;
      }
      if (ep.crashed) {
        crashes += 1;
      }
      if (ep.touchdownVy !== null) {
        vySum += ep.touchdownVy;
        vyCount += 1;
      }
    }

    const denom = Math.max(1, totalMinibatches);
    this.lastMetrics = {
      updateIndex: this.updateIndex,
      episodesCompleted: this.episodesCompleted,
      totalSteps: this.totalSteps,
      stepsPerSec: Math.round(measuredStepsPerSec),
      lastEpisodeReturn:
        epCount > 0 ? this.recentEpisodes[epCount - 1].returnVal : 0,
      rollingMeanReturn: epCount > 0 ? meanReturn / epCount : 0,
      landingSuccessRatePct: epCount > 0 ? (successes / epCount) * 100 : 0,
      crashRatePct: epCount > 0 ? (crashes / epCount) * 100 : 0,
      meanTouchdownVy: vyCount > 0 ? vySum / vyCount : null,
      policyLoss: sumPolicyLoss / denom,
      valueLoss: sumValueLoss / denom,
      entropy: sumEntropy / denom,
      approxKL: sumKL / denom,
      clipFraction: sumClipFrac / denom,
    };
    this.metricsHistory.push(this.lastMetrics);
    if (this.metricsHistory.length > 500) {
      this.metricsHistory.shift();
    }
    return this.lastMetrics;
  }

  /**
   * Optional Behavioral Cloning warm-start: collects classical guidance rollouts and supervises
   * the actor/critic before PPO fine-tuning. Never invoked unless explicitly requested by user.
   */
  warmStartFromGuidance(episodes = 10, epochs = 8): TrainingMetrics {
    const samplesObs: Float32Array[] = [];
    const samplesAct: Float32Array[] = [];
    const samplesRet: number[] = [];

    const evalEnv = new RLEnvironment(this.env.config, this.prng.initialSeed + 777);
    const obsBuf = new Float32Array(OBS_DIM);
    const nextBuf = new Float32Array(OBS_DIM);

    for (let ep = 0; ep < episodes; ep++) {
      evalEnv.reset(obsBuf);
      const epObs: Float32Array[] = [];
      const epAct: Float32Array[] = [];
      const epRew: number[] = [];

      for (let t = 0; t < evalEnv.config.maxSteps; t++) {
        const guidance = evalEnv.controller.computeClassicalGuidanceAction();
        const rawAct = new Float32Array([
          clamp(guidance.throttle * 2 - 1, -1, 1),
          clamp(guidance.pitchCmd, -1, 1),
          clamp(guidance.yawCmd, -1, 1),
        ]);
        epObs.push(new Float32Array(obsBuf));
        epAct.push(rawAct);
        const res = evalEnv.step(rawAct, nextBuf);
        epRew.push(res.reward);
        obsBuf.set(nextBuf);
        if (res.done) {
          break;
        }
      }

      let ret = 0;
      for (let t = epObs.length - 1; t >= 0; t--) {
        ret = epRew[t] + this.config.gamma * ret;
        samplesObs.push(epObs[t]);
        samplesAct.push(epAct[t]);
        samplesRet.push(ret);
      }
    }

    const N = samplesObs.length;
    if (N > 0) {
      const idx = new Int32Array(N);
      for (let i = 0; i < N; i++) {
        idx[i] = i;
      }
      const dMean = new Float32Array(ACTION_DIM);
      const zeroLogStd = new Float32Array(ACTION_DIM);
      const mbSize = 64;

      for (let e = 0; e < epochs; e++) {
        this.prng.shuffleInPlace(idx, N);
        for (let s = 0; s < N; s += mbSize) {
          const end = Math.min(N, s + mbSize);
          const count = end - s;
          this.policy.zeroGrad();
          for (let k = s; k < end; k++) {
            const j = idx[k];
            const { mean, value } = this.policy.forwardFast(samplesObs[j]);
            for (let a = 0; a < ACTION_DIM; a++) {
              dMean[a] = mean[a] - samplesAct[j][a];
            }
            this.policy.accumulateActorBackward(samplesObs[j], dMean, zeroLogStd);
            this.policy.accumulateCriticBackward(samplesObs[j], 0.25 * (value - samplesRet[j]));
          }
          this.policy.stepAdam(Math.max(this.config.learningRate, 1e-3), 0.5, 1 / count);
        }
      }
    }

    return this.lastMetrics;
  }

  /** Evaluates the current policy over N deterministic (or stochastic) episodes. */
  evaluateBatch(episodes = 10, deterministic = true, seedOffset = 9001): EvalBatchSummary {
    const evalEnv = new RLEnvironment(this.env.config, this.prng.initialSeed + seedOffset);
    const evalPrng = new SeededPRNG(this.prng.initialSeed + seedOffset + 17);
    const obsBuf = new Float32Array(OBS_DIM);
    const nextObs = new Float32Array(OBS_DIM);
    const actScratch = new Float32Array(ACTION_DIM);

    let totalRet = 0;
    let successes = 0;
    let hardLandings = 0;
    let crashes = 0;
    let vySum = 0;
    let vyCount = 0;

    for (let ep = 0; ep < episodes; ep++) {
      evalEnv.reset(obsBuf);
      let epRet = 0;
      let lastTel = evalEnv.controller.getTelemetry();
      for (let t = 0; t < evalEnv.config.maxSteps; t++) {
        const modelObs = this.normalizeObsIfEnabled(obsBuf, false);
        const { action } = this.policy.sampleAction(modelObs, evalPrng, deterministic, actScratch);
        const res = evalEnv.step(action, nextObs);
        epRet += res.reward;
        lastTel = res.telemetry;
        obsBuf.set(nextObs);
        if (res.done) {
          break;
        }
      }
      totalRet += epRet;
      if (lastTel.phase === "TOUCHDOWN") {
        if (lastTel.landingVerdict === "NOMINAL LANDING") {
          successes += 1;
        } else if (lastTel.landingVerdict === "HARD LANDING") {
          hardLandings += 1;
        }
      } else if (lastTel.phase === "COMPLETE") {
        successes += 1;
      } else if (lastTel.phase === "CRASHED") {
        crashes += 1;
      }
      if (lastTel.touchdownVerticalSpeedMps !== null) {
        vySum += lastTel.touchdownVerticalSpeedMps;
        vyCount += 1;
      }
    }

    return {
      episodes,
      meanReturn: totalRet / Math.max(1, episodes),
      successRatePct: (successes / Math.max(1, episodes)) * 100,
      hardLandingRatePct: (hardLandings / Math.max(1, episodes)) * 100,
      crashRatePct: (crashes / Math.max(1, episodes)) * 100,
      meanTouchdownVy: vyCount > 0 ? vySum / vyCount : null,
    };
  }

  getLastMetrics(): TrainingMetrics {
    return this.lastMetrics;
  }

  getHistory(): readonly TrainingMetrics[] {
    return this.metricsHistory;
  }

  exportCheckpoint(): PolicyCheckpoint {
    return this.policy.serialize({
      planet: this.env.config.planetId,
      mission: this.env.config.missionMode,
      totalSteps: this.totalSteps,
      episodesCompleted: this.episodesCompleted,
      seed: this.prng.initialSeed,
    });
  }

  loadCheckpoint(payload: PolicyCheckpoint | string): PolicyCheckpoint {
    const { network, checkpoint } = ActorCriticMLP.deserialize(payload);
    this.policy = network;
    this.totalSteps = checkpoint.totalSteps ?? 0;
    this.episodesCompleted = checkpoint.episodesCompleted ?? 0;
    this.buffer.clear();
    this.envInitialized = false;
    return checkpoint;
  }
}
