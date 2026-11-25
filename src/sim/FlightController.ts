import { type PlanetConfig, type PlanetId, getPlanetConfig } from "../config/planets";
import { PAD_FLAT_RADIUS_M, SeededNoise2D, samplePlanetTerrainHeight, smoothstep } from "../utils/noise";
import {
  type FaultConfig,
  applySensorFaultsToTelemetry,
  computeCrosswindAccel,
  computeEffectiveThrustScale,
  createDefaultFaultConfig,
  describeActiveFaults,
  sanitizeFaultConfig,
} from "./FaultInjector";
import {
  computeGravitationalParameter,
  computeOrbitalElements,
} from "./OrbitalMechanics";

export type MissionMode = "launch" | "landing";
export type ControlMode = "ai_ppo" | "autopilot" | "manual";
export type TimeWarp = 1 | 2 | 5 | 10;

export interface OrbitalTelemetry {
  apoapsisAltM: number;
  periapsisAltM: number;
  eccentricity: number;
  circularVelocityMps: number;
  orbitalSpeedMps: number;
  orbitalPeriodS: number | null;
  timeToApoapsisS: number | null;
  targetOrbitAltM: number;
  isBoundOrbit: boolean;
  orbitAchieved: boolean;
  timeWarp: TimeWarp;
  apoapsisWorldPos: { x: number; y: number; z: number } | null;
  periapsisWorldPos: { x: number; y: number; z: number } | null;
}

export interface AIActionInput {
  throttle: number;
  pitchCmd: number;
  yawCmd: number;
  autoLegs?: boolean;
}

export interface RLSpawnOverrides {
  planetId?: PlanetId;
  padDeckY?: number;
  missionMode?: MissionMode;
  position?: { x: number; y: number; z: number };
  velocity?: { x: number; y: number; z: number };
  pitch?: number;
  roll?: number;
  yaw?: number;
  shipFuel?: number;
  boosterFuel?: number;
  phase?: FlightPhase;
  running?: boolean;
  hasLiftedOff?: boolean;
  stageSeparated?: boolean;
  landingLegsDeployed?: number;
  targetLandingLegs?: number;
  flapAngleRad?: number;
  frostLevel?: number;
  umbilicalRetracted?: number;
  catchArmsOpen?: number;
}

export type FlightPhase =
  | "PRELAUNCH"
  | "COUNTDOWN"
  | "LIFTOFF"
  | "ASCENT"
  | "STAGE_SEP"
  | "ORBIT_INSERTION"
  | "COAST_TO_AP"
  | "CIRCULARIZATION"
  | "ORBIT_ACHIEVED"
  | "DESCENT"
  | "FLIP_BURN"
  | "TOUCHDOWN"
  | "CRASHED"
  | "COMPLETE";

export type LandingVerdict =
  | "NONE"
  | "NOMINAL LANDING"
  | "HARD LANDING"
  | "CRASH_RUD";

export type CrashCause =
  | "SURFACE_IMPACT"
  | "TIP_OVER"
  | "LAUNCH_TOWER_COLLISION"
  | "AERO_OVERSTRESS";

export interface CrashEvent {
  readonly id: number;
  readonly position: { x: number; y: number; z: number };
  readonly velocity: { x: number; y: number; z: number };
  readonly impactSpeedMps: number;
  readonly impactEnergyJ: number;
  readonly remainingFuelRatio: number;
  readonly cause: CrashCause;
  readonly timestampSec: number;
}

export interface ManualInputState {
  throttleDelta: number;
  throttleSet: number | null;
  pitchInput: number;
  yawInput: number;
  rollInput?: number;
}

export type BoosterStatus =
  | "NONE"
  | "ATTACHED"
  | "BOOSTER_FLIP"
  | "BOOSTER_BOOSTBACK"
  | "BOOSTER_DESCENT"
  | "BOOSTER_LANDING_BURN"
  | "BOOSTER_CAUGHT"
  | "BOOSTER_LANDED"
  | "BOOSTER_CRASHED";

export interface BoosterState {
  active: boolean;
  status: BoosterStatus;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  pitch: number;
  yaw: number;
  roll: number;
  throttle: number;
  fuel: number;
  altitudeM: number;
  verticalSpeedMps: number;
  padOffsetM: number;
  gridFinPitch: number;
  gridFinYaw: number;
  touchdownVerticalSpeedMps: number | null;
  touchdownOffsetM: number | null;
  impactEvent: CrashEvent | null;
}

export interface FlightTelemetry {
  planetId: PlanetId;
  missionMode: MissionMode;
  controlMode: ControlMode;
  phase: FlightPhase;
  running: boolean;
  paused: boolean;
  sasEnabled: boolean;
  missionTimeSec: number;
  tClockSec: number;
  padDeckY: number;
  surfaceHeightM: number;
  altitudeM: number;
  speedMps: number;
  speedKmh: number;
  verticalSpeedMps: number;
  mach: number;
  dynamicPressurePa: number;
  maxQPa: number;
  maxQReached: boolean;
  throttle: number;
  boosterThrottle: number;
  shipThrottle: number;
  boosterFuel: number;
  shipFuel: number;
  frostLevel: number;
  umbilicalRetracted: number;
  catchArmsOpen: number;
  catchCarriageY: number;
  flapAngleRad: number;
  gridFinPitch: number;
  gridFinYaw: number;
  landingLegsDeployed: number;
  targetLandingLegs: number;
  stageSeparated: boolean;
  gimbalX: number;
  gimbalZ: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  pitch: number;
  yaw: number;
  roll: number;
  angularVelocity: { pitch: number; yaw: number; roll: number };
  rcsThrust: { pitch: number; yaw: number; roll: number };
  booster: BoosterState;
  landingVerdict: LandingVerdict;
  crashEvent: CrashEvent | null;
  touchdownVerticalSpeedMps: number | null;
  touchdownOffsetM: number | null;
  touchdownTiltDeg: number | null;
  gLoad: number;
  activeFaults: string;
  orbital: OrbitalTelemetry;
}

const FIXED_DT = 1 / 60;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const STACK_DRY_AND_WET_MASS_KG = 1_600_000;
const SHIP_MASS_KG = 240_000;
const BOOSTER_RTLS_RESERVE_FUEL = 0.18;
const BOOSTER_RTLS_MAX_ACCEL = 32.0;
const BOOSTER_RTLS_BURN_RATE = 0.0042;
const BOOSTER_CATCH_CARRIAGE_LAUNCH_Y = 108.0;
const BOOSTER_CATCH_CARRIAGE_CATCH_Y = 83.4;

interface FirstStageProfile {
  readonly maxAccel: number;
  readonly netClimbLow: number;
  readonly netClimbMaxQ: number;
  readonly netClimbHigh: number;
  readonly climbSwitchAltM: number;
  readonly burnRate: number;
  readonly maxTurnRad: number;
}

function getFirstStageProfile(planetId: PlanetId): FirstStageProfile {
  if (planetId === "earth") {
    return {
      maxAccel: 34.0,
      netClimbLow: 11.5,
      netClimbMaxQ: 8.5,
      netClimbHigh: 19.2,
      climbSwitchAltM: 400,
      burnRate: 0.0268,
      maxTurnRad: 0.74,
    };
  }
  if (planetId === "mars") {
    return {
      maxAccel: 22.0,
      netClimbLow: 8.2,
      netClimbMaxQ: 8.2,
      netClimbHigh: 9.8,
      climbSwitchAltM: 550,
      burnRate: 0.0365,
      maxTurnRad: 0.72,
    };
  }
  return {
    maxAccel: 22.0,
    netClimbLow: 6.4,
    netClimbMaxQ: 6.4,
    netClimbHigh: 4.3,
    climbSwitchAltM: 420,
    burnRate: 0.078,
    maxTurnRad: 0.70,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function approach(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) {
    return target;
  }
  return current + Math.sign(diff) * maxDelta;
}

function wrapAngle(rad: number): number {
  let a = (rad + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

function approachAngle(current: number, target: number, maxDelta: number): number {
  const diff = wrapAngle(target - current);
  if (Math.abs(diff) <= maxDelta) {
    return wrapAngle(target);
  }
  return wrapAngle(current + Math.sign(diff) * maxDelta);
}

/**
 * Real-time 6-DOF-inspired rigid-body launch & propulsive landing flight simulator.
 *
 * Strictly decoupled from Three.js/DOM so headless Vitest suites and future RL
 * Web Workers can step physics deterministically at high speed.
 */
export class FlightController {
  private planet: PlanetConfig;
  private terrainNoise: SeededNoise2D;
  private padDeckY: number;
  private missionMode: MissionMode;
  private controlMode: ControlMode = "autopilot";
  private sasEnabled = true;
  private phase: FlightPhase = "PRELAUNCH";
  private running = false;
  private paused = false;
  private hasLiftedOff = false;

  private missionTimeSec = 0;
  private tClockSec = -10;
  private accumulator = 0;
  private eventSeq = 0;

  private pos = { x: 0, y: 0, z: 0 };
  private vel = { x: 0, y: 0, z: 0 };
  private pitch = 0;
  private yaw = 0;
  private roll = 0;
  private pitchVel = 0;
  private yawVel = 0;
  private rollVel = 0;
  private rcsThrust = { pitch: 0, yaw: 0, roll: 0 };

  private throttle = 0;
  private boosterThrottle = 0;
  private shipThrottle = 0;
  private boosterFuel = 1.0;
  private shipFuel = 1.0;
  private stageSeparated = false;

  private frostLevel = 1.0;
  private umbilicalRetracted = 0.0;
  private catchArmsOpen = 0.18;
  private catchCarriageY = BOOSTER_CATCH_CARRIAGE_LAUNCH_Y;
  private flapAngleRad = 0.0;
  private gridFinPitch = 0.0;
  private gridFinYaw = 0.0;
  private landingLegsDeployed = 0.0;
  private targetLandingLegs = 0.0;
  private gimbalX = 0.0;
  private gimbalZ = 0.0;
  private stageSepElapsedSec = 0;
  private boosterFlipTimerSec = 0;

  private dynamicPressurePa = 0;
  private maxQPa = 0;
  private maxQReached = false;
  private prevDynamicPressurePa = 0;
  private mach = 0;

  private booster: BoosterState = {
    active: false,
    status: "NONE",
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0,
    fuel: 1.0,
    altitudeM: 0,
    verticalSpeedMps: 0,
    padOffsetM: 0,
    gridFinPitch: 0,
    gridFinYaw: 0,
    touchdownVerticalSpeedMps: null,
    touchdownOffsetM: null,
    impactEvent: null,
  };

  private landingVerdict: LandingVerdict = "NONE";
  private crashEvent: CrashEvent | null = null;
  private touchdownVerticalSpeedMps: number | null = null;
  private touchdownOffsetM: number | null = null;
  private touchdownTiltDeg: number | null = null;
  private faultConfig: FaultConfig = createDefaultFaultConfig();
  private gLoad = 0;
  private timeWarp: TimeWarp = 1;

  constructor(
    planetId: PlanetId = "mars",
    padDeckY = 2.2,
    initialMode: MissionMode = "launch"
  ) {
    this.planet = getPlanetConfig(planetId);
    this.terrainNoise = new SeededNoise2D(this.planet.terrain.seed);
    this.padDeckY = padDeckY;
    this.missionMode = initialMode;
    this.reset(planetId, padDeckY, initialMode);
  }

  setFaultConfig(cfg: Partial<FaultConfig>): void {
    this.faultConfig = sanitizeFaultConfig({ ...this.faultConfig, ...cfg });
  }

  getFaultConfig(): FaultConfig {
    return { ...this.faultConfig };
  }

  resetFaults(): void {
    this.faultConfig = createDefaultFaultConfig();
  }

  /** Returns IMU-faulted sensed telemetry without modifying ground-truth physics state. */
  getSensedTelemetry(pitchNoiseSample = 0, rollNoiseSample = 0): FlightTelemetry {
    return applySensorFaultsToTelemetry(
      this.getTelemetry(),
      this.faultConfig,
      pitchNoiseSample,
      rollNoiseSample
    );
  }

  reset(
    planetId: PlanetId = this.planet.id,
    padDeckY: number = this.padDeckY,
    missionMode: MissionMode = this.missionMode
  ): void {
    this.planet = getPlanetConfig(planetId);
    this.terrainNoise = new SeededNoise2D(this.planet.terrain.seed);
    this.padDeckY = padDeckY;
    this.missionMode = missionMode;
    this.running = false;
    this.paused = false;
    this.accumulator = 0;
    this.missionTimeSec = 0;

    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitchVel = 0;
    this.yawVel = 0;
    this.rollVel = 0;
    this.rcsThrust = { pitch: 0, yaw: 0, roll: 0 };

    this.throttle = 0;
    this.boosterThrottle = 0;
    this.shipThrottle = 0;
    this.gimbalX = 0;
    this.gimbalZ = 0;
    this.gridFinPitch = 0;
    this.gridFinYaw = 0;

    this.dynamicPressurePa = 0;
    this.prevDynamicPressurePa = 0;
    this.maxQPa = 0;
    this.maxQReached = false;
    this.mach = 0;

    this.landingVerdict = "NONE";
    this.crashEvent = null;
    this.touchdownVerticalSpeedMps = null;
    this.touchdownOffsetM = null;
    this.touchdownTiltDeg = null;
    this.timeWarp = 1;
    this.stageSepElapsedSec = 0;
    this.boosterFlipTimerSec = 0;
    this.catchCarriageY = BOOSTER_CATCH_CARRIAGE_LAUNCH_Y;

    if (missionMode === "launch") {
      this.phase = "PRELAUNCH";
      this.hasLiftedOff = false;
      this.tClockSec = -10;
      this.pos = { x: 0, y: padDeckY, z: 0 };
      this.pitch = 0;
      this.roll = 0;
      this.boosterFuel = 1.0;
      this.shipFuel = 1.0;
      this.stageSeparated = false;
      this.frostLevel = 1.0;
      this.umbilicalRetracted = 0.0;
      this.catchArmsOpen = 0.18;
      this.flapAngleRad = 0.05;
      this.landingLegsDeployed = 0.0;
      this.targetLandingLegs = 0.0;
      this.booster = {
        active: false,
        status: "ATTACHED",
        position: { x: 0, y: padDeckY, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        pitch: 0,
        yaw: 0,
        roll: 0,
        throttle: 0,
        fuel: 1.0,
        altitudeM: 0,
        verticalSpeedMps: 0,
        padOffsetM: 0,
        gridFinPitch: 0,
        gridFinYaw: 0,
        touchdownVerticalSpeedMps: null,
        touchdownOffsetM: null,
        impactEvent: null,
      };
    } else {
      this.phase = this.planet.physics.airDensityKgM3 > 0 ? "DESCENT" : "FLIP_BURN";
      this.hasLiftedOff = true;
      this.tClockSec = 0;
      this.pos = { x: 85, y: padDeckY + 900, z: 24 };
      this.vel = { x: -7.5, y: -34, z: -2.2 };
      this.boosterFuel = 0.0;
      this.shipFuel = 0.72;
      this.stageSeparated = true;
      this.frostLevel = 0.25;
      this.umbilicalRetracted = 1.0;
      this.catchArmsOpen = 0.85;
      this.booster = {
        active: false,
        status: "NONE",
        position: { x: 0, y: padDeckY, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        pitch: 0,
        yaw: 0,
        roll: 0,
        throttle: 0,
        fuel: 0,
        altitudeM: 0,
        verticalSpeedMps: 0,
        padOffsetM: 0,
        gridFinPitch: 0,
        gridFinYaw: 0,
        touchdownVerticalSpeedMps: null,
        touchdownOffsetM: null,
        impactEvent: null,
      };
      if (this.planet.physics.airDensityKgM3 > 0) {
        this.pitch = 74 * DEG_TO_RAD;
        this.roll = -4 * DEG_TO_RAD;
        this.flapAngleRad = 1.05;
        this.landingLegsDeployed = 0.0;
        this.targetLandingLegs = 0.0;
      } else {
        this.pitch = 10 * DEG_TO_RAD;
        this.roll = -3 * DEG_TO_RAD;
        this.flapAngleRad = 0.15;
        this.landingLegsDeployed = 1.0;
        this.targetLandingLegs = 1.0;
      }
    }
  }

  setMissionMode(mode: MissionMode): void {
    this.reset(this.planet.id, this.padDeckY, mode);
  }

  setControlMode(mode: ControlMode): void {
    this.controlMode = mode;
  }

  setTimeWarp(warp: TimeWarp): void {
    this.timeWarp = warp;
  }

  getTimeWarp(): TimeWarp {
    return this.timeWarp;
  }

  setSasEnabled(enabled: boolean): void {
    this.sasEnabled = enabled;
  }

  toggleSas(): boolean {
    this.sasEnabled = !this.sasEnabled;
    return this.sasEnabled;
  }

  startMission(): void {
    if (this.isTerminalPhase()) {
      this.reset(this.planet.id, this.padDeckY, this.missionMode);
    }
    this.running = true;
    this.paused = false;
    if (this.missionMode === "launch" && this.phase === "PRELAUNCH") {
      this.phase = "COUNTDOWN";
    }
  }

  togglePause(): boolean {
    if (!this.running) {
      return this.paused;
    }
    this.paused = !this.paused;
    return this.paused;
  }

  toggleLandingLegs(): void {
    this.targetLandingLegs = this.targetLandingLegs > 0.5 ? 0.0 : 1.0;
  }

  triggerStageSeparation(): boolean {
    if (
      this.missionMode !== "launch" ||
      this.stageSeparated ||
      this.phase === "PRELAUNCH" ||
      this.phase === "COUNTDOWN" ||
      this.isTerminalPhase()
    ) {
      return false;
    }
    this.stageSeparated = true;
    this.phase = "STAGE_SEP";
    this.stageSepElapsedSec = 0;
    this.boosterFlipTimerSec = 0;

    const R = this.planet.scale.simRadiusM;
    const rx = this.pos.x;
    const ry = this.pos.y + R;
    const rz = this.pos.z;
    const rMag = Math.max(1, Math.hypot(rx, ry, rz));
    const ux = rx / rMag;
    const uy = ry / rMag;
    const uz = rz / rMag;
    const eHorizMag = Math.hypot(uy, ux);
    const ex = eHorizMag > 1e-6 ? uy / eHorizMag : 1;
    const ey = eHorizMag > 1e-6 ? -ux / eHorizMag : 0;

    const surfR = this.getSurfaceRadiusAt(this.pos.x, this.pos.y, this.pos.z);
    const sepAlt = Math.max(0, rMag - surfR);
    const vRad = this.vel.x * ux + this.vel.y * uy + this.vel.z * uz;

    this.booster = {
      active: true,
      status: "BOOSTER_FLIP",
      position: { ...this.pos },
      velocity: {
        x: this.vel.x - 1.5 * ex - 5.0 * ux,
        y: this.vel.y - 1.5 * ey - 5.0 * uy,
        z: this.vel.z - 5.0 * uz,
      },
      pitch: this.pitch,
      yaw: this.yaw,
      roll: this.roll,
      throttle: 0,
      fuel: this.boosterFuel,
      altitudeM: sepAlt,
      verticalSpeedMps: vRad,
      padOffsetM: Math.hypot(this.pos.x, this.pos.z),
      gridFinPitch: 0,
      gridFinYaw: 0,
      touchdownVerticalSpeedMps: null,
      touchdownOffsetM: null,
      impactEvent: null,
    };

    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    this.pos.x += sinP * 71;
    this.pos.y += cosP * Math.cos(this.roll) * 71;
    this.pos.z += cosP * Math.sin(this.roll) * 71;
    this.boosterThrottle = 0;
    return true;
  }

  update(
    dt: number,
    manualInput?: ManualInputState,
    aiAction?: AIActionInput
  ): FlightTelemetry {
    const safeDt = clamp(dt, 0, 0.1) * this.timeWarp;
    if (this.running && !this.paused && !this.isTerminalPhase()) {
      this.accumulator += safeDt;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < 64) {
        this.stepFixed(FIXED_DT, manualInput, aiAction);
        this.accumulator -= FIXED_DT;
        steps += 1;
        if (this.isTerminalPhase()) {
          this.accumulator = 0;
          break;
        }
      }
    }
    return this.getTelemetry();
  }

  /** Executes a single deterministic fixed-dt step directly (for RL / Web Worker rollouts). */
  stepFixedDirect(dt = FIXED_DT, aiAction?: AIActionInput): FlightTelemetry {
    if (this.running && !this.paused && !this.isTerminalPhase()) {
      this.stepFixed(dt, undefined, aiAction);
    }
    return this.getTelemetry();
  }

  /** Configures deterministic or domain-randomized initial spawn state for RL episodes. */
  configureRLSpawn(overrides: RLSpawnOverrides): void {
    const planetId = overrides.planetId ?? this.planet.id;
    const padDeckY = overrides.padDeckY ?? this.padDeckY;
    const mode = overrides.missionMode ?? this.missionMode;
    this.reset(planetId, padDeckY, mode);

    if (overrides.position) {
      this.pos = { ...overrides.position };
    }
    if (overrides.velocity) {
      this.vel = { ...overrides.velocity };
    }
    if (overrides.pitch !== undefined) {
      this.pitch = overrides.pitch;
    }
    if (overrides.roll !== undefined) {
      this.roll = overrides.roll;
    }
    if (overrides.yaw !== undefined) {
      this.yaw = overrides.yaw;
    }
    if (overrides.shipFuel !== undefined) {
      this.shipFuel = clamp(overrides.shipFuel, 0, 1);
    }
    if (overrides.boosterFuel !== undefined) {
      this.boosterFuel = clamp(overrides.boosterFuel, 0, 1);
    }
    if (overrides.phase !== undefined) {
      this.phase = overrides.phase;
    }
    if (overrides.running !== undefined) {
      this.running = overrides.running;
    }
    if (overrides.hasLiftedOff !== undefined) {
      this.hasLiftedOff = overrides.hasLiftedOff;
    }
    if (overrides.stageSeparated !== undefined) {
      this.stageSeparated = overrides.stageSeparated;
    }
    if (overrides.landingLegsDeployed !== undefined) {
      this.landingLegsDeployed = overrides.landingLegsDeployed;
    }
    if (overrides.targetLandingLegs !== undefined) {
      this.targetLandingLegs = overrides.targetLandingLegs;
    }
    if (overrides.flapAngleRad !== undefined) {
      this.flapAngleRad = overrides.flapAngleRad;
    }
    if (overrides.frostLevel !== undefined) {
      this.frostLevel = overrides.frostLevel;
    }
    if (overrides.umbilicalRetracted !== undefined) {
      this.umbilicalRetracted = overrides.umbilicalRetracted;
    }
    if (overrides.catchArmsOpen !== undefined) {
      this.catchArmsOpen = overrides.catchArmsOpen;
    }
  }

  private isTerminalPhase(): boolean {
    return (
      this.phase === "TOUCHDOWN" ||
      this.phase === "CRASHED" ||
      this.phase === "COMPLETE"
    );
  }

  private getPadLandingRadiusM(): number {
    if (this.planet.id === "earth") {
      return 26;
    }
    if (this.planet.id === "mars") {
      return 44;
    }
    return 41;
  }

  private getTowerSpec(): { x: number; height: number } {
    if (this.planet.id === "earth") {
      return { x: -23, height: 145 };
    }
    if (this.planet.id === "mars") {
      return { x: -19, height: 84 };
    }
    return { x: -18, height: 62 };
  }

  /** Returns surface elevation (pad deck inside pad radius, 0 on apron, terrain outside 65m). */
  getSurfaceHeightAt(x: number, z: number): number {
    const r = Math.hypot(x, z);
    if (r <= this.getPadLandingRadiusM()) {
      return this.padDeckY;
    }
    if (r <= PAD_FLAT_RADIUS_M) {
      return 0;
    }
    return samplePlanetTerrainHeight(x, z, this.planet, this.terrainNoise);
  }

  /** Returns surface radius from planet center (0, -R, 0), matching pad/terrain near zenith and R globally. */
  private getSurfaceRadiusAt(x: number, y: number, z: number): number {
    const R = this.planet.scale.simRadiusM;
    const ry = y + R;
    if (ry > 0) {
      const horiz = Math.hypot(x, z);
      if (horiz <= this.planet.scale.localTerrainRadiusM * 0.96) {
        const surfaceY = this.getSurfaceHeightAt(x, z);
        return Math.hypot(x, surfaceY + R, z);
      }
    }
    return R;
  }

  private getLaunchRadialState(): {
    rx: number;
    ry: number;
    rz: number;
    rMag: number;
    ux: number;
    uy: number;
    uz: number;
    surfaceRadiusM: number;
    altitudeM: number;
    vRadial: number;
  } {
    const R = this.planet.scale.simRadiusM;
    const rx = this.pos.x;
    const ry = this.pos.y + R;
    const rz = this.pos.z;
    const rMag = Math.max(1, Math.hypot(rx, ry, rz));
    const ux = rx / rMag;
    const uy = ry / rMag;
    const uz = rz / rMag;
    const surfaceRadiusM = this.getSurfaceRadiusAt(this.pos.x, this.pos.y, this.pos.z);
    const altitudeM = Math.max(0, rMag - surfaceRadiusM);
    const vRadial = this.vel.x * ux + this.vel.y * uy + this.vel.z * uz;
    return { rx, ry, rz, rMag, ux, uy, uz, surfaceRadiusM, altitudeM, vRadial };
  }

  private sampleAirDensity(altitudeM: number): number {
    const rho0 = this.planet.physics.airDensityKgM3;
    const hScaleKm = this.planet.physics.atmosphereScaleHeightKm;
    if (rho0 <= 0 || hScaleKm <= 0) {
      return 0;
    }
    const atmoTop = this.planet.scale.atmosphereTopM;
    if (atmoTop > 0 && altitudeM >= atmoTop) {
      return 0;
    }
    const baseRho = rho0 * Math.exp(-Math.max(0, altitudeM) / (hScaleKm * 1000));
    if (atmoTop > 0 && altitudeM > atmoTop * 0.55) {
      return baseRho * (1 - smoothstep(atmoTop * 0.55, atmoTop, altitudeM));
    }
    return baseRho;
  }

  private stepFixed(
    dt: number,
    manualInput?: ManualInputState,
    aiAction?: AIActionInput
  ): void {
    this.missionTimeSec += dt;
    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);

    let altM: number;
    let rho: number;
    if (this.missionMode === "launch") {
      const radial = this.getLaunchRadialState();
      altM = radial.altitudeM;
      rho = this.sampleAirDensity(Math.max(0, radial.rMag - (this.planet.scale.simRadiusM + this.padDeckY)));
    } else {
      const surfaceY = this.getSurfaceHeightAt(this.pos.x, this.pos.z);
      altM = Math.max(0, this.pos.y - surfaceY);
      rho = this.sampleAirDensity(Math.max(0, this.pos.y - this.padDeckY));
    }

    this.prevDynamicPressurePa = this.dynamicPressurePa;
    this.dynamicPressurePa = 0.5 * rho * speed * speed;
    if (this.dynamicPressurePa > this.maxQPa) {
      this.maxQPa = this.dynamicPressurePa;
    }
    if (
      !this.maxQReached &&
      this.maxQPa > 120 &&
      this.dynamicPressurePa < this.prevDynamicPressurePa * 0.985 &&
      altM > 200
    ) {
      this.maxQReached = true;
    }
    this.mach = rho > 0 ? speed / 340 : 0;

    if (this.missionMode === "launch") {
      this.stepLaunchMode(dt, altM, rho, manualInput, aiAction);
    } else {
      this.stepLandingMode(dt, altM, rho, manualInput, aiAction);
    }

    this.landingLegsDeployed = approach(
      this.landingLegsDeployed,
      this.targetLandingLegs,
      dt / 1.4
    );

    if (this.phase !== "PRELAUNCH" && this.phase !== "COUNTDOWN") {
      if (this.missionMode === "launch") {
        const radial = this.getLaunchRadialState();
        if (radial.rMag - (this.planet.scale.simRadiusM + this.padDeckY) > 1.5) {
          this.hasLiftedOff = true;
        }
      } else if (this.pos.y - this.padDeckY > 1.5) {
        this.hasLiftedOff = true;
      }
      this.evaluateHazardAndSurfaceContact();
    }

    this.stepDetachedBooster(dt);
  }

  private stepDetachedBooster(dt: number): void {
    if (!this.booster.active) {
      return;
    }
    const b = this.booster;
    const g0 = this.planet.physics.gravityMps2;
    const R = this.planet.scale.simRadiusM;
    const mu = computeGravitationalParameter(g0, R);

    const rx = b.position.x;
    const ry = b.position.y + R;
    const rz = b.position.z;
    const rMag = Math.max(1, Math.hypot(rx, ry, rz));
    const ux = rx / rMag;
    const uy = ry / rMag;
    const uz = rz / rMag;
    const gEff = mu / (rMag * rMag);

    const surfaceR = this.getSurfaceRadiusAt(b.position.x, b.position.y, b.position.z);
    const bAlt = Math.max(0, rMag - surfaceR);
    const vRad = b.velocity.x * ux + b.velocity.y * uy + b.velocity.z * uz;
    const bRho = this.sampleAirDensity(bAlt);
    const bSpeed = Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z);
    const padOffset = Math.hypot(b.position.x, b.position.z);

    b.altitudeM = bAlt;
    b.verticalSpeedMps = vRad;
    b.padOffsetM = padOffset;

    const hPad = Math.max(10, b.position.y - this.padDeckY);
    const tFlight =
      (b.velocity.y +
        Math.sqrt(Math.max(0, b.velocity.y * b.velocity.y + 2 * gEff * hPad))) /
      Math.max(0.5, gEff);

    let targetThrottle = 0;
    let finAx = 0;
    let finAz = 0;
    b.gridFinPitch = 0;
    b.gridFinYaw = 0;

    if (b.status === "BOOSTER_FLIP") {
      this.boosterFlipTimerSec += dt;
      const toPadYawAngle = Math.atan2(-b.position.x, Math.max(50, b.position.y));
      const targetPitch = clamp(toPadYawAngle - 0.85, -Math.PI * 0.56, -Math.PI * 0.35);
      b.pitch = approachAngle(b.pitch, targetPitch, dt * 1.8);
      b.roll = approach(b.roll, 0, dt * 1.4);
      targetThrottle = 0;
      if (this.boosterFlipTimerSec >= 2.2 || b.fuel <= 0.075) {
        b.status = b.fuel > 0.075 ? "BOOSTER_BOOSTBACK" : "BOOSTER_DESCENT";
      }
    } else if (b.status === "BOOSTER_BOOSTBACK") {
      const dragHorizScale =
        this.planet.id === "earth" ? 0.72 : this.planet.id === "mars" ? 0.94 : 1.0;
      const effT = Math.max(3.5, tFlight * dragHorizScale);
      const desVx = clamp(-b.position.x / effT, -280, 280);
      const desVz = clamp(-b.position.z / effT, -280, 280);
      const errVx = desVx - b.velocity.x;
      const errVz = desVz - b.velocity.z;
      const errMag = Math.hypot(errVx, errVz);

      // Pure horizontal boostback with minimal fractional loft proportional to error
      const aimY = Math.min(4.0, errMag * 0.08);
      const aimMag = Math.max(1e-3, Math.hypot(errVx, aimY, errVz));
      const targetPitch = Math.atan2(errVx / aimMag, aimY / aimMag);
      const targetRoll = Math.atan2(errVz / aimMag, aimY / aimMag) * 0.5;
      b.pitch = approachAngle(b.pitch, targetPitch, dt * 2.8);
      b.roll = approach(b.roll, targetRoll, dt * 2.4);

      const alignErr = Math.abs(wrapAngle(targetPitch - b.pitch));
      if (alignErr < 0.75 && b.fuel > 0.075 && errMag >= 6) {
        targetThrottle = clamp(errMag / 22, 0.1, 1.0);
      }

      const predX = b.position.x + b.velocity.x * effT;
      const predZ = b.position.z + b.velocity.z * effT;
      if (
        errMag < 6 ||
        Math.hypot(predX, predZ) < 40 ||
        b.fuel <= 0.075 ||
        (b.velocity.y < -15 && bAlt < 2500)
      ) {
        targetThrottle = 0;
        b.status = "BOOSTER_DESCENT";
      }
    } else if (b.status === "BOOSTER_DESCENT") {
      targetThrottle = 0;
      const tiltGainX = clamp((-b.position.x / Math.max(400, bAlt)) * 0.32, -0.32, 0.32);
      const tiltGainZ = clamp((-b.position.z / Math.max(400, bAlt)) * 0.32, -0.32, 0.32);
      b.pitch = approachAngle(b.pitch, tiltGainX, dt * 1.6);
      b.roll = approach(b.roll, tiltGainZ, dt * 1.6);

      const tToGround =
        b.velocity.y < -4
          ? clamp((bAlt - 180) / Math.max(10, -b.velocity.y), 1.5, 65)
          : Math.max(6, tFlight);
      const desVx = clamp(-b.position.x / Math.max(2.0, tToGround * 0.82), -160, 160);
      const desVz = clamp(-b.position.z / Math.max(2.0, tToGround * 0.82), -160, 160);
      const maxFinAccel =
        this.planet.id === "earth" ? 16.0 : this.planet.id === "mars" ? 14.0 : 12.0;
      finAx = clamp((desVx - b.velocity.x) * 1.2, -maxFinAccel, maxFinAccel);
      finAz = clamp((desVz - b.velocity.z) * 1.2, -maxFinAccel, maxFinAccel);
      b.gridFinPitch = clamp(finAx / maxFinAccel, -1, 1);
      b.gridFinYaw = clamp(finAz / maxFinAccel, -1, 1);

      if (b.velocity.y < -2 && b.fuel > 0.002) {
        const aStop = Math.max(6.0, BOOSTER_RTLS_MAX_ACCEL * 0.7 - gEff);
        const stopDist = (b.velocity.y * b.velocity.y) / (2 * aStop);
        const triggerAlt = Math.max(
          420,
          stopDist * 1.48 + 180 + Math.min(450, padOffset * 0.35)
        );
        if (bAlt <= triggerAlt) {
          b.status = "BOOSTER_LANDING_BURN";
        }
      }
    } else if (b.status === "BOOSTER_LANDING_BURN") {
      const hRemain = Math.max(0, b.position.y - this.padDeckY);
      const timeToGo = clamp(hRemain / Math.max(4, -b.velocity.y + 2.5), 0.55, 28);
      const targetVx = clamp(-b.position.x / Math.max(1.2, timeToGo * 0.65), -58, 58);
      const targetVz = clamp(-b.position.z / Math.max(1.2, timeToGo * 0.65), -58, 58);

      const maxTilt = hRemain < 22 ? 0.05 : hRemain < 75 ? 0.16 : 0.44;
      const desiredPitch = clamp((targetVx - b.velocity.x) * 0.09, -maxTilt, maxTilt);
      const desiredRoll = clamp((targetVz - b.velocity.z) * 0.09, -maxTilt, maxTilt);
      b.pitch = approachAngle(b.pitch, desiredPitch, dt * 3.6);
      b.roll = approach(b.roll, desiredRoll, dt * 3.6);
      b.gridFinPitch = clamp((desiredPitch - b.pitch) * 2.0, -0.7, 0.7);
      b.gridFinYaw = clamp((desiredRoll - b.roll) * 2.0, -0.7, 0.7);

      const safeDecel = Math.max(6.0, BOOSTER_RTLS_MAX_ACCEL * 0.62 - gEff);
      const targetVy =
        hRemain > 14
          ? -clamp(1.4 + Math.sqrt(2 * safeDecel * hRemain * 0.56), 1.8, 165)
          : -1.4;
      const cosTilt = Math.max(0.55, Math.cos(b.pitch) * Math.cos(b.roll));
      const desiredVertAccel = gEff + (targetVy - b.velocity.y) * 3.6;
      targetThrottle =
        b.fuel > 0 ? clamp(desiredVertAccel / (cosTilt * BOOSTER_RTLS_MAX_ACCEL), 0.04, 1.0) : 0;
    }

    b.throttle = b.fuel > 0 ? approach(b.throttle, targetThrottle, dt * 5.0) : 0;
    const thrustAccel = b.throttle * BOOSTER_RTLS_MAX_ACCEL;
    b.fuel = Math.max(0, b.fuel - b.throttle * BOOSTER_RTLS_BURN_RATE * dt);
    this.boosterFuel = b.fuel;

    // Lower Mechazilla carriage & close chopsticks cleanly as booster returns to Starbase Earth
    if (
      this.planet.id === "earth" &&
      (b.status === "BOOSTER_DESCENT" || b.status === "BOOSTER_LANDING_BURN")
    ) {
      this.catchCarriageY = approach(
        this.catchCarriageY,
        BOOSTER_CATCH_CARRIAGE_CATCH_Y,
        dt * 5.5
      );
      if (bAlt < 65 && padOffset < 35) {
        this.catchArmsOpen = approach(this.catchArmsOpen, 0.14, dt * 1.1);
      }
    }

    const sinP = Math.sin(b.pitch);
    const cosP = Math.cos(b.pitch);
    const dirX = sinP;
    const dirY = cosP * Math.cos(b.roll);
    const dirZ = cosP * Math.sin(b.roll);

    const dragDecel = bRho > 0 ? 0.00024 * bRho * bSpeed : 0;
    const gravFac = -mu / (rMag * rMag * rMag);

    b.velocity.x += (rx * gravFac + dirX * thrustAccel + finAx - dragDecel * b.velocity.x) * dt;
    b.velocity.y += (ry * gravFac + dirY * thrustAccel - dragDecel * b.velocity.y) * dt;
    b.velocity.z += (rz * gravFac + dirZ * thrustAccel + finAz - dragDecel * b.velocity.z) * dt;

    b.position.x += b.velocity.x * dt;
    b.position.y += b.velocity.y * dt;
    b.position.z += b.velocity.z * dt;

    const nRx = b.position.x;
    const nRy = b.position.y + R;
    const nRz = b.position.z;
    const nRMag = Math.max(1, Math.hypot(nRx, nRy, nRz));
    const nextSurfaceR = this.getSurfaceRadiusAt(b.position.x, b.position.y, b.position.z);
    const postPadDist = Math.hypot(b.position.x, b.position.z);
    const touchPadPlane =
      postPadDist <= 26 && b.position.y <= this.padDeckY && b.velocity.y <= 0;

    if (nRMag <= nextSurfaceR || touchPadPlane) {
      const impactVy = Math.abs(b.velocity.y);
      const impactHoriz = Math.hypot(b.velocity.x, b.velocity.z);
      const impactSpeed = Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z);
      const tiltDeg = Math.hypot(b.pitch, b.roll) * RAD_TO_DEG;

      if (touchPadPlane) {
        b.position.y = this.padDeckY;
      } else {
        const scale = nextSurfaceR / nRMag;
        b.position.x = nRx * scale;
        b.position.y = nRy * scale - R;
        b.position.z = nRz * scale;
      }

      const finalPadDist = Math.hypot(b.position.x, b.position.z);
      b.altitudeM = 0;
      b.verticalSpeedMps = 0;
      b.padOffsetM = finalPadDist;
      b.touchdownVerticalSpeedMps = impactVy;
      b.touchdownOffsetM = finalPadDist;
      b.velocity = { x: 0, y: 0, z: 0 };
      b.throttle = 0;
      b.active = false;

      if (finalPadDist <= 25 && impactVy <= 5.0 && impactHoriz <= 3.5 && tiltDeg <= 15.0) {
        b.status = this.planet.id === "earth" ? "BOOSTER_CAUGHT" : "BOOSTER_LANDED";
        b.pitch = 0;
        b.roll = 0;
        b.gridFinPitch = 0;
        b.gridFinYaw = 0;
        if (this.planet.id === "earth") {
          this.catchArmsOpen = 0.02;
          this.catchCarriageY = BOOSTER_CATCH_CARRIAGE_CATCH_Y;
        }
      } else {
        b.status = "BOOSTER_CRASHED";
        b.impactEvent = {
          id: ++this.eventSeq,
          position: { ...b.position },
          velocity: { x: 0, y: -impactVy, z: 0 },
          impactSpeedMps: impactSpeed,
          impactEnergyJ: 0.5 * 850_000 * impactSpeed * impactSpeed,
          remainingFuelRatio: b.fuel,
          cause: "SURFACE_IMPACT",
          timestampSec: this.missionTimeSec,
        };
      }
    }
  }

  private evaluateHazardAndSurfaceContact(): void {
    if (this.isTerminalPhase()) {
      return;
    }
    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);

    // 1. Launch tower collision check (local near pad)
    const tower = this.getTowerSpec();
    if (
      this.hasLiftedOff &&
      this.pos.y >= -10 &&
      this.pos.y < tower.height &&
      Math.abs(this.pos.x - tower.x) < 6.5 &&
      Math.abs(this.pos.z) < 6.5 &&
      speed > 8.0
    ) {
      this.triggerCrashRUD("LAUNCH_TOWER_COLLISION", speed);
      return;
    }

    // 2. Aerodynamic structural over-stress at extreme dynamic pressure + AoA
    if (this.dynamicPressurePa > 45_000 && speed > 40) {
      const noseX = Math.sin(this.pitch);
      const noseY = Math.cos(this.pitch) * Math.cos(this.roll);
      const noseZ = Math.cos(this.pitch) * Math.sin(this.roll);
      const dot = clamp(
        (noseX * this.vel.x + noseY * this.vel.y + noseZ * this.vel.z) / speed,
        -1,
        1
      );
      const aoaDeg = Math.acos(dot) * RAD_TO_DEG;
      if (aoaDeg > 34) {
        this.triggerCrashRUD("AERO_OVERSTRESS", speed);
        return;
      }
    }

    // 3. Surface contact check: radial around sphere in launch mode, local tangent in landing mode
    if (this.missionMode === "launch") {
      const { rx, ry, rz, rMag, ux, uy, uz, surfaceRadiusM, vRadial } =
        this.getLaunchRadialState();
      const noseX = Math.sin(this.pitch);
      const noseY = Math.cos(this.pitch) * Math.cos(this.roll);
      const noseZ = Math.cos(this.pitch) * Math.sin(this.roll);
      const noseDotUp = clamp(noseX * ux + noseY * uy + noseZ * uz, -1, 1);
      const localTiltDeg = Math.acos(noseDotUp) * RAD_TO_DEG;

      if (this.hasLiftedOff && rMag <= surfaceRadiusM && (vRadial <= 0 || localTiltDeg > 35)) {
        const impactVy = Math.abs(vRadial);
        const impactHoriz = Math.sqrt(Math.max(0, speed * speed - vRadial * vRadial));
        const scale = surfaceRadiusM / rMag;
        this.pos.x = rx * scale;
        this.pos.y = ry * scale - this.planet.scale.simRadiusM;
        this.pos.z = rz * scale;

        const offsetM = Math.hypot(this.pos.x, this.pos.z);
        const withinPad = uy > 0.99 && offsetM <= this.getPadLandingRadiusM();
        this.touchdownVerticalSpeedMps = impactVy;
        this.touchdownOffsetM = offsetM;
        this.touchdownTiltDeg = localTiltDeg;

        if (impactVy <= 4.5 && impactHoriz <= 2.5 && localTiltDeg <= 12.0 && withinPad) {
          this.vel = { x: 0, y: 0, z: 0 };
          this.pitchVel = 0;
          this.yawVel = 0;
          this.rollVel = 0;
          this.pitch = 0;
          this.roll = 0;
          this.throttle = 0;
          this.boosterThrottle = 0;
          this.shipThrottle = 0;
          this.rcsThrust = { pitch: 0, yaw: 0, roll: 0 };
          this.phase = "TOUCHDOWN";
          this.running = false;
          this.landingVerdict = "NOMINAL LANDING";
        } else if (impactVy <= 9.0 && impactHoriz <= 5.0 && localTiltDeg <= 22.0) {
          this.vel = { x: 0, y: 0, z: 0 };
          this.pitchVel = 0;
          this.yawVel = 0;
          this.rollVel = 0;
          this.throttle = 0;
          this.boosterThrottle = 0;
          this.shipThrottle = 0;
          this.rcsThrust = { pitch: 0, yaw: 0, roll: 0 };
          this.phase = "TOUCHDOWN";
          this.running = false;
          this.landingVerdict = "HARD LANDING";
        } else {
          const cause: CrashCause =
            localTiltDeg > 35 && impactVy <= 9.0 ? "TIP_OVER" : "SURFACE_IMPACT";
          this.triggerCrashRUD(cause, speed);
        }
      }
      return;
    }

    const surfaceY = this.getSurfaceHeightAt(this.pos.x, this.pos.z);
    const tiltDeg = Math.hypot(this.pitch, this.roll) * RAD_TO_DEG;

    if (this.hasLiftedOff && this.pos.y <= surfaceY && (this.vel.y <= 0 || tiltDeg > 35)) {
      const impactVy = Math.abs(this.vel.y);
      const impactHoriz = Math.hypot(this.vel.x, this.vel.z);
      const impactSpeed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
      const offsetM = Math.hypot(this.pos.x, this.pos.z);
      const withinPad = offsetM <= this.getPadLandingRadiusM();
      const legsOk = this.landingLegsDeployed >= 0.7;

      this.pos.y = surfaceY;
      this.touchdownVerticalSpeedMps = impactVy;
      this.touchdownOffsetM = offsetM;
      this.touchdownTiltDeg = tiltDeg;

      if (
        impactVy <= 4.5 &&
        impactHoriz <= 2.5 &&
        tiltDeg <= 12.0 &&
        withinPad &&
        legsOk
      ) {
        this.vel = { x: 0, y: 0, z: 0 };
        this.pitchVel = 0;
        this.yawVel = 0;
        this.rollVel = 0;
        this.pitch = 0;
        this.roll = 0;
        this.throttle = 0;
        this.boosterThrottle = 0;
        this.shipThrottle = 0;
        this.rcsThrust = { pitch: 0, yaw: 0, roll: 0 };
        this.phase = "TOUCHDOWN";
        this.running = false;
        this.landingVerdict = "NOMINAL LANDING";
      } else if (impactVy <= 9.0 && impactHoriz <= 5.0 && tiltDeg <= 22.0) {
        this.vel = { x: 0, y: 0, z: 0 };
        this.pitchVel = 0;
        this.yawVel = 0;
        this.rollVel = 0;
        this.throttle = 0;
        this.boosterThrottle = 0;
        this.shipThrottle = 0;
        this.rcsThrust = { pitch: 0, yaw: 0, roll: 0 };
        this.phase = "TOUCHDOWN";
        this.running = false;
        this.landingVerdict = "HARD LANDING";
      } else {
        const cause: CrashCause =
          tiltDeg > 35 && impactVy <= 9.0 ? "TIP_OVER" : "SURFACE_IMPACT";
        this.triggerCrashRUD(cause, impactSpeed);
      }
    }
  }

  private triggerCrashRUD(cause: CrashCause, impactSpeedMps: number): void {
    const activeMass = this.stageSeparated ? SHIP_MASS_KG : STACK_DRY_AND_WET_MASS_KG;
    const fuelRatio = this.stageSeparated
      ? this.shipFuel
      : 0.65 * this.boosterFuel + 0.35 * this.shipFuel;

    this.crashEvent = {
      id: ++this.eventSeq,
      position: { ...this.pos },
      velocity: { ...this.vel },
      impactSpeedMps,
      impactEnergyJ: 0.5 * activeMass * impactSpeedMps * impactSpeedMps,
      remainingFuelRatio: clamp(fuelRatio, 0.05, 1.0),
      cause,
      timestampSec: this.missionTimeSec,
    };

    this.vel = { x: 0, y: 0, z: 0 };
    this.pitchVel = 0;
    this.yawVel = 0;
    this.rollVel = 0;
    this.throttle = 0;
    this.boosterThrottle = 0;
    this.shipThrottle = 0;
    this.rcsThrust = { pitch: 0, yaw: 0, roll: 0 };
    this.phase = "CRASHED";
    this.running = false;
    this.timeWarp = 1;
    this.landingVerdict = "CRASH_RUD";
  }

  private applyManualRotationAndThrottle(
    dt: number,
    input: ManualInputState,
    activeThrottle: number
  ): void {
    if (input.throttleSet !== null) {
      this.throttle = clamp(input.throttleSet, 0, 1);
    } else if (input.throttleDelta !== 0) {
      this.throttle = clamp(this.throttle + input.throttleDelta * 1.15 * dt, 0, 1);
    }

    const rcsPitchYawAccel = 2.15;
    const tvcAuthority = activeThrottle > 0.02 ? 2.4 * activeThrottle : 0;
    const maxPitchRollAccel = rcsPitchYawAccel + tvcAuthority;
    const maxYawAccel = 1.85;
    const targetMaxRate = 1.65;

    const pitchCmd = clamp(input.pitchInput, -1, 1);
    const rollCmd = clamp(input.yawInput, -1, 1);
    const yawCmd = clamp(input.rollInput ?? 0, -1, 1);

    let rcsPitch = 0;
    let rcsRoll = 0;
    let rcsYaw = 0;

    if (Math.abs(pitchCmd) >= 0.05) {
      const targetRate = pitchCmd * targetMaxRate;
      const accel = clamp((targetRate - this.pitchVel) * 9.5, -maxPitchRollAccel, maxPitchRollAccel);
      this.pitchVel += accel * dt;
      rcsPitch = clamp(accel / maxPitchRollAccel, -1, 1);
    } else if (this.sasEnabled) {
      const damp = clamp(-this.pitchVel * 6.5, -maxPitchRollAccel, maxPitchRollAccel);
      this.pitchVel += damp * dt;
      if (Math.abs(this.pitchVel) < 0.005) {
        this.pitchVel = 0;
      }
      rcsPitch = clamp(damp / maxPitchRollAccel, -1, 1);
    }

    if (Math.abs(rollCmd) >= 0.05) {
      const targetRate = rollCmd * targetMaxRate;
      const accel = clamp((targetRate - this.rollVel) * 9.5, -maxPitchRollAccel, maxPitchRollAccel);
      this.rollVel += accel * dt;
      rcsRoll = clamp(accel / maxPitchRollAccel, -1, 1);
    } else if (this.sasEnabled) {
      const damp = clamp(-this.rollVel * 6.5, -maxPitchRollAccel, maxPitchRollAccel);
      this.rollVel += damp * dt;
      if (Math.abs(this.rollVel) < 0.005) {
        this.rollVel = 0;
      }
      rcsRoll = clamp(damp / maxPitchRollAccel, -1, 1);
    }

    if (Math.abs(yawCmd) >= 0.05) {
      const targetRate = yawCmd * 1.45;
      const accel = clamp((targetRate - this.yawVel) * 8.5, -maxYawAccel, maxYawAccel);
      this.yawVel += accel * dt;
      rcsYaw = clamp(accel / maxYawAccel, -1, 1);
    } else if (this.sasEnabled) {
      const damp = clamp(-this.yawVel * 6.0, -maxYawAccel, maxYawAccel);
      this.yawVel += damp * dt;
      if (Math.abs(this.yawVel) < 0.005) {
        this.yawVel = 0;
      }
      rcsYaw = clamp(damp / maxYawAccel, -1, 1);
    }

    this.pitch = clamp(this.pitch + this.pitchVel * dt, -Math.PI * 0.92, Math.PI * 0.92);
    this.roll = clamp(this.roll + this.rollVel * dt, -Math.PI * 0.92, Math.PI * 0.92);
    this.yaw += this.yawVel * dt;

    // ±15 deg (0.2618 rad) physical TVC nozzle swivel
    this.gimbalX = activeThrottle > 0.02 ? clamp(pitchCmd * 0.2618, -0.2618, 0.2618) : 0;
    this.gimbalZ = activeThrottle > 0.02 ? clamp(rollCmd * 0.2618, -0.2618, 0.2618) : 0;
    this.rcsThrust = { pitch: rcsPitch, yaw: rcsYaw, roll: rcsRoll };
  }

  private applyAIAction(
    dt: number,
    input: AIActionInput,
    activeThrottle: number
  ): void {
    this.throttle = clamp(input.throttle, 0, 1);

    const authorityScale = this.faultConfig.tvcLagEnabled ? 0.55 : 1.0;
    const rcsPitchYawAccel = 2.2 * authorityScale;
    const tvcAuthority =
      (activeThrottle > 0.02 ? 2.4 * activeThrottle : 0) * authorityScale;
    const maxPitchRollAccel = rcsPitchYawAccel + tvcAuthority;
    const maxYawAccel = 1.85 * authorityScale;
    const targetMaxRate = 0.95;

    const pitchCmd = clamp(input.pitchCmd, -1, 1);
    const rollCmd = clamp(input.yawCmd, -1, 1);

    const targetPitchRate = pitchCmd * targetMaxRate;
    const pitchAccel = clamp(
      (targetPitchRate - this.pitchVel) * 8.5,
      -maxPitchRollAccel,
      maxPitchRollAccel
    );
    this.pitchVel += pitchAccel * dt;
    const rcsPitch = clamp(pitchAccel / maxPitchRollAccel, -1, 1);

    const targetRollRate = rollCmd * targetMaxRate;
    const rollAccel = clamp(
      (targetRollRate - this.rollVel) * 8.5,
      -maxPitchRollAccel,
      maxPitchRollAccel
    );
    this.rollVel += rollAccel * dt;
    const rcsRoll = clamp(rollAccel / maxPitchRollAccel, -1, 1);

    // Automatically damp longitudinal roll-axis spin (yaw) so 3D AI control stays clean
    const yawDamp = clamp(-this.yawVel * 6.0, -maxYawAccel, maxYawAccel);
    this.yawVel += yawDamp * dt;
    if (Math.abs(this.yawVel) < 0.005) {
      this.yawVel = 0;
    }
    const rcsYaw = clamp(yawDamp / maxYawAccel, -1, 1);

    this.pitch = clamp(this.pitch + this.pitchVel * dt, -Math.PI * 0.78, Math.PI * 0.78);
    this.roll = clamp(this.roll + this.rollVel * dt, -Math.PI * 0.78, Math.PI * 0.78);
    this.yaw += this.yawVel * dt;

    const gimbalSlew = this.faultConfig.tvcLagEnabled ? 0.45 * dt : 10.0;
    this.gimbalX =
      activeThrottle > 0.02
        ? approach(this.gimbalX, clamp(pitchCmd * 0.2618, -0.2618, 0.2618), gimbalSlew)
        : 0;
    this.gimbalZ =
      activeThrottle > 0.02
        ? approach(this.gimbalZ, clamp(rollCmd * 0.2618, -0.2618, 0.2618), gimbalSlew)
        : 0;
    this.rcsThrust = { pitch: rcsPitch, yaw: rcsYaw, roll: rcsRoll };
  }

  /**
   * Computes classical proportional guidance [throttle, pitchCmd, yawCmd] for the current state.
   * Used exclusively by the optional opt-in Behavioral Cloning warm-start before PPO fine-tuning.
   */
  computeClassicalGuidanceAction(): AIActionInput {
    const surfaceY = this.getSurfaceHeightAt(this.pos.x, this.pos.z);
    const altM = Math.max(0, this.pos.y - surfaceY);
    const g = this.planet.physics.gravityMps2;

    if (this.missionMode === "launch") {
      const maxAccelAvailable = this.stageSeparated ? 24.0 : 22.0;
      const desiredNetClimb = this.stageSeparated ? 12.5 : 8.5;
      const throttle = clamp((g + desiredNetClimb) / maxAccelAvailable, 0.28, 1.0);
      const targetPitch = altM < 90 ? 0 : clamp((altM - 90) / 3600, 0, 0.72);
      const pitchCmd = clamp((targetPitch - this.pitch) * 3.0 - this.pitchVel * 0.8, -1, 1);
      const yawCmd = clamp((0 - this.roll) * 3.0 - this.rollVel * 0.8, -1, 1);
      return { throttle, pitchCmd, yawCmd, autoLegs: false };
    }

    const maxShipAccel = 26.0;
    const timeToGo = clamp(altM / Math.max(5, -this.vel.y + 3), 0.7, 22);
    const targetVx = clamp(-this.pos.x / Math.max(1.6, timeToGo * 0.72), -24, 24);
    const targetVz = clamp(-this.pos.z / Math.max(1.6, timeToGo * 0.72), -24, 24);
    const maxTilt = altM < 12 ? 0.06 : altM < 45 ? 0.16 : 0.44;
    const desiredPitch = clamp((targetVx - this.vel.x) * 0.095, -maxTilt, maxTilt);
    const desiredRoll = clamp((targetVz - this.vel.z) * 0.095, -maxTilt, maxTilt);

    const pitchCmd = clamp((desiredPitch - this.pitch) * 3.2 - this.pitchVel * 0.65, -1, 1);
    const yawCmd = clamp((desiredRoll - this.roll) * 3.2 - this.rollVel * 0.65, -1, 1);

    const targetVy = altM > 14 ? -clamp(1.4 + Math.sqrt(altM) * 1.12, 1.8, 42) : -1.4;
    const verticalError = targetVy - this.vel.y;
    const cosTilt = Math.max(0.5, Math.cos(this.pitch) * Math.cos(this.roll));
    const desiredVerticalAccel = g + verticalError * 3.2;
    const throttle = clamp(desiredVerticalAccel / (cosTilt * maxShipAccel), 0.0, 1.0);
    return { throttle, pitchCmd, yawCmd, autoLegs: true };
  }

  private stepLaunchMode(
    dt: number,
    altM: number,
    rho: number,
    manualInput?: ManualInputState,
    aiAction?: AIActionInput
  ): void {
    const g0 = this.planet.physics.gravityMps2;
    const R = this.planet.scale.simRadiusM;
    const atmoTop = this.planet.scale.atmosphereTopM;
    const targetAlt = this.planet.scale.targetOrbitAltM;
    const mu = computeGravitationalParameter(g0, R);

    if (this.phase === "COUNTDOWN") {
      this.tClockSec += dt;
      if (this.tClockSec >= -5) {
        this.umbilicalRetracted = clamp((this.tClockSec + 5) / 3.5, 0, 1);
      }
      if (this.tClockSec >= -2) {
        const spool = clamp((this.tClockSec + 2) / 2.0, 0, 1);
        this.throttle = spool * 0.85;
        this.boosterThrottle = this.throttle;
        this.frostLevel = clamp(1.0 - spool * 0.12, 0, 1);
      }
      if (this.tClockSec >= 0) {
        this.tClockSec = 0;
        this.phase = "LIFTOFF";
        this.catchArmsOpen = 0.85;
      }
      return;
    }

    this.tClockSec += dt;
    this.umbilicalRetracted = 1.0;
    this.catchArmsOpen = approach(this.catchArmsOpen, 0.85, dt * 0.6);

    const hasFuel = this.stageSeparated ? this.shipFuel > 0 : this.boosterFuel > 0;
    const rx = this.pos.x;
    const ry = this.pos.y + R;
    const rz = this.pos.z;
    const rMag = Math.max(1, Math.hypot(rx, ry, rz));
    const ux = rx / rMag;
    const uy = ry / rMag;
    const radialHoriz = Math.hypot(rx, ry);
    const eHorizX = radialHoriz > 1e-6 ? ry / radialHoriz : 1;
    const eHorizY = radialHoriz > 1e-6 ? -rx / radialHoriz : 0;
    const vRad = this.vel.x * ux + this.vel.y * uy + (this.vel.z * rz) / rMag;
    const vTan = this.vel.x * eHorizX + this.vel.y * eHorizY;
    const theta = Math.atan2(rx, ry);
    const localGrav = mu / (rMag * rMag);

    const stageProfile = getFirstStageProfile(this.planet.id);
    const orb = computeOrbitalElements(this.pos, this.vel, R, g0, atmoTop);

    if (this.controlMode === "manual" && manualInput) {
      const prelimThrottle = hasFuel ? this.throttle : 0;
      this.applyManualRotationAndThrottle(dt, manualInput, prelimThrottle);
    } else if (this.controlMode === "ai_ppo") {
      const prelimThrottle = hasFuel ? this.throttle : 0;
      this.applyAIAction(
        dt,
        aiAction ?? { throttle: prelimThrottle, pitchCmd: 0, yawCmd: 0 },
        prelimThrottle
      );
    } else {
      let desiredThrottle = 0;
      let targetWorldPitch = theta;

      if (!this.stageSeparated) {
        const isEarthMaxQ = this.planet.id === "earth" && altM > 400 && altM < 900;
        const desiredNetClimb = isEarthMaxQ
          ? stageProfile.netClimbMaxQ
          : altM < stageProfile.climbSwitchAltM
            ? stageProfile.netClimbLow
            : stageProfile.netClimbHigh;
        desiredThrottle = clamp((localGrav + desiredNetClimb) / stageProfile.maxAccel, 0.24, 1.0);
        const turnFrac = clamp((altM - 250) / Math.max(4000, targetAlt * 0.52), 0, 1);
        const localPitch = altM < 250 ? 0 : Math.pow(turnFrac, 0.72) * stageProfile.maxTurnRad;
        targetWorldPitch = wrapAngle(theta + localPitch);
      } else if (this.phase === "ORBIT_ACHIEVED") {
        desiredThrottle = 0;
        const speedHoriz = Math.hypot(this.vel.x, this.vel.y);
        targetWorldPitch = speedHoriz > 1 ? Math.atan2(this.vel.x, this.vel.y) : wrapAngle(theta + Math.PI * 0.5);
      } else if (this.phase === "CIRCULARIZATION") {
        const minGoalPe = Math.max(atmoTop * 0.9, Math.min(targetAlt * 0.95, orb.apoapsisAltM * 0.94));
        if (
          orb.isOrbitAchieved &&
          (orb.periapsisAltM >= minGoalPe || orb.eccentricity < 0.02 || this.shipFuel <= 0.01)
        ) {
          this.phase = "ORBIT_ACHIEVED";
          desiredThrottle = 0;
          targetWorldPitch = Math.atan2(this.vel.x, this.vel.y);
        } else {
          const accEast = clamp((orb.circularVelocityMps * 1.002 - vTan) * 1.9, 0, 24);
          const centDeficit = Math.max(0, localGrav - (vTan * vTan) / rMag);
          const accUp = clamp(-vRad * 0.85 + centDeficit * 0.8, -6, 18);
          const reqAccel = Math.hypot(accEast, accUp);
          desiredThrottle = clamp(reqAccel / 24.0, 0.08, 1.0);
          targetWorldPitch = wrapAngle(theta + Math.atan2(accEast, accUp));
        }
      } else if (this.phase === "COAST_TO_AP") {
        desiredThrottle = 0;
        const speedHoriz = Math.hypot(this.vel.x, this.vel.y);
        targetWorldPitch = speedHoriz > 1 ? Math.atan2(this.vel.x, this.vel.y) : wrapAngle(theta + Math.PI * 0.5);

        if (orb.isOrbitAchieved) {
          this.phase = "ORBIT_ACHIEVED";
        } else if (orb.apoapsisAltM < targetAlt * 0.95) {
          this.phase = "ORBIT_INSERTION";
        } else {
          const tBurnEst = Math.max(0, orb.circularVelocityMps - vTan) / 20.4;
          const nearAp =
            (orb.timeToApoapsisS !== null && orb.timeToApoapsisS <= Math.max(2.5, tBurnEst * 0.58)) ||
            (vRad <= 6 && altM >= targetAlt * 0.78);
          if (nearAp) {
            this.phase = "CIRCULARIZATION";
          }
        }
      } else {
        // STAGE_SEP or ORBIT_INSERTION: gravity turn ascent + Apoapsis raising
        const turnFrac = clamp((altM - 250) / Math.max(4000, targetAlt * 0.56), 0, 1);
        let localPitch = Math.pow(turnFrac, 0.72) * (Math.PI * 0.465);
        if (vRad < 18 && orb.apoapsisAltM < targetAlt * 0.98) {
          localPitch = Math.min(localPitch, 1.08);
        }
        targetWorldPitch = wrapAngle(theta + localPitch);

        const coastReadyAlt = Math.max(atmoTop * 0.55, 2500);
        if (orb.isOrbitAchieved) {
          this.phase = "ORBIT_ACHIEVED";
          desiredThrottle = 0;
        } else if (orb.apoapsisAltM >= targetAlt * 1.008 && altM >= coastReadyAlt) {
          this.phase = "COAST_TO_AP";
          desiredThrottle = 0;
        } else if (orb.apoapsisAltM >= targetAlt * 1.02) {
          desiredThrottle = 0;
        } else if (orb.apoapsisAltM >= targetAlt * 0.88) {
          desiredThrottle = clamp(
            (targetAlt * 1.02 - orb.apoapsisAltM) / (targetAlt * 0.14),
            0.25,
            1.0
          );
        } else {
          desiredThrottle = 1.0;
        }
      }

      // Maintain tight zero-lift aero corridor during high-Q atmospheric flight
      if (
        this.dynamicPressurePa > 20_000 &&
        this.phase !== "ORBIT_ACHIEVED" &&
        Math.hypot(this.vel.x, this.vel.y) > 40
      ) {
        const velAngle = Math.atan2(this.vel.x, this.vel.y);
        const maxAoA = 0.28;
        const delta = clamp(wrapAngle(targetWorldPitch - velAngle), -maxAoA, maxAoA);
        targetWorldPitch = wrapAngle(velAngle + delta);
      }

      this.throttle = approach(this.throttle, desiredThrottle, dt * 2.4);
      const prevP = this.pitch;
      const prevR = this.roll;
      this.pitch = approachAngle(this.pitch, targetWorldPitch, dt * 0.85);
      this.roll = approach(this.roll, 0, dt * 0.8);
      this.pitchVel = wrapAngle(this.pitch - prevP) / dt;
      this.rollVel = (this.roll - prevR) / dt;
      this.yawVel = 0;
      const pitchErr = wrapAngle(targetWorldPitch - this.pitch);
      this.gimbalX = clamp(pitchErr * 1.8, -0.2618, 0.2618);
      this.gimbalZ = 0;
      this.rcsThrust = {
        pitch: this.phase === "COAST_TO_AP" || this.phase === "ORBIT_ACHIEVED" ? clamp(pitchErr * 1.5, -0.4, 0.4) : 0,
        yaw: 0,
        roll: 0,
      };
    }

    const activeThrottle = hasFuel ? this.throttle : 0;
    if (!this.stageSeparated) {
      this.boosterThrottle = activeThrottle;
      this.shipThrottle = 0;
      this.boosterFuel = Math.max(
        0,
        this.boosterFuel - activeThrottle * stageProfile.burnRate * dt
      );
      this.booster.fuel = this.boosterFuel;
      this.booster.throttle = activeThrottle;
      this.booster.altitudeM = altM;
      this.booster.verticalSpeedMps = vRad;
      this.booster.padOffsetM = Math.hypot(this.pos.x, this.pos.z);

      if (
        (this.controlMode === "autopilot" || this.controlMode === "ai_ppo") &&
        this.boosterFuel <= BOOSTER_RTLS_RESERVE_FUEL
      ) {
        this.triggerStageSeparation();
      }
    } else {
      this.boosterThrottle = 0;
      this.shipThrottle = activeThrottle;
      this.shipFuel = Math.max(0, this.shipFuel - activeThrottle * 0.0055 * dt);
      this.stageSepElapsedSec += dt;
      if (this.phase === "STAGE_SEP" && this.stageSepElapsedSec >= 1.0) {
        this.phase = "ORBIT_INSERTION";
      }
    }

    if (this.phase === "LIFTOFF" && altM > 140) {
      this.phase = "ASCENT";
    }

    this.frostLevel = clamp(this.frostLevel - dt * 0.045, 0, 1);
    this.flapAngleRad = approach(this.flapAngleRad, 0.05, dt * 1.2);
    this.gridFinPitch = this.gimbalX * 0.9;
    this.gridFinYaw = this.gimbalZ * 0.9;

    const maxThrustAccel = this.stageSeparated ? 24.0 : stageProfile.maxAccel;
    const faultScale = computeEffectiveThrustScale(
      this.faultConfig,
      altM,
      this.missionTimeSec
    );
    const thrustAccel = activeThrottle * maxThrustAccel * faultScale;
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    const dirX = sinP;
    const dirY = cosP * Math.cos(this.roll);
    const dirZ = cosP * Math.sin(this.roll);

    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    const dragFactor = rho > 0 ? 0.000035 * rho * speed : 0;
    const wind = computeCrosswindAccel(this.faultConfig, rho, altM, this.missionTimeSec);

    const axNonGrav = dirX * thrustAccel - dragFactor * this.vel.x + wind.ax;
    const ayNonGrav = dirY * thrustAccel - dragFactor * this.vel.y;
    const azNonGrav = dirZ * thrustAccel - dragFactor * this.vel.z + wind.az;

    const invR3Zero = -mu / (rMag * rMag * rMag);
    const g0x = rx * invR3Zero;
    const g0y = ry * invR3Zero;
    const g0z = rz * invR3Zero;

    this.gLoad =
      !this.hasLiftedOff && rMag <= R + this.padDeckY + 0.05
        ? g0 / 9.807
        : Math.hypot(axNonGrav, ayNonGrav, azNonGrav) / 9.807;

    // Velocity-Verlet central-body integration for accurate orbital energy conservation
    const a0x = g0x + axNonGrav;
    const a0y = g0y + ayNonGrav;
    const a0z = g0z + azNonGrav;

    const nextPosX = this.pos.x + this.vel.x * dt + 0.5 * a0x * dt * dt;
    const nextPosY = this.pos.y + this.vel.y * dt + 0.5 * a0y * dt * dt;
    const nextPosZ = this.pos.z + this.vel.z * dt + 0.5 * a0z * dt * dt;

    const nRx = nextPosX;
    const nRy = nextPosY + R;
    const nRz = nextPosZ;
    const nRMag = Math.max(1, Math.hypot(nRx, nRy, nRz));
    const invR3Next = -mu / (nRMag * nRMag * nRMag);
    const g1x = nRx * invR3Next;
    const g1y = nRy * invR3Next;
    const g1z = nRz * invR3Next;

    this.vel.x += (0.5 * (g0x + g1x) + axNonGrav) * dt;
    this.vel.y += (0.5 * (g0y + g1y) + ayNonGrav) * dt;
    this.vel.z += (0.5 * (g0z + g1z) + azNonGrav) * dt;

    this.pos.x = nextPosX;
    this.pos.y = nextPosY;
    this.pos.z = nextPosZ;

    // Before clearing the pad on initial spool/liftoff, hold smoothly on pad deck
    if (!this.hasLiftedOff && this.pos.y < this.padDeckY) {
      this.pos.y = this.padDeckY;
      if (this.vel.y < 0) {
        this.vel.y = 0;
      }
    }
  }

  private stepLandingMode(
    dt: number,
    altM: number,
    rho: number,
    manualInput?: ManualInputState,
    aiAction?: AIActionInput
  ): void {
    this.tClockSec += dt;
    const g = this.planet.physics.gravityMps2;
    const maxShipAccel = 26.0;

    if (this.controlMode === "manual" && manualInput) {
      const prelimThrottle = this.shipFuel > 0 ? this.throttle : 0;
      this.applyManualRotationAndThrottle(dt, manualInput, prelimThrottle);
      if (altM < 280) {
        this.phase = "FLIP_BURN";
      }
    } else if (this.controlMode === "ai_ppo") {
      const prelimThrottle = this.shipFuel > 0 ? this.throttle : 0;
      this.applyAIAction(
        dt,
        aiAction ?? { throttle: prelimThrottle, pitchCmd: 0, yawCmd: 0, autoLegs: true },
        prelimThrottle
      );
      this.phase = altM > 340 && rho > 0.0005 && this.throttle < 0.05 ? "DESCENT" : "FLIP_BURN";
      this.flapAngleRad = approach(this.flapAngleRad, this.phase === "DESCENT" ? 0.95 : 0.14, dt * 2.2);
      if ((aiAction?.autoLegs ?? true) && altM <= 80) {
        this.targetLandingLegs = 1.0;
      }
    } else {
      const isAtmospheric = rho > 0.0005;
      if (isAtmospheric && altM > 340) {
        this.phase = "DESCENT";
        this.flapAngleRad = approach(this.flapAngleRad, 1.08, dt * 1.8);
        this.targetLandingLegs = 0.0;
        this.throttle = 0.0;
        this.gimbalX = 0;
        this.gimbalZ = 0;

        this.pitch = approach(this.pitch, 72 * DEG_TO_RAD, dt * 0.9);
        this.roll = approach(this.roll, 0, dt * 0.9);
        this.pitchVel = 0;
        this.rollVel = 0;
        this.yawVel = 0;
        this.rcsThrust = { pitch: 0.15, yaw: 0, roll: 0 };

        this.vel.x += clamp((-this.pos.x * 0.09 - this.vel.x) * 0.45, -3.5, 3.5) * dt;
        this.vel.z += clamp((-this.pos.z * 0.09 - this.vel.z) * 0.45, -3.5, 3.5) * dt;
      } else {
        this.phase = "FLIP_BURN";
        this.flapAngleRad = approach(this.flapAngleRad, 0.14, dt * 2.6);
        if (altM <= 110) {
          this.targetLandingLegs = 1.0;
        }

        const timeToGo = clamp(altM / Math.max(5, -this.vel.y + 3), 0.7, 22);
        const targetVx = clamp(-this.pos.x / Math.max(1.6, timeToGo * 0.72), -24, 24);
        const targetVz = clamp(-this.pos.z / Math.max(1.6, timeToGo * 0.72), -24, 24);

        const maxTilt = altM < 12 ? 0.06 : altM < 45 ? 0.16 : 0.44;
        const desiredPitch = clamp((targetVx - this.vel.x) * 0.095, -maxTilt, maxTilt);
        const desiredRoll = clamp((targetVz - this.vel.z) * 0.095, -maxTilt, maxTilt);

        const prevP = this.pitch;
        const prevR = this.roll;
        this.pitch = approach(this.pitch, desiredPitch, dt * 2.9);
        this.roll = approach(this.roll, desiredRoll, dt * 2.9);
        this.pitchVel = (this.pitch - prevP) / dt;
        this.rollVel = (this.roll - prevR) / dt;
        this.yawVel = 0;
        this.gimbalX = clamp((desiredPitch - this.pitch) * 2.4, -0.2618, 0.2618);
        this.gimbalZ = clamp((desiredRoll - this.roll) * 2.4, -0.2618, 0.2618);
        this.rcsThrust = {
          pitch: clamp((desiredPitch - this.pitch) * 3.0, -1, 1),
          yaw: 0,
          roll: clamp((desiredRoll - this.roll) * 3.0, -1, 1),
        };

        const targetVy = altM > 14 ? -clamp(1.4 + Math.sqrt(altM) * 1.12, 1.8, 42) : -1.4;
        const verticalError = targetVy - this.vel.y;
        const cosTilt = Math.max(0.5, Math.cos(this.pitch) * Math.cos(this.roll));
        const desiredVerticalAccel = g + verticalError * 3.2;
        const desiredThrustAccel = desiredVerticalAccel / cosTilt;
        this.throttle = clamp(desiredThrustAccel / maxShipAccel, 0.0, 1.0);
      }
    }

    const activeThrottle = this.shipFuel > 0 ? this.throttle : 0;
    this.boosterThrottle = 0;
    this.shipThrottle = activeThrottle;
    this.shipFuel = Math.max(0, this.shipFuel - activeThrottle * 0.011 * dt);
    this.frostLevel = clamp(this.frostLevel - dt * 0.03, 0.05, 1);

    const faultScale = computeEffectiveThrustScale(
      this.faultConfig,
      altM,
      this.missionTimeSec
    );
    const thrustAccel = activeThrottle * maxShipAccel * faultScale;
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    const dirX = sinP;
    const dirY = cosP * Math.cos(this.roll);
    const dirZ = cosP * Math.sin(this.roll);

    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    const bellyAreaFactor = 0.002 + 0.012 * Math.abs(Math.sin(this.pitch));
    const dragFactor = rho > 0 ? bellyAreaFactor * rho * speed : 0;
    const wind = computeCrosswindAccel(this.faultConfig, rho, altM, this.missionTimeSec);

    const ax = dirX * thrustAccel - dragFactor * this.vel.x + wind.ax;
    const ay = dirY * thrustAccel - g - dragFactor * this.vel.y;
    const az = dirZ * thrustAccel - dragFactor * this.vel.z + wind.az;

    this.gLoad = Math.hypot(ax, ay + g, az) / 9.807;

    this.vel.x += ax * dt;
    this.vel.y += ay * dt;
    this.vel.z += az * dt;

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
  }

  getTelemetry(): FlightTelemetry {
    const R = this.planet.scale.simRadiusM;
    let surfaceHeightM: number;
    let altitudeM: number;
    let verticalSpeedMps: number;

    if (this.missionMode === "launch") {
      const radial = this.getLaunchRadialState();
      surfaceHeightM = radial.surfaceRadiusM - R;
      altitudeM = radial.altitudeM;
      verticalSpeedMps = radial.vRadial;
    } else {
      surfaceHeightM = this.getSurfaceHeightAt(this.pos.x, this.pos.z);
      altitudeM = Math.max(0, this.pos.y - surfaceHeightM);
      verticalSpeedMps = this.vel.y;
    }

    const speedMps = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    const orb = computeOrbitalElements(
      this.pos,
      this.vel,
      R,
      this.planet.physics.gravityMps2,
      this.planet.scale.atmosphereTopM
    );

    return {
      planetId: this.planet.id,
      missionMode: this.missionMode,
      controlMode: this.controlMode,
      phase: this.phase,
      running: this.running,
      paused: this.paused,
      sasEnabled: this.sasEnabled,
      missionTimeSec: this.missionTimeSec,
      tClockSec: this.tClockSec,
      padDeckY: this.padDeckY,
      surfaceHeightM,
      altitudeM,
      speedMps,
      speedKmh: speedMps * 3.6,
      verticalSpeedMps,
      mach: this.mach,
      dynamicPressurePa: this.dynamicPressurePa,
      maxQPa: this.maxQPa,
      maxQReached: this.maxQReached,
      throttle: this.throttle,
      boosterThrottle: this.boosterThrottle,
      shipThrottle: this.shipThrottle,
      boosterFuel: this.boosterFuel,
      shipFuel: this.shipFuel,
      frostLevel: this.frostLevel,
      umbilicalRetracted: this.umbilicalRetracted,
      catchArmsOpen: this.catchArmsOpen,
      catchCarriageY: this.catchCarriageY,
      flapAngleRad: this.flapAngleRad,
      gridFinPitch: this.gridFinPitch,
      gridFinYaw: this.gridFinYaw,
      landingLegsDeployed: this.landingLegsDeployed,
      targetLandingLegs: this.targetLandingLegs,
      stageSeparated: this.stageSeparated,
      gimbalX: this.gimbalX,
      gimbalZ: this.gimbalZ,
      position: { ...this.pos },
      velocity: { ...this.vel },
      pitch: this.pitch,
      yaw: this.yaw,
      roll: this.roll,
      angularVelocity: {
        pitch: this.pitchVel,
        yaw: this.yawVel,
        roll: this.rollVel,
      },
      rcsThrust: { ...this.rcsThrust },
      booster: {
        active: this.booster.active,
        status: this.booster.status,
        position: { ...this.booster.position },
        velocity: { ...this.booster.velocity },
        pitch: this.booster.pitch,
        yaw: this.booster.yaw,
        roll: this.booster.roll,
        throttle: this.booster.throttle,
        fuel: this.booster.fuel,
        altitudeM: this.booster.altitudeM,
        verticalSpeedMps: this.booster.verticalSpeedMps,
        padOffsetM: this.booster.padOffsetM,
        gridFinPitch: this.booster.gridFinPitch,
        gridFinYaw: this.booster.gridFinYaw,
        touchdownVerticalSpeedMps: this.booster.touchdownVerticalSpeedMps,
        touchdownOffsetM: this.booster.touchdownOffsetM,
        impactEvent: this.booster.impactEvent,
      },
      landingVerdict: this.landingVerdict,
      crashEvent: this.crashEvent,
      touchdownVerticalSpeedMps: this.touchdownVerticalSpeedMps,
      touchdownOffsetM: this.touchdownOffsetM,
      touchdownTiltDeg: this.touchdownTiltDeg,
      gLoad: this.gLoad,
      activeFaults: describeActiveFaults(
        this.faultConfig,
        altitudeM,
        this.missionTimeSec
      ),
      orbital: {
        apoapsisAltM: orb.apoapsisAltM,
        periapsisAltM: orb.periapsisAltM,
        eccentricity: orb.eccentricity,
        circularVelocityMps: orb.circularVelocityMps,
        orbitalSpeedMps: orb.orbitalSpeedMps,
        orbitalPeriodS: orb.orbitalPeriodS,
        timeToApoapsisS: orb.timeToApoapsisS,
        targetOrbitAltM: this.planet.scale.targetOrbitAltM,
        isBoundOrbit: orb.isBoundOrbit,
        orbitAchieved: this.phase === "ORBIT_ACHIEVED" || orb.isOrbitAchieved,
        timeWarp: this.timeWarp,
        apoapsisWorldPos: orb.apoapsisWorldPos,
        periapsisWorldPos: orb.periapsisWorldPos,
      },
    };
  }
}
