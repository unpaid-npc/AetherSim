import { SeededPRNG } from "./prng";

export interface NetworkArchitecture {
  readonly obsDim: number;
  readonly hidden1: number;
  readonly hidden2: number;
  readonly actionDim: number;
  readonly activation: "tanh";
}

export interface ActivationSnapshot {
  readonly obs: Float32Array;
  readonly mean: Float32Array;
  readonly logStd: Float32Array;
  readonly std: Float32Array;
  readonly value: number;
  readonly actorHidden1: Float32Array;
  readonly actorHidden2: Float32Array;
  readonly criticHidden1: Float32Array;
  readonly criticHidden2: Float32Array;
}

export interface RunningObsStats {
  readonly count: number;
  readonly mean: number[];
  readonly var: number[];
}

export interface PolicyCheckpoint {
  readonly schemaVersion: 1;
  readonly architecture: NetworkArchitecture;
  readonly weights: {
    readonly actorW1: number[];
    readonly actorB1: number[];
    readonly actorW2: number[];
    readonly actorB2: number[];
    readonly actorW3: number[];
    readonly actorB3: number[];
    readonly criticW1: number[];
    readonly criticB1: number[];
    readonly criticW2: number[];
    readonly criticB2: number[];
    readonly criticW3: number[];
    readonly criticB3: number[];
  };
  readonly logStd: number[];
  readonly obsNormStats: RunningObsStats;
  readonly planet: string;
  readonly mission: string;
  readonly totalSteps: number;
  readonly episodesCompleted: number;
  readonly seed: number;
}

export interface CheckpointMetadata {
  planet: string;
  mission: string;
  totalSteps: number;
  episodesCompleted: number;
  seed: number;
}

const LOG_STD_MIN = -2.5;
const LOG_STD_MAX = 0.5;
const LOG_SQRT_2PI = 0.5 * Math.log(2.0 * Math.PI);

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Generates an orthogonal matrix of shape [rows, cols] scaled by `gain` using
 * modified Gram-Schmidt QR decomposition on Gaussian entries.
 */
function orthogonalInit(
  rows: number,
  cols: number,
  gain: number,
  prng: SeededPRNG
): Float32Array {
  return orthogonalInitExact(rows, cols, gain, prng);
}

function orthogonalInitExact(
  rows: number,
  cols: number,
  gain: number,
  prng: SeededPRNG
): Float32Array {
  const out = new Float32Array(rows * cols);
  if (rows >= cols) {
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        out[r * cols + c] = prng.gaussian(0, 1);
      }
      for (let prev = 0; prev < c; prev++) {
        let dot = 0;
        for (let r = 0; r < rows; r++) {
          dot += out[r * cols + c] * out[r * cols + prev];
        }
        for (let r = 0; r < rows; r++) {
          out[r * cols + c] -= dot * out[r * cols + prev];
        }
      }
      let normSq = 0;
      for (let r = 0; r < rows; r++) {
        const v = out[r * cols + c];
        normSq += v * v;
      }
      const inv = normSq > 1e-12 ? 1 / Math.sqrt(normSq) : 1;
      for (let r = 0; r < rows; r++) {
        out[r * cols + c] *= inv;
      }
    }
  } else {
    // Rows orthonormal
    for (let r = 0; r < rows; r++) {
      const rowOff = r * cols;
      for (let c = 0; c < cols; c++) {
        out[rowOff + c] = prng.gaussian(0, 1);
      }
      for (let prev = 0; prev < r; prev++) {
        const prevOff = prev * cols;
        let dot = 0;
        for (let c = 0; c < cols; c++) {
          dot += out[rowOff + c] * out[prevOff + c];
        }
        for (let c = 0; c < cols; c++) {
          out[rowOff + c] -= dot * out[prevOff + c];
        }
      }
      let normSq = 0;
      for (let c = 0; c < cols; c++) {
        const v = out[rowOff + c];
        normSq += v * v;
      }
      const inv = normSq > 1e-12 ? 1 / Math.sqrt(normSq) : 1;
      for (let c = 0; c < cols; c++) {
        out[rowOff + c] *= inv;
      }
    }
  }
  for (let i = 0; i < out.length; i++) {
    out[i] *= gain;
  }
  return out;
}

/**
 * Tracks online per-dimension mean & variance via Welford's parallel algorithm.
 */
export class RunningMeanStd {
  public count: number;
  public readonly mean: Float32Array;
  public readonly variance: Float32Array;
  private readonly m2: Float32Array;

  constructor(dim: number, stats?: RunningObsStats) {
    this.mean = new Float32Array(dim);
    this.variance = new Float32Array(dim);
    this.m2 = new Float32Array(dim);
    if (stats && stats.mean.length === dim && stats.var.length === dim) {
      this.count = Math.max(1e-4, stats.count);
      for (let i = 0; i < dim; i++) {
        this.mean[i] = stats.mean[i];
        this.variance[i] = Math.max(1e-6, stats.var[i]);
        this.m2[i] = this.variance[i] * this.count;
      }
    } else {
      this.count = 1e-4;
      this.variance.fill(1.0);
    }
  }

  update(sample: ArrayLike<number>): void {
    this.count += 1;
    const invN = 1 / this.count;
    for (let i = 0; i < this.mean.length; i++) {
      const x = sample[i];
      const delta = x - this.mean[i];
      this.mean[i] += delta * invN;
      const delta2 = x - this.mean[i];
      this.m2[i] += delta * delta2;
      this.variance[i] = Math.max(1e-6, this.m2[i] * invN);
    }
  }

  normalizeInto(raw: ArrayLike<number>, out: Float32Array, clip = 5.0): Float32Array {
    for (let i = 0; i < this.mean.length; i++) {
      const std = Math.sqrt(this.variance[i] + 1e-8);
      out[i] = clamp((raw[i] - this.mean[i]) / std, -clip, clip);
    }
    return out;
  }

  toJSON(): RunningObsStats {
    return {
      count: this.count,
      mean: Array.from(this.mean),
      var: Array.from(this.variance),
    };
  }
}

interface DenseLayer {
  readonly inDim: number;
  readonly outDim: number;
  readonly w: Float32Array;
  readonly b: Float32Array;
  readonly gw: Float32Array;
  readonly gb: Float32Array;
  readonly mw: Float32Array;
  readonly vw: Float32Array;
  readonly mb: Float32Array;
  readonly vb: Float32Array;
}

function makeLayer(
  inDim: number,
  outDim: number,
  gain: number,
  prng: SeededPRNG
): DenseLayer {
  return {
    inDim,
    outDim,
    w: orthogonalInit(inDim, outDim, gain, prng),
    b: new Float32Array(outDim),
    gw: new Float32Array(inDim * outDim),
    gb: new Float32Array(outDim),
    mw: new Float32Array(inDim * outDim),
    vw: new Float32Array(inDim * outDim),
    mb: new Float32Array(outDim),
    vb: new Float32Array(outDim),
  };
}

function forwardLayerTanh(
  layer: DenseLayer,
  input: Float32Array,
  out: Float32Array
): void {
  const { inDim, outDim, w, b } = layer;
  for (let j = 0; j < outDim; j++) {
    let sum = b[j];
    for (let i = 0; i < inDim; i++) {
      sum += input[i] * w[i * outDim + j];
    }
    out[j] = Math.tanh(sum);
  }
}

function forwardLayerLinear(
  layer: DenseLayer,
  input: Float32Array,
  out: Float32Array
): void {
  const { inDim, outDim, w, b } = layer;
  for (let j = 0; j < outDim; j++) {
    let sum = b[j];
    for (let i = 0; i < inDim; i++) {
      sum += input[i] * w[i * outDim + j];
    }
    out[j] = sum;
  }
}

function backwardLayer(
  layer: DenseLayer,
  input: Float32Array,
  dOut: Float32Array,
  dIn: Float32Array | null
): void {
  const { inDim, outDim, w, gw, gb } = layer;
  if (dIn) {
    dIn.fill(0);
  }
  for (let j = 0; j < outDim; j++) {
    const dj = dOut[j];
    gb[j] += dj;
    for (let i = 0; i < inDim; i++) {
      const idx = i * outDim + j;
      gw[idx] += input[i] * dj;
      if (dIn) {
        dIn[i] += w[idx] * dj;
      }
    }
  }
}

function backwardTanhInPlace(
  grad: Float32Array,
  postActivation: Float32Array
): void {
  for (let i = 0; i < grad.length; i++) {
    const a = postActivation[i];
    grad[i] *= 1.0 - a * a;
  }
}

/**
 * Pure TypeScript Continuous-Control Actor-Critic MLP using Float32Array weights,
 * orthogonal initialization, exact analytical backpropagation, and Adam + gradient clipping.
 */
export class ActorCriticMLP {
  public readonly arch: NetworkArchitecture;

  private readonly actorL1: DenseLayer;
  private readonly actorL2: DenseLayer;
  private readonly actorOut: DenseLayer;

  private readonly criticL1: DenseLayer;
  private readonly criticL2: DenseLayer;
  private readonly criticOut: DenseLayer;

  public readonly logStd: Float32Array;
  private readonly gLogStd: Float32Array;
  private readonly mLogStd: Float32Array;
  private readonly vLogStd: Float32Array;

  public readonly obsStats: RunningMeanStd;
  private adamStep = 0;

  // Allocation-free scratch buffers for hot loops
  private readonly aH1: Float32Array;
  private readonly aH2: Float32Array;
  private readonly aMean: Float32Array;
  private readonly cH1: Float32Array;
  private readonly cH2: Float32Array;
  private readonly cVal: Float32Array;

  private readonly dOutActor: Float32Array;
  private readonly dH2Actor: Float32Array;
  private readonly dH1Actor: Float32Array;
  private readonly dOutCritic: Float32Array;
  private readonly dH2Critic: Float32Array;
  private readonly dH1Critic: Float32Array;
  private readonly allLayers: DenseLayer[];

  constructor(
    arch: Partial<NetworkArchitecture> = {},
    seed = 42,
    obsStats?: RunningObsStats
  ) {
    this.arch = {
      obsDim: arch.obsDim ?? 14,
      hidden1: arch.hidden1 ?? 64,
      hidden2: arch.hidden2 ?? 64,
      actionDim: arch.actionDim ?? 3,
      activation: "tanh",
    };

    const prng = new SeededPRNG(seed);
    const { obsDim, hidden1, hidden2, actionDim } = this.arch;

    this.actorL1 = makeLayer(obsDim, hidden1, Math.SQRT2, prng);
    this.actorL2 = makeLayer(hidden1, hidden2, Math.SQRT2, prng);
    this.actorOut = makeLayer(hidden2, actionDim, 0.01, prng);

    this.criticL1 = makeLayer(obsDim, hidden1, Math.SQRT2, prng);
    this.criticL2 = makeLayer(hidden1, hidden2, Math.SQRT2, prng);
    this.criticOut = makeLayer(hidden2, 1, 1.0, prng);

    this.allLayers = [
      this.actorL1,
      this.actorL2,
      this.actorOut,
      this.criticL1,
      this.criticL2,
      this.criticOut,
    ];

    this.logStd = new Float32Array(actionDim).fill(-0.35);
    this.gLogStd = new Float32Array(actionDim);
    this.mLogStd = new Float32Array(actionDim);
    this.vLogStd = new Float32Array(actionDim);

    this.obsStats = new RunningMeanStd(obsDim, obsStats);

    this.aH1 = new Float32Array(hidden1);
    this.aH2 = new Float32Array(hidden2);
    this.aMean = new Float32Array(actionDim);
    this.cH1 = new Float32Array(hidden1);
    this.cH2 = new Float32Array(hidden2);
    this.cVal = new Float32Array(1);

    this.dOutActor = new Float32Array(actionDim);
    this.dH2Actor = new Float32Array(hidden2);
    this.dH1Actor = new Float32Array(hidden1);
    this.dOutCritic = new Float32Array(1);
    this.dH2Critic = new Float32Array(hidden2);
    this.dH1Critic = new Float32Array(hidden1);
  }

  /** Fast allocation-free forward pass into internal scratch buffers. */
  forwardFast(obs: Float32Array): { mean: Float32Array; value: number } {
    forwardLayerTanh(this.actorL1, obs, this.aH1);
    forwardLayerTanh(this.actorL2, this.aH1, this.aH2);
    forwardLayerLinear(this.actorOut, this.aH2, this.aMean);

    forwardLayerTanh(this.criticL1, obs, this.cH1);
    forwardLayerTanh(this.criticL2, this.cH1, this.cH2);
    forwardLayerLinear(this.criticOut, this.cH2, this.cVal);

    return { mean: this.aMean, value: this.cVal[0] };
  }

  /** Forward pass returning defensive copies of all layer activations for UI/visualization. */
  forwardWithActivations(obs: Float32Array): ActivationSnapshot {
    this.forwardFast(obs);
    const std = new Float32Array(this.arch.actionDim);
    for (let i = 0; i < std.length; i++) {
      std[i] = Math.exp(clamp(this.logStd[i], LOG_STD_MIN, LOG_STD_MAX));
    }
    return {
      obs: new Float32Array(obs),
      mean: new Float32Array(this.aMean),
      logStd: new Float32Array(this.logStd),
      std,
      value: this.cVal[0],
      actorHidden1: new Float32Array(this.aH1),
      actorHidden2: new Float32Array(this.aH2),
      criticHidden1: new Float32Array(this.cH1),
      criticHidden2: new Float32Array(this.cH2),
    };
  }

  /** Evaluates action log-probability and analytical entropy under current Gaussian policy. */
  sampleAction(
    obs: Float32Array,
    prng: SeededPRNG,
    deterministic = false,
    outAction?: Float32Array
  ): {
    action: Float32Array;
    logProb: number;
    value: number;
    entropy: number;
  } {
    const { mean, value } = this.forwardFast(obs);
    const act = outAction ?? new Float32Array(this.arch.actionDim);
    let logProb = 0;
    let entropy = 0;
    for (let i = 0; i < this.arch.actionDim; i++) {
      const ls = clamp(this.logStd[i], LOG_STD_MIN, LOG_STD_MAX);
      const std = Math.exp(ls);
      const sampled = deterministic ? mean[i] : mean[i] + std * prng.gaussian(0, 1);
      act[i] = sampled;
      const z = (sampled - mean[i]) / std;
      logProb += -0.5 * z * z - ls - LOG_SQRT_2PI;
      entropy += 0.5 + LOG_SQRT_2PI + ls;
    }
    return { action: act, logProb, value, entropy };
  }

  /** Evaluates log-prob, value, and entropy of an existing rollout action. */
  evaluateAction(
    obs: Float32Array,
    action: ArrayLike<number>
  ): { logProb: number; value: number; entropy: number; mean: Float32Array } {
    const { mean, value } = this.forwardFast(obs);
    let logProb = 0;
    let entropy = 0;
    for (let i = 0; i < this.arch.actionDim; i++) {
      const ls = clamp(this.logStd[i], LOG_STD_MIN, LOG_STD_MAX);
      const std = Math.exp(ls);
      const z = (action[i] - mean[i]) / std;
      logProb += -0.5 * z * z - ls - LOG_SQRT_2PI;
      entropy += 0.5 + LOG_SQRT_2PI + ls;
    }
    return { logProb, value, entropy, mean };
  }

  zeroGrad(): void {
    for (const l of this.allLayers) {
      l.gw.fill(0);
      l.gb.fill(0);
    }
    this.gLogStd.fill(0);
  }

  /**
   * Accumulates Actor parameter gradients given dLoss/dMean and dLoss/dLogStd.
   * Requires `forwardFast(obs)` (or `evaluateAction(obs, ...)`) to have just populated `aH1`/`aH2`.
   */
  accumulateActorBackward(
    obs: Float32Array,
    dLossDMean: ArrayLike<number>,
    dLossDLogStd: ArrayLike<number>
  ): void {
    for (let i = 0; i < this.arch.actionDim; i++) {
      this.dOutActor[i] = dLossDMean[i];
      this.gLogStd[i] += dLossDLogStd[i];
    }
    backwardLayer(this.actorOut, this.aH2, this.dOutActor, this.dH2Actor);
    backwardTanhInPlace(this.dH2Actor, this.aH2);
    backwardLayer(this.actorL2, this.aH1, this.dH2Actor, this.dH1Actor);
    backwardTanhInPlace(this.dH1Actor, this.aH1);
    backwardLayer(this.actorL1, obs, this.dH1Actor, null);
  }

  /**
   * Accumulates Critic parameter gradients given scalar dLoss/dValue.
   * Requires `forwardFast(obs)` to have just populated `cH1`/`cH2`.
   */
  accumulateCriticBackward(obs: Float32Array, dLossDValue: number): void {
    this.dOutCritic[0] = dLossDValue;
    backwardLayer(this.criticOut, this.cH2, this.dOutCritic, this.dH2Critic);
    backwardTanhInPlace(this.dH2Critic, this.cH2);
    backwardLayer(this.criticL2, this.cH1, this.dH2Critic, this.dH1Critic);
    backwardTanhInPlace(this.dH1Critic, this.cH1);
    backwardLayer(this.criticL1, obs, this.dH1Critic, null);
  }

  /** Applies global L2 gradient clipping and Adam update across all actor, critic, and logStd weights. */
  stepAdam(lr: number, maxGradNorm = 0.5, gradScale = 1.0): number {
    let normSq = 0;
    for (const l of this.allLayers) {
      for (let i = 0; i < l.gw.length; i++) {
        l.gw[i] *= gradScale;
        normSq += l.gw[i] * l.gw[i];
      }
      for (let i = 0; i < l.gb.length; i++) {
        l.gb[i] *= gradScale;
        normSq += l.gb[i] * l.gb[i];
      }
    }
    for (let i = 0; i < this.gLogStd.length; i++) {
      this.gLogStd[i] *= gradScale;
      normSq += this.gLogStd[i] * this.gLogStd[i];
    }

    const totalNorm = Math.sqrt(normSq);
    const clipCoef = totalNorm > maxGradNorm && totalNorm > 1e-12 ? maxGradNorm / totalNorm : 1.0;

    this.adamStep += 1;
    const beta1 = 0.9;
    const beta2 = 0.999;
    const eps = 1e-8;
    const bc1 = 1 - Math.pow(beta1, this.adamStep);
    const bc2 = 1 - Math.pow(beta2, this.adamStep);

    for (const l of this.allLayers) {
      for (let i = 0; i < l.w.length; i++) {
        const g = l.gw[i] * clipCoef;
        l.mw[i] = beta1 * l.mw[i] + (1 - beta1) * g;
        l.vw[i] = beta2 * l.vw[i] + (1 - beta2) * g * g;
        const mHat = l.mw[i] / bc1;
        const vHat = l.vw[i] / bc2;
        l.w[i] -= (lr * mHat) / (Math.sqrt(vHat) + eps);
      }
      for (let i = 0; i < l.b.length; i++) {
        const g = l.gb[i] * clipCoef;
        l.mb[i] = beta1 * l.mb[i] + (1 - beta1) * g;
        l.vb[i] = beta2 * l.vb[i] + (1 - beta2) * g * g;
        const mHat = l.mb[i] / bc1;
        const vHat = l.vb[i] / bc2;
        l.b[i] -= (lr * mHat) / (Math.sqrt(vHat) + eps);
      }
    }

    for (let i = 0; i < this.logStd.length; i++) {
      const g = this.gLogStd[i] * clipCoef;
      this.mLogStd[i] = beta1 * this.mLogStd[i] + (1 - beta1) * g;
      this.vLogStd[i] = beta2 * this.vLogStd[i] + (1 - beta2) * g * g;
      const mHat = this.mLogStd[i] / bc1;
      const vHat = this.vLogStd[i] / bc2;
      this.logStd[i] = clamp(
        this.logStd[i] - (lr * mHat) / (Math.sqrt(vHat) + eps),
        LOG_STD_MIN,
        LOG_STD_MAX
      );
    }

    return totalNorm;
  }

  /** Copies all weights, logStd, and obsStats from another network or checkpoint cleanly. */
  copyWeightsFrom(other: ActorCriticMLP): void {
    for (let k = 0; k < this.allLayers.length; k++) {
      this.allLayers[k].w.set(other.allLayers[k].w);
      this.allLayers[k].b.set(other.allLayers[k].b);
    }
    this.logStd.set(other.logStd);
    this.obsStats.count = other.obsStats.count;
    this.obsStats.mean.set(other.obsStats.mean);
    this.obsStats.variance.set(other.obsStats.variance);
  }

  serialize(meta: CheckpointMetadata): PolicyCheckpoint {
    return {
      schemaVersion: 1,
      architecture: { ...this.arch },
      weights: {
        actorW1: Array.from(this.actorL1.w),
        actorB1: Array.from(this.actorL1.b),
        actorW2: Array.from(this.actorL2.w),
        actorB2: Array.from(this.actorL2.b),
        actorW3: Array.from(this.actorOut.w),
        actorB3: Array.from(this.actorOut.b),
        criticW1: Array.from(this.criticL1.w),
        criticB1: Array.from(this.criticL1.b),
        criticW2: Array.from(this.criticL2.w),
        criticB2: Array.from(this.criticL2.b),
        criticW3: Array.from(this.criticOut.w),
        criticB3: Array.from(this.criticOut.b),
      },
      logStd: Array.from(this.logStd),
      obsNormStats: this.obsStats.toJSON(),
      planet: meta.planet,
      mission: meta.mission,
      totalSteps: meta.totalSteps,
      episodesCompleted: meta.episodesCompleted,
      seed: meta.seed,
    };
  }

  static deserialize(payload: PolicyCheckpoint | string): {
    network: ActorCriticMLP;
    checkpoint: PolicyCheckpoint;
  } {
    const cp: PolicyCheckpoint =
      typeof payload === "string" ? (JSON.parse(payload) as PolicyCheckpoint) : payload;

    if (!cp || cp.schemaVersion !== 1 || !cp.architecture || !cp.weights) {
      throw new Error("Invalid AetherSim policy checkpoint schema.");
    }

    const net = new ActorCriticMLP(cp.architecture, cp.seed ?? 42, cp.obsNormStats);
    const assign = (target: Float32Array, src: number[], label: string) => {
      if (!Array.isArray(src) || src.length !== target.length) {
        throw new Error(`Checkpoint weight mismatch for ${label}`);
      }
      for (let i = 0; i < src.length; i++) {
        if (!Number.isFinite(src[i])) {
          throw new Error(`Non-finite checkpoint weight in ${label}`);
        }
        target[i] = src[i];
      }
    };

    assign(net.actorL1.w, cp.weights.actorW1, "actorW1");
    assign(net.actorL1.b, cp.weights.actorB1, "actorB1");
    assign(net.actorL2.w, cp.weights.actorW2, "actorW2");
    assign(net.actorL2.b, cp.weights.actorB2, "actorB2");
    assign(net.actorOut.w, cp.weights.actorW3, "actorW3");
    assign(net.actorOut.b, cp.weights.actorB3, "actorB3");

    assign(net.criticL1.w, cp.weights.criticW1, "criticW1");
    assign(net.criticL1.b, cp.weights.criticB1, "criticB1");
    assign(net.criticL2.w, cp.weights.criticW2, "criticW2");
    assign(net.criticL2.b, cp.weights.criticB2, "criticB2");
    assign(net.criticOut.w, cp.weights.criticW3, "criticW3");
    assign(net.criticOut.b, cp.weights.criticB3, "criticB3");

    assign(net.logStd, cp.logStd, "logStd");

    return { network: net, checkpoint: cp };
  }
}
