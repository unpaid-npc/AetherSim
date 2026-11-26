import { type PlanetId, getPlanetConfig } from "../config/planets";
import {
  type FaultConfig,
  createDefaultFaultConfig,
  sanitizeFaultConfig,
} from "../sim/FaultInjector";
import {
  type AIActionInput,
  FlightController,
  type FlightTelemetry,
  type MissionMode,
} from "../sim/FlightController";
import { SeededPRNG } from "./prng";

export const OBS_DIM = 14;
export const ACTION_DIM = 3;
export const RL_CONTROL_DT = 0.05; // 20 Hz policy decision rate
const PHYSICS_SUBSTEPS = 3; // 3 * (1/60s) = 0.05s

export interface RewardComponents {
  readonly distance: number;
  readonly velocity: number;
  readonly attitude: number;
  readonly fuel: number;
  readonly terminal: number;
}

export interface RewardBreakdown {
  readonly totalReward: number;
  readonly components: RewardComponents;
}

export interface RLEnvConfig {
  planetId: PlanetId;
  missionMode: MissionMode;
  randomizeSpawn: boolean;
  maxSteps?: number;
  padDeckY?: number;
  faultConfig?: FaultConfig;
}

export interface RLStepResult {
  obs: Float32Array;
  reward: number;
  rewardBreakdown: RewardBreakdown;
  done: boolean;
  outOfBounds: boolean;
  telemetry: FlightTelemetry;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function isLandingSuccess(tel: FlightTelemetry): boolean {
  return (
    tel.missionMode === "landing" &&
    tel.phase === "TOUCHDOWN" &&
    tel.landingVerdict === "NOMINAL LANDING"
  );
}

export function isLaunchSuccess(tel: FlightTelemetry): boolean {
  if (tel.missionMode !== "launch" || tel.phase === "CRASHED") {
    return false;
  }
  if (tel.phase === "COMPLETE" || tel.phase === "ORBIT_ACHIEVED") {
    return true;
  }
  const tiltDeg = (Math.hypot(tel.pitch, tel.roll) * 180) / Math.PI;
  return tel.altitudeM >= 1200 && tel.verticalSpeedMps > 35 && tiltDeg < 35;
}

export function getPadDeckYForPlanet(planetId: PlanetId): number {
  if (planetId === "earth") {
    return 18.0;
  }
  if (planetId === "mars") {
    return 2.2;
  }
  return 1.6;
}

/**
 * Extracts the 14D normalized observation vector from FlightTelemetry:
 *   [0]  x / 250               (lateral X offset, m)
 *   [1]  alt / 600             (altitude above local surface, m)
 *   [2]  z / 250               (lateral Z offset, m)
 *   [3]  vx / 80               (horizontal X velocity, m/s)
 *   [4]  vy / 80               (vertical velocity, m/s)
 *   [5]  vz / 80               (horizontal Z velocity, m/s)
 *   [6]  pitch / pi            (pitch angle, rad)
 *   [7]  roll / pi             (roll angle, rad)
 *   [8]  yaw / pi              (yaw angle, rad)
 *   [9]  wx / 2                (pitch angular rate, rad/s)
 *   [10] wy / 2                (yaw angular rate, rad/s)
 *   [11] wz / 2                (roll angular rate, rad/s)
 *   [12] fuelFrac              (active stage propellant fraction in [0, 1])
 *   [13] gravityRatio          (planet g / 9.807)
 */
export function extractObservation(
  tel: FlightTelemetry,
  out = new Float32Array(OBS_DIM)
): Float32Array {
  const g = getPlanetConfig(tel.planetId).physics.gravityMps2;
  const fuelFrac =
    tel.missionMode === "launch" && !tel.stageSeparated
      ? tel.boosterFuel
      : tel.shipFuel;

  out[0] = clamp(tel.position.x / 250, -5, 5);
  out[1] = clamp(tel.altitudeM / 600, -5, 5);
  out[2] = clamp(tel.position.z / 250, -5, 5);
  out[3] = clamp(tel.velocity.x / 80, -5, 5);
  out[4] = clamp(tel.velocity.y / 80, -5, 5);
  out[5] = clamp(tel.velocity.z / 80, -5, 5);
  out[6] = clamp(tel.pitch / Math.PI, -5, 5);
  out[7] = clamp(tel.roll / Math.PI, -5, 5);
  out[8] = clamp(tel.yaw / Math.PI, -5, 5);
  out[9] = clamp(tel.angularVelocity.pitch / 2, -5, 5);
  out[10] = clamp(tel.angularVelocity.yaw / 2, -5, 5);
  out[11] = clamp(tel.angularVelocity.roll / 2, -5, 5);
  out[12] = clamp(fuelFrac, 0, 1);
  out[13] = clamp(g / 9.807, 0, 2);
  return out;
}

/**
 * Maps raw unconstrained policy output [throttleRaw, pitchCmd, yawCmd]
 * to physical FlightController AIActionInput commands.
 */
export function mapRawActionToAIInput(rawAction: ArrayLike<number>): AIActionInput {
  const throttle = clamp(0.5 * (rawAction[0] + 1.0), 0.0, 1.0);
  const pitchCmd = clamp(rawAction[1], -1.0, 1.0);
  const yawCmd = clamp(rawAction[2], -1.0, 1.0);
  return {
    throttle,
    pitchCmd,
    yawCmd,
    autoLegs: true,
  };
}

export function isRLOutOfBounds(tel: FlightTelemetry): boolean {
  const horizDist = Math.hypot(tel.position.x, tel.position.z);
  if (tel.missionMode === "landing") {
    return horizDist > 260 || tel.altitudeM > 680;
  }
  return horizDist > 2200 || tel.altitudeM > 15000;
}

/**
 * Decomposed step reward for landing & launch missions, returning both totalReward
 * and exact per-component diagnostics so researchers can audit policy behavior.
 */
export function computeStepReward(
  prevTel: FlightTelemetry,
  currTel: FlightTelemetry,
  outOfBounds: boolean
): RewardBreakdown {
  if (currTel.missionMode === "landing") {
    const prevHoriz = Math.hypot(prevTel.position.x, prevTel.position.z);
    const currHoriz = Math.hypot(currTel.position.x, currTel.position.z);
    const prevDist = Math.hypot(prevTel.position.x, prevTel.altitudeM, prevTel.position.z);
    const currDist = Math.hypot(currTel.position.x, currTel.altitudeM, currTel.position.z);

    // 1. Potential-based progress toward pad center + proximity bonus
    const distance =
      (prevDist - currDist) * 0.42 +
      (prevHoriz - currHoriz) * 0.28 -
      (currHoriz / 250) * 0.08;

    // 2. Descent-speed envelope shaping (guide safe sink rate & lateral damping)
    const targetVy =
      currTel.altitudeM > 14
        ? -clamp(1.2 + Math.sqrt(currTel.altitudeM) * 1.1, 1.6, 36)
        : -1.4;
    const vyErr = Math.abs(currTel.verticalSpeedMps - targetVy);
    const targetVx = clamp(-currTel.position.x * 0.2, -16, 16);
    const targetVz = clamp(-currTel.position.z * 0.2, -16, 16);
    const horizVelErr = Math.hypot(
      currTel.velocity.x - targetVx,
      currTel.velocity.z - targetVz
    );
    const upwardPenalty = currTel.verticalSpeedMps > 2.5 ? -0.18 * (currTel.verticalSpeedMps - 2.5) : 0;
    const velocity =
      -0.018 * vyErr -
      0.016 * horizVelErr +
      upwardPenalty;

    // 3. Upright attitude & angular rate damping
    const tiltRad = Math.hypot(currTel.pitch, currTel.roll);
    const angSpeed = Math.hypot(
      currTel.angularVelocity.pitch,
      currTel.angularVelocity.roll
    );
    const attitude = 0.08 * (1.0 - Math.min(2.0, tiltRad / 0.45)) - 0.025 * angSpeed;

    // 4. Small propellant conservation term
    const fuel = -0.025 * currTel.throttle;

    // 5. Decisive terminal outcomes
    let terminal = 0;
    if (currTel.phase === "TOUCHDOWN") {
      if (currTel.landingVerdict === "NOMINAL LANDING") {
        const precisionBonus = Math.max(0, 35 * (1 - (currTel.touchdownOffsetM ?? 0) / 45));
        terminal = 200 + precisionBonus;
      } else if (currTel.landingVerdict === "HARD LANDING") {
        terminal = 60;
      }
    } else if (currTel.phase === "CRASHED") {
      const impactV = currTel.crashEvent?.impactSpeedMps ?? currTel.speedMps;
      terminal = -100 - clamp(impactV * 0.45, 0, 50);
    } else if (outOfBounds) {
      terminal = -80;
    }

    return {
      totalReward: distance + velocity + attitude + fuel + terminal,
      components: { distance, velocity, attitude, fuel, terminal },
    };
  }

  // Launch mode reward: upright controlled climb toward target altitude, penalizing sideways/tower drift
  const tiltRad = Math.hypot(currTel.pitch, currTel.roll);
  const tiltDeg = (tiltRad * 180) / Math.PI;
  const climbDelta = currTel.altitudeM - prevTel.altitudeM;
  const horizDist = Math.hypot(currTel.position.x, currTel.position.z);
  const uprightFactor = Math.max(0, Math.cos(tiltRad));

  const towerDriftPenalty =
    currTel.altitudeM < 300 && horizDist > 40 ? (horizDist - 40) * 0.008 : (horizDist / 2000) * 0.04;
  const distance =
    (climbDelta > 0 ? climbDelta * 0.08 * uprightFactor : climbDelta * 0.06) - towerDriftPenalty;

  const velocity =
    currTel.verticalSpeedMps > 0
      ? 0.025 * Math.min(60, currTel.verticalSpeedMps) * uprightFactor
      : -0.22;

  const targetPitch = currTel.altitudeM < 90 ? 0 : clamp((currTel.altitudeM - 90) / 3600, 0, 0.55);
  const pitchErr = Math.abs(currTel.pitch - targetPitch) + Math.abs(currTel.roll);
  const earlyTiltPenalty =
    currTel.altitudeM < 300 && tiltDeg > 25 ? -(tiltDeg - 25) * 0.06 : 0;
  const attitude =
    0.12 * (1.0 - Math.min(2.5, pitchErr / 0.45)) +
    earlyTiltPenalty -
    0.03 * Math.hypot(currTel.angularVelocity.pitch, currTel.angularVelocity.roll);
  const fuel = -0.01 * currTel.throttle;

  let terminal = 0;
  if (isLaunchSuccess(currTel)) {
    terminal = 220;
  } else if (currTel.phase === "CRASHED") {
    const impactV = currTel.crashEvent?.impactSpeedMps ?? currTel.speedMps;
    terminal = -120 - clamp(impactV * 0.35, 0, 50);
  } else if (tiltDeg > 65 || outOfBounds) {
    terminal = -120;
  }

  return {
    totalReward: distance + velocity + attitude + fuel + terminal,
    components: { distance, velocity, attitude, fuel, terminal },
  };
}

/**
 * Configures FlightController spawn state for an RL episode (supports both landing & launch).
 */
export function applyRLSpawnToController(
  ctrl: FlightController,
  planetId: PlanetId,
  missionMode: MissionMode,
  randomizeSpawn: boolean,
  prng: SeededPRNG
): void {
  const padDeckY = getPadDeckYForPlanet(planetId);
  if (missionMode === "landing") {
    const dx = randomizeSpawn ? prng.uniform(-22, 22) : 0;
    const dz = randomizeSpawn ? prng.uniform(-20, 20) : 0;
    const dAlt = randomizeSpawn ? prng.uniform(-35, 35) : 0;
    const dvx = randomizeSpawn ? prng.uniform(-4, 4) : 0;
    const dvy = randomizeSpawn ? prng.uniform(-4, 4) : 0;
    const dvz = randomizeSpawn ? prng.uniform(-4, 4) : 0;
    const dPitch = randomizeSpawn ? prng.uniform(-8, 8) * (Math.PI / 180) : 0;
    const dRoll = randomizeSpawn ? prng.uniform(-8, 8) * (Math.PI / 180) : 0;

    ctrl.configureRLSpawn({
      planetId,
      padDeckY,
      missionMode: "landing",
      position: { x: 18 + dx, y: padDeckY + 200 + dAlt, z: 8 + dz },
      velocity: { x: -2.6 + dvx, y: -17.5 + dvy, z: -1.0 + dvz },
      pitch: 6 * (Math.PI / 180) + dPitch,
      roll: -2 * (Math.PI / 180) + dRoll,
      yaw: 0,
      shipFuel: 0.72,
      boosterFuel: 0,
      phase: "FLIP_BURN",
      running: true,
      hasLiftedOff: true,
      stageSeparated: true,
      landingLegsDeployed: 0,
      targetLandingLegs: 0,
      flapAngleRad: 0.18,
      frostLevel: 0.25,
      umbilicalRetracted: 1,
      catchArmsOpen: 0.85,
    });
  } else {
    const dPitch = randomizeSpawn ? prng.uniform(-4, 4) * (Math.PI / 180) : 0;
    const dRoll = randomizeSpawn ? prng.uniform(-4, 4) * (Math.PI / 180) : 0;
    ctrl.configureRLSpawn({
      planetId,
      padDeckY,
      missionMode: "launch",
      position: { x: 0, y: padDeckY, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      pitch: dPitch,
      roll: dRoll,
      yaw: 0,
      shipFuel: 1.0,
      boosterFuel: 1.0,
      phase: "LIFTOFF",
      running: true,
      hasLiftedOff: false,
      stageSeparated: false,
      landingLegsDeployed: 0,
      targetLandingLegs: 0,
      flapAngleRad: 0.05,
      frostLevel: 0.85,
      umbilicalRetracted: 1,
      catchArmsOpen: 0.85,
    });
  }
}

/**
 * Deterministic headless RL environment wrapping FlightController at 20 Hz decision rate.
 */
export class RLEnvironment {
  public readonly controller: FlightController;
  public readonly config: Required<RLEnvConfig>;
  private readonly prng: SeededPRNG;
  private stepCount = 0;
  private prevTelemetry: FlightTelemetry;

  constructor(config: RLEnvConfig, seed = 42) {
    const padDeckY = config.padDeckY ?? getPadDeckYForPlanet(config.planetId);
    this.config = {
      planetId: config.planetId,
      missionMode: config.missionMode,
      randomizeSpawn: config.randomizeSpawn,
      maxSteps: config.maxSteps ?? 700,
      padDeckY,
      faultConfig: config.faultConfig
        ? sanitizeFaultConfig(config.faultConfig)
        : createDefaultFaultConfig(),
    };
    this.prng = new SeededPRNG(seed);
    this.controller = new FlightController(
      this.config.planetId,
      this.config.padDeckY,
      this.config.missionMode
    );
    this.controller.setControlMode("ai_ppo");
    this.controller.setFaultConfig(this.config.faultConfig);
    this.prevTelemetry = this.reset();
  }

  setPlanetAndMission(
    planetId: PlanetId,
    missionMode: MissionMode,
    randomizeSpawn = this.config.randomizeSpawn,
    faultConfig?: FaultConfig
  ): void {
    this.config.planetId = planetId;
    this.config.missionMode = missionMode;
    this.config.randomizeSpawn = randomizeSpawn;
    this.config.padDeckY = getPadDeckYForPlanet(planetId);
    this.config.maxSteps = 700;
    if (faultConfig) {
      this.config.faultConfig = sanitizeFaultConfig(faultConfig);
    }
    this.controller.reset(planetId, this.config.padDeckY, missionMode);
    this.controller.setControlMode("ai_ppo");
    this.controller.setFaultConfig(this.config.faultConfig);
  }

  reset(obsOut = new Float32Array(OBS_DIM)): FlightTelemetry {
    this.stepCount = 0;
    this.controller.setControlMode("ai_ppo");
    this.controller.setFaultConfig(this.config.faultConfig);
    applyRLSpawnToController(
      this.controller,
      this.config.planetId,
      this.config.missionMode,
      this.config.randomizeSpawn,
      this.prng
    );
    const tel = this.controller.getTelemetry();
    this.prevTelemetry = tel;
    const sensed = this.controller.getSensedTelemetry(this.prng.gaussian(0, 1), this.prng.gaussian(0, 1));
    extractObservation(sensed, obsOut);
    return tel;
  }

  getObservation(obsOut = new Float32Array(OBS_DIM)): Float32Array {
    const sensed = this.controller.getSensedTelemetry(this.prng.gaussian(0, 1), this.prng.gaussian(0, 1));
    return extractObservation(sensed, obsOut);
  }

  step(rawAction: ArrayLike<number>, obsOut = new Float32Array(OBS_DIM)): RLStepResult {
    const aiInput = mapRawActionToAIInput(rawAction);
    const prev = this.prevTelemetry;

    let curr = prev;
    for (let s = 0; s < PHYSICS_SUBSTEPS; s++) {
      curr = this.controller.stepFixedDirect(1 / 60, aiInput);
      if (curr.phase === "TOUCHDOWN" || curr.phase === "CRASHED" || curr.phase === "COMPLETE") {
        break;
      }
    }

    this.stepCount += 1;
    const outOfBounds = isRLOutOfBounds(curr);
    const tiltDeg = (Math.hypot(curr.pitch, curr.roll) * 180) / Math.PI;
    const launchSuccess = curr.missionMode === "launch" && isLaunchSuccess(curr);
    const launchSidewaysFail = curr.missionMode === "launch" && tiltDeg > 65;
    const terminalPhase =
      curr.phase === "TOUCHDOWN" ||
      curr.phase === "CRASHED" ||
      curr.phase === "COMPLETE" ||
      launchSuccess ||
      launchSidewaysFail;
    const timedOut = this.stepCount >= this.config.maxSteps;
    const done = terminalPhase || outOfBounds || timedOut;

    const rewardBreakdown = computeStepReward(prev, curr, outOfBounds);
    this.prevTelemetry = curr;
    const sensed = this.controller.getSensedTelemetry(
      this.prng.gaussian(0, 1),
      this.prng.gaussian(0, 1)
    );
    extractObservation(sensed, obsOut);

    return {
      obs: obsOut,
      reward: rewardBreakdown.totalReward,
      rewardBreakdown,
      done,
      outOfBounds,
      telemetry: curr,
    };
  }
}
