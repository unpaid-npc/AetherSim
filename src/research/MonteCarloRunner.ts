import { ActorCriticMLP, type PolicyCheckpoint } from "../ai/NeuralNetwork";
import { SeededPRNG } from "../ai/prng";
import {
  ACTION_DIM,
  OBS_DIM,
  RLEnvironment,
  isLandingSuccess,
  isLaunchSuccess,
} from "../ai/RLEnvironment";
import type { PlanetId } from "../config/planets";
import type { FaultConfig } from "../sim/FaultInjector";
import type { MissionMode } from "../sim/FlightController";

export type MonteCarloPilot = "ai_ppo" | "autopilot";

export interface MonteCarloOptions {
  episodes: number;
  pilot: MonteCarloPilot;
  planetId: PlanetId;
  missionMode: MissionMode;
  faultConfig?: FaultConfig;
  checkpoint?: PolicyCheckpoint;
  seed?: number;
}

export interface MonteCarloSummary {
  readonly pilot: MonteCarloPilot;
  readonly planet: PlanetId;
  readonly mission: MissionMode;
  readonly episodes: number;
  readonly seed: number;
  readonly successCount: number;
  readonly hardLandingCount: number;
  readonly crashCount: number;
  readonly outOfBoundsCount: number;
  readonly timeoutCount: number;
  readonly successRatePct: number;
  readonly ciLowPct: number;
  readonly ciHighPct: number;
  readonly crashRatePct: number;
  readonly meanReturn: number;
  readonly stdReturn: number;
  readonly meanTouchdownVy: number | null;
  readonly meanPadOffsetM: number | null;
  readonly meanFuelRemainingPct: number;
  readonly durationMs: number;
}

function logGammaInt(n: number): number {
  // Exact log((n-1)!) for integer n >= 1 via direct summation
  let s = 0;
  for (let i = 2; i < n; i++) {
    s += Math.log(i);
  }
  return s;
}

function binomialCdfUpperTail(k: number, n: number, p: number): number {
  // P(X >= k) for X ~ Binomial(n, p)
  if (k <= 0) {
    return 1;
  }
  if (k > n || p <= 0) {
    return 0;
  }
  if (p >= 1) {
    return 1;
  }
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  const logN = logGammaInt(n + 1);
  let sum = 0;
  for (let i = k; i <= n; i++) {
    const logCoef = logN - logGammaInt(i + 1) - logGammaInt(n - i + 1);
    sum += Math.exp(logCoef + i * logP + (n - i) * logQ);
  }
  return Math.min(1, Math.max(0, sum));
}

function binomialCdfLowerTail(k: number, n: number, p: number): number {
  // P(X <= k) for X ~ Binomial(n, p)
  if (k < 0) {
    return 0;
  }
  if (k >= n || p <= 0) {
    return 1;
  }
  if (p >= 1) {
    return 0;
  }
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  const logN = logGammaInt(n + 1);
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    const logCoef = logN - logGammaInt(i + 1) - logGammaInt(n - i + 1);
    sum += Math.exp(logCoef + i * logP + (n - i) * logQ);
  }
  return Math.min(1, Math.max(0, sum));
}

/**
 * Exact Clopper-Pearson two-sided binomial confidence interval in percent [0, 100].
 */
export function computeClopperPearsonCI(
  successes: number,
  trials: number,
  confidence = 0.95
): { lowPct: number; highPct: number } {
  if (trials <= 0) {
    return { lowPct: 0, highPct: 0 };
  }
  const alphaHalf = (1 - confidence) * 0.5;
  let low = 0;
  if (successes > 0) {
    let lo = 0;
    let hi = 1;
    for (let iter = 0; iter < 40; iter++) {
      const mid = 0.5 * (lo + hi);
      if (binomialCdfUpperTail(successes, trials, mid) >= alphaHalf) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    low = lo;
  }

  let high = 1;
  if (successes < trials) {
    let lo = 0;
    let hi = 1;
    for (let iter = 0; iter < 40; iter++) {
      const mid = 0.5 * (lo + hi);
      if (binomialCdfLowerTail(successes, trials, mid) >= alphaHalf) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    high = hi;
  }

  return {
    lowPct: Math.max(0, Math.min(100, low * 100)),
    highPct: Math.max(0, Math.min(100, high * 100)),
  };
}

/**
 * Runs N deterministic-seed domain-randomized evaluation episodes for either the
 * active PPO policy or classical PID Autopilot under active FaultConfig.
 */
export function runMonteCarloEvaluation(options: MonteCarloOptions): MonteCarloSummary {
  const startMs = performance.now();
  const seed = options.seed ?? 2026;
  const episodes = Math.max(1, Math.round(options.episodes));
  const env = new RLEnvironment(
    {
      planetId: options.planetId,
      missionMode: options.missionMode,
      randomizeSpawn: true,
      faultConfig: options.faultConfig,
    },
    seed
  );

  const policy =
    options.pilot === "ai_ppo"
      ? options.checkpoint
        ? ActorCriticMLP.deserialize(options.checkpoint).network
        : new ActorCriticMLP({ obsDim: OBS_DIM, hidden1: 64, hidden2: 64, actionDim: ACTION_DIM }, seed)
      : null;

  const evalPrng = new SeededPRNG(seed + 17);
  const obsBuf = new Float32Array(OBS_DIM);
  const nextObs = new Float32Array(OBS_DIM);
  const actScratch = new Float32Array(ACTION_DIM);

  const returns: number[] = [];
  let successCount = 0;
  let hardLandingCount = 0;
  let crashCount = 0;
  let outOfBoundsCount = 0;
  let timeoutCount = 0;
  let vySum = 0;
  let vyCount = 0;
  let offsetSum = 0;
  let offsetCount = 0;
  let fuelSum = 0;

  for (let ep = 0; ep < episodes; ep++) {
    env.reset(obsBuf);
    if (options.pilot === "autopilot") {
      env.controller.setControlMode("autopilot");
    }
    let epRet = 0;
    let lastRes = null as ReturnType<RLEnvironment["step"]> | null;

    for (let t = 0; t < env.config.maxSteps; t++) {
      if (options.pilot === "ai_ppo" && policy) {
        const { action } = policy.sampleAction(obsBuf, evalPrng, true, actScratch);
        lastRes = env.step(action, nextObs);
      } else {
        // Run the genuine FlightController PID_AUTO controller in the same faulted env
        lastRes = env.step(actScratch, nextObs);
      }
      epRet += lastRes.reward;
      obsBuf.set(nextObs);
      if (lastRes.done) {
        break;
      }
    }

    returns.push(epRet);
    const tel = lastRes ? lastRes.telemetry : env.controller.getTelemetry();
    const fuelFrac =
      tel.missionMode === "launch" && !tel.stageSeparated ? tel.boosterFuel : tel.shipFuel;
    fuelSum += fuelFrac * 100;

    if (options.missionMode === "landing") {
      if (isLandingSuccess(tel)) {
        successCount += 1;
      } else if (tel.phase === "TOUCHDOWN" && tel.landingVerdict === "HARD LANDING") {
        hardLandingCount += 1;
      } else if (tel.phase === "CRASHED") {
        crashCount += 1;
      } else if (lastRes?.outOfBounds) {
        outOfBoundsCount += 1;
      } else {
        timeoutCount += 1;
      }
    } else {
      if (isLaunchSuccess(tel)) {
        successCount += 1;
      } else if (tel.phase === "CRASHED") {
        crashCount += 1;
      } else if (lastRes?.outOfBounds) {
        outOfBoundsCount += 1;
      } else {
        timeoutCount += 1;
      }
    }

    if (tel.touchdownVerticalSpeedMps !== null) {
      vySum += tel.touchdownVerticalSpeedMps;
      vyCount += 1;
    }
    if (tel.touchdownOffsetM !== null) {
      offsetSum += tel.touchdownOffsetM;
      offsetCount += 1;
    }
  }

  let meanRet = 0;
  for (const r of returns) {
    meanRet += r;
  }
  meanRet /= episodes;

  let varRet = 0;
  for (const r of returns) {
    const d = r - meanRet;
    varRet += d * d;
  }
  const stdRet = Math.sqrt(varRet / episodes);

  const ci = computeClopperPearsonCI(successCount, episodes, 0.95);
  return {
    pilot: options.pilot,
    planet: options.planetId,
    mission: options.missionMode,
    episodes,
    seed,
    successCount,
    hardLandingCount,
    crashCount,
    outOfBoundsCount,
    timeoutCount,
    successRatePct: (successCount / episodes) * 100,
    ciLowPct: ci.lowPct,
    ciHighPct: ci.highPct,
    crashRatePct: (crashCount / episodes) * 100,
    meanReturn: meanRet,
    stdReturn: stdRet,
    meanTouchdownVy: vyCount > 0 ? vySum / vyCount : null,
    meanPadOffsetM: offsetCount > 0 ? offsetSum / offsetCount : null,
    meanFuelRemainingPct: fuelSum / episodes,
    durationMs: Math.round(performance.now() - startMs),
  };
}
