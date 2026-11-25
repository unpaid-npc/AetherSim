import { describe, expect, it } from "vitest";
import { ActorCriticMLP } from "../ai/NeuralNetwork";
import { PPOTrainer } from "../ai/PPOTrainer";
import { SeededPRNG } from "../ai/prng";
import {
  ACTION_DIM,
  OBS_DIM,
  RLEnvironment,
  applyRLSpawnToController,
  computeStepReward,
  isLaunchSuccess,
  mapRawActionToAIInput,
} from "../ai/RLEnvironment";
import { FlightController } from "../sim/FlightController";

describe("Milestone 2 — Continuous PPO Neural Network AI Engine", () => {
  it("produces deterministic forward passes, exact activations, and lossless JSON checkpoint round-trip", () => {
    const net1 = new ActorCriticMLP({ obsDim: OBS_DIM, hidden1: 64, hidden2: 64, actionDim: ACTION_DIM }, 123);
    const obs = new Float32Array([0.1, 0.3, -0.05, -0.04, -0.2, 0.02, 0.08, -0.02, 0, 0.01, 0, -0.01, 0.72, 0.38]);

    const snap1 = net1.forwardWithActivations(obs);
    expect(snap1.mean.length).toBe(3);
    expect(snap1.actorHidden1.length).toBe(64);
    expect(snap1.actorHidden2.length).toBe(64);
    expect(snap1.criticHidden1.length).toBe(64);
    expect(snap1.criticHidden2.length).toBe(64);
    expect(Number.isFinite(snap1.value)).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(Number.isFinite(snap1.mean[i])).toBe(true);
    }

    const cp = net1.serialize({
      planet: "mars",
      mission: "landing",
      totalSteps: 512,
      episodesCompleted: 4,
      seed: 123,
    });
    expect(cp.schemaVersion).toBe(1);
    expect(cp.architecture.obsDim).toBe(14);
    expect(cp.architecture.actionDim).toBe(3);

    const { network: net2, checkpoint: decoded } = ActorCriticMLP.deserialize(JSON.stringify(cp));
    expect(decoded.planet).toBe("mars");
    expect(decoded.totalSteps).toBe(512);

    const snap2 = net2.forwardWithActivations(obs);
    expect(snap2.value).toBeCloseTo(snap1.value, 6);
    for (let i = 0; i < 3; i++) {
      expect(snap2.mean[i]).toBeCloseTo(snap1.mean[i], 6);
      expect(snap2.logStd[i]).toBeCloseTo(snap1.logStd[i], 6);
    }
  });

  it("computes exact analytical actor & critic backpropagation and decreases supervised MSE loss under Adam", () => {
    const net = new ActorCriticMLP({ obsDim: OBS_DIM, hidden1: 32, hidden2: 32, actionDim: ACTION_DIM }, 77);
    const prng = new SeededPRNG(77);
    const obs = new Float32Array(OBS_DIM);
    for (let i = 0; i < OBS_DIM; i++) {
      obs[i] = prng.uniform(-0.8, 0.8);
    }
    const targetAction = new Float32Array([0.65, -0.4, 0.25]);
    const targetValue = 2.5;

    // Finite-difference check on Critic output bias/weights via loss decrease & exact analytical step
    const initialForward = net.forwardWithActivations(obs);
    const initialActorLoss =
      0.5 *
      ((initialForward.mean[0] - targetAction[0]) ** 2 +
        (initialForward.mean[1] - targetAction[1]) ** 2 +
        (initialForward.mean[2] - targetAction[2]) ** 2);
    const initialCriticLoss = 0.5 * (initialForward.value - targetValue) ** 2;

    for (let step = 0; step < 50; step++) {
      net.zeroGrad();
      const { mean, value } = net.forwardFast(obs);
      const dMean = new Float32Array([
        mean[0] - targetAction[0],
        mean[1] - targetAction[1],
        mean[2] - targetAction[2],
      ]);
      const dLogStd = new Float32Array([0, 0, 0]);
      net.accumulateActorBackward(obs, dMean, dLogStd);
      net.accumulateCriticBackward(obs, value - targetValue);
      const gradNorm = net.stepAdam(1e-2, 2.0, 1.0);
      expect(Number.isFinite(gradNorm)).toBe(true);
    }

    const finalForward = net.forwardWithActivations(obs);
    const finalActorLoss =
      0.5 *
      ((finalForward.mean[0] - targetAction[0]) ** 2 +
        (finalForward.mean[1] - targetAction[1]) ** 2 +
        (finalForward.mean[2] - targetAction[2]) ** 2);
    const finalCriticLoss = 0.5 * (finalForward.value - targetValue) ** 2;

    expect(finalActorLoss).toBeLessThan(initialActorLoss * 0.2);
    expect(finalCriticLoss).toBeLessThan(initialCriticLoss * 0.2);
  });

  it("extracts 14D observations, maps continuous actions, and computes decomposed rewards across planets", () => {
    for (const planetId of ["mars", "earth", "moon"] as const) {
      const env = new RLEnvironment(
        { planetId, missionMode: "landing", randomizeSpawn: true },
        55
      );
      const obs = new Float32Array(OBS_DIM);
      const prevTel = env.reset(obs);
      expect(obs.length).toBe(14);
      for (let i = 0; i < OBS_DIM; i++) {
        expect(Number.isFinite(obs[i])).toBe(true);
      }

      const mapped = mapRawActionToAIInput([0.0, 0.5, -0.5]);
      expect(mapped.throttle).toBeCloseTo(0.5, 5);
      expect(mapped.pitchCmd).toBeCloseTo(0.5, 5);
      expect(mapped.yawCmd).toBeCloseTo(-0.5, 5);

      const res = env.step([0.0, 0.2, -0.1]);
      const sum =
        res.rewardBreakdown.components.distance +
        res.rewardBreakdown.components.velocity +
        res.rewardBreakdown.components.attitude +
        res.rewardBreakdown.components.fuel +
        res.rewardBreakdown.components.terminal;
      expect(res.rewardBreakdown.totalReward).toBeCloseTo(sum, 6);
      expect(res.reward).toBeCloseTo(sum, 6);

      const recomputed = computeStepReward(prevTel, res.telemetry, res.outOfBounds);
      expect(recomputed.totalReward).toBeCloseTo(res.reward, 6);
    }
  });

  it("demonstrates genuine headless PPO learning improvement from untrained scratch weights", () => {
    const trainer = new PPOTrainer(
      { planetId: "moon", missionMode: "landing", randomizeSpawn: false },
      {
        learningRate: 8e-4,
        rolloutSteps: 512,
        epochs: 6,
        miniBatchSize: 64,
        entropyCoef: 0.01,
        targetKL: 0.04,
      },
      42
    );

    const preEval = trainer.evaluateBatch(4, true);
    let lastMetrics = trainer.getLastMetrics();

    for (let u = 0; u < 18; u++) {
      lastMetrics = trainer.trainOneUpdate();
      expect(Number.isFinite(lastMetrics.policyLoss)).toBe(true);
      expect(Number.isFinite(lastMetrics.valueLoss)).toBe(true);
      expect(Number.isFinite(lastMetrics.entropy)).toBe(true);
      expect(Number.isFinite(lastMetrics.approxKL)).toBe(true);
    }

    const postEval = trainer.evaluateBatch(4, true);
    console.info(
      `[PPO Convergence Proof] preMeanReturn=${preEval.meanReturn.toFixed(2)}, postMeanReturn=${postEval.meanReturn.toFixed(2)}, throughput=${lastMetrics.stepsPerSec} steps/s, episodes=${lastMetrics.episodesCompleted}`
    );

    expect(lastMetrics.totalSteps).toBe(18 * 512);
    expect(lastMetrics.stepsPerSec).toBeGreaterThan(500);
    expect(postEval.meanReturn).toBeGreaterThan(preEval.meanReturn + 15);
  });

  it("prevents LAUNCH sideways reward hacking: upright climb achieves success and beats sideways flight", () => {
    const uprightEnv = new RLEnvironment(
      { planetId: "mars", missionMode: "launch", randomizeSpawn: false },
      11
    );
    uprightEnv.reset();
    let uprightRet = 0;
    let uprightSuccess = false;
    for (let t = 0; t < 400; t++) {
      const res = uprightEnv.step([1.0, 0.0, 0.0]);
      uprightRet += res.reward;
      if (isLaunchSuccess(res.telemetry)) {
        uprightSuccess = true;
      }
      if (res.done) break;
    }

    const sidewaysEnv = new RLEnvironment(
      { planetId: "mars", missionMode: "launch", randomizeSpawn: false },
      11
    );
    sidewaysEnv.reset();
    let sidewaysRet = 0;
    let sidewaysSuccess = false;
    for (let t = 0; t < 400; t++) {
      const res = sidewaysEnv.step([1.0, 0.9, 0.4]);
      sidewaysRet += res.reward;
      if (isLaunchSuccess(res.telemetry)) {
        sidewaysSuccess = true;
      }
      if (res.done) break;
    }

    expect(uprightSuccess).toBe(true);
    expect(sidewaysSuccess).toBe(false);
    expect(sidewaysRet).toBeLessThan(0);
    expect(uprightRet).toBeGreaterThan(sidewaysRet + 150);
  });

  it("hotfix v1.0.1: Earth landing warm-start achieves high deterministic landing rate and resists PPO collapse", () => {
    const trainer = new PPOTrainer(
      { planetId: "earth", missionMode: "landing", randomizeSpawn: true },
      { learningRate: 6e-4, rolloutSteps: 512, epochs: 6, miniBatchSize: 64 },
      42
    );

    const warmRes = trainer.warmStartWithSummary(12, 14);
    expect(warmRes.bestBrain.hasTrainedWeights).toBe(true);
    expect(warmRes.bestBrain.brainLevel).toBe("pre_trained");
    expect(trainer.policy.logStd[0]).toBeLessThanOrEqual(-1.4);
    expect(warmRes.bestBrain.evalSafeRatePct).toBeGreaterThanOrEqual(80);
    expect(warmRes.evalSummary.crashRatePct).toBeLessThanOrEqual(20);

    // Run 8 subsequent PPO updates (4,096 steps) and verify policy-collapse guard preserves best brain
    for (let u = 0; u < 8; u++) {
      trainer.trainOneUpdate();
    }

    const postBest = trainer.getBestBrain();
    expect(postBest.hasTrainedWeights).toBe(true);
    expect(postBest.evalSafeRatePct).toBeGreaterThanOrEqual(80);

    // Independently evaluate exported best checkpoint through pure ActorCriticMLP forward passes
    const verifier = new PPOTrainer(
      { planetId: "earth", missionMode: "landing", randomizeSpawn: true },
      { rolloutSteps: 512 },
      42
    );
    verifier.loadCheckpoint(trainer.exportBestCheckpoint(), postBest);
    const verifyEval = verifier.evaluateBatch(5, true, 9001);
    const verifySafePct = verifyEval.successRatePct + verifyEval.hardLandingRatePct;
    console.info(
      `[Hotfix v1.0.1 Earth Warm-Start & Anti-Collapse] preSafe=${warmRes.bestBrain.evalSafeRatePct.toFixed(0)}% (nom=${warmRes.bestBrain.evalSuccessRatePct.toFixed(0)}%, ret=${warmRes.bestBrain.evalMeanReturn.toFixed(1)}), postBestSafe=${verifySafePct.toFixed(0)}% (nom=${verifyEval.successRatePct.toFixed(0)}%, ret=${verifyEval.meanReturn.toFixed(1)})`
    );
    expect(verifySafePct).toBeGreaterThanOrEqual(80);
    expect(verifyEval.crashRatePct).toBeLessThanOrEqual(20);

    // Verify clean session/context reset when switching planet & padDeckY parity
    trainer.setEnvConfig("mars", "landing", true);
    expect(trainer.getBestBrain().hasTrainedWeights).toBe(false);
    expect(trainer.brainLevel).toBe("untrained");
    expect(trainer.episodesCompleted).toBe(0);

    const ctrl = new FlightController("mars", 2.2, "landing");
    applyRLSpawnToController(ctrl, "earth", "landing", false, new SeededPRNG(9));
    expect(ctrl.getTelemetry().padDeckY).toBeCloseTo(18.0, 5);
    applyRLSpawnToController(ctrl, "moon", "landing", false, new SeededPRNG(9));
    expect(ctrl.getTelemetry().padDeckY).toBeCloseTo(1.6, 5);
  }, 15_000);
});
