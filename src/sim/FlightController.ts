import { type PlanetConfig, type PlanetId, getPlanetConfig } from "../config/planets";
import { PAD_FLAT_RADIUS_M, SeededNoise2D, samplePlanetTerrainHeight } from "../utils/noise";

export type MissionMode = "launch" | "landing";
export type ControlMode = "ai_ppo" | "autopilot" | "manual";

export interface AIActionInput {
  throttle: number;
  pitchCmd: number;
  yawCmd: number;
  autoLegs?: boolean;
}

export interface RLSpawnOverrides {
  planetId?: PlanetId;
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

export interface BoosterState {
  active: boolean;
  status: "ATTACHED" | "COASTING" | "IMPACTED" | "NONE";
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  pitch: number;
  yaw: number;
  roll: number;
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
}

const FIXED_DT = 1 / 60;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const STACK_DRY_AND_WET_MASS_KG = 1_600_000;
const SHIP_MASS_KG = 240_000;

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
  private flapAngleRad = 0.0;
  private gridFinPitch = 0.0;
  private gridFinYaw = 0.0;
  private landingLegsDeployed = 0.0;
  private targetLandingLegs = 0.0;
  private gimbalX = 0.0;
  private gimbalZ = 0.0;

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
    impactEvent: null,
  };

  private landingVerdict: LandingVerdict = "NONE";
  private crashEvent: CrashEvent | null = null;
  private touchdownVerticalSpeedMps: number | null = null;
  private touchdownOffsetM: number | null = null;
  private touchdownTiltDeg: number | null = null;

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
    this.booster = {
      active: true,
      status: "COASTING",
      position: { ...this.pos },
      velocity: {
        x: this.vel.x - 1.5,
        y: Math.max(-5, this.vel.y - 6.0),
        z: this.vel.z,
      },
      pitch: this.pitch,
      yaw: this.yaw,
      roll: this.roll,
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
    const safeDt = clamp(dt, 0, 0.1);
    if (this.running && !this.paused && !this.isTerminalPhase()) {
      this.accumulator += safeDt;
      while (this.accumulator >= FIXED_DT) {
        this.stepFixed(FIXED_DT, manualInput, aiAction);
        this.accumulator -= FIXED_DT;
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
    const mode = overrides.missionMode ?? this.missionMode;
    this.reset(planetId, this.padDeckY, mode);

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

  private sampleAirDensity(altitudeM: number): number {
    const rho0 = this.planet.physics.airDensityKgM3;
    const hScaleKm = this.planet.physics.atmosphereScaleHeightKm;
    if (rho0 <= 0 || hScaleKm <= 0) {
      return 0;
    }
    return rho0 * Math.exp(-Math.max(0, altitudeM) / (hScaleKm * 1000));
  }

  private stepFixed(
    dt: number,
    manualInput?: ManualInputState,
    aiAction?: AIActionInput
  ): void {
    this.missionTimeSec += dt;
    const surfaceY = this.getSurfaceHeightAt(this.pos.x, this.pos.z);
    const altM = Math.max(0, this.pos.y - surfaceY);
    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    const rho = this.sampleAirDensity(Math.max(0, this.pos.y - this.padDeckY));

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
      if (this.pos.y - this.padDeckY > 1.5) {
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
    const g = this.planet.physics.gravityMps2;
    const bx = this.booster.position.x;
    const bz = this.booster.position.z;
    const bSurfaceY = this.getSurfaceHeightAt(bx, bz);
    const bAlt = Math.max(0, this.booster.position.y - bSurfaceY);
    const bRho = this.sampleAirDensity(bAlt);
    const bSpeed = Math.hypot(
      this.booster.velocity.x,
      this.booster.velocity.y,
      this.booster.velocity.z
    );
    const dragDecel = bRho > 0 ? 0.00018 * bRho * bSpeed : 0;
    this.booster.velocity.x *= Math.max(0, 1 - dragDecel * dt);
    this.booster.velocity.y += (g - dragDecel * this.booster.velocity.y) * dt;
    this.booster.velocity.z *= Math.max(0, 1 - dragDecel * dt);

    this.booster.position.x += this.booster.velocity.x * dt;
    this.booster.position.y += this.booster.velocity.y * dt;
    this.booster.position.z += this.booster.velocity.z * dt;
    this.booster.pitch = approach(this.booster.pitch, 0.08, dt * 0.15);

    const nextSurfaceY = this.getSurfaceHeightAt(
      this.booster.position.x,
      this.booster.position.z
    );
    if (this.booster.position.y <= nextSurfaceY) {
      const impactSpeed = Math.hypot(
        this.booster.velocity.x,
        this.booster.velocity.y,
        this.booster.velocity.z
      );
      this.booster.position.y = nextSurfaceY;
      this.booster.impactEvent = {
        id: ++this.eventSeq,
        position: { ...this.booster.position },
        velocity: { ...this.booster.velocity },
        impactSpeedMps: impactSpeed,
        impactEnergyJ: 0.5 * 850_000 * impactSpeed * impactSpeed,
        remainingFuelRatio: this.boosterFuel,
        cause: "SURFACE_IMPACT",
        timestampSec: this.missionTimeSec,
      };
      this.booster.velocity = { x: 0, y: 0, z: 0 };
      this.booster.active = false;
      this.booster.status = "IMPACTED";
    }
  }

  private evaluateHazardAndSurfaceContact(): void {
    if (this.isTerminalPhase()) {
      return;
    }
    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);

    // 1. Launch tower collision check
    const tower = this.getTowerSpec();
    if (
      this.hasLiftedOff &&
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

    // 3. Universal surface / terrain / pad deck contact check
    const surfaceY = this.getSurfaceHeightAt(this.pos.x, this.pos.z);
    const tiltDeg = Math.hypot(this.pitch, this.roll) * RAD_TO_DEG;

    if (this.hasLiftedOff && this.pos.y <= surfaceY && (this.vel.y <= 0 || tiltDeg > 35)) {
      const impactVy = Math.abs(this.vel.y);
      const impactHoriz = Math.hypot(this.vel.x, this.vel.z);
      const impactSpeed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
      const offsetM = Math.hypot(this.pos.x, this.pos.z);
      const withinPad = offsetM <= this.getPadLandingRadiusM();
      const legsOk = this.missionMode === "launch" || this.landingLegsDeployed >= 0.7;

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

    const rcsPitchYawAccel = 2.2;
    const tvcAuthority = activeThrottle > 0.02 ? 2.4 * activeThrottle : 0;
    const maxPitchRollAccel = rcsPitchYawAccel + tvcAuthority;
    const maxYawAccel = 1.85;
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

    this.gimbalX = activeThrottle > 0.02 ? clamp(pitchCmd * 0.2618, -0.2618, 0.2618) : 0;
    this.gimbalZ = activeThrottle > 0.02 ? clamp(rollCmd * 0.2618, -0.2618, 0.2618) : 0;
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
    const g = this.planet.physics.gravityMps2;

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
      const isEarthMaxQ =
        !this.stageSeparated && this.planet.id === "earth" && altM > 400 && altM < 900;
      const desiredNetClimb = this.stageSeparated ? 12.5 : isEarthMaxQ ? 6.2 : 8.5;
      const maxAccelAvailable = this.stageSeparated ? 24.0 : 22.0;
      const desiredThrottle = clamp((g + desiredNetClimb) / maxAccelAvailable, 0.28, 1.0);
      this.throttle = approach(this.throttle, desiredThrottle, dt * 1.8);

      const targetPitch = altM < 90 ? 0 : clamp((altM - 90) / 3600, 0, 0.78);
      const prevP = this.pitch;
      const prevR = this.roll;
      this.pitch = approach(this.pitch, targetPitch, dt * 0.35);
      this.roll = approach(this.roll, 0, dt * 0.6);
      this.pitchVel = (this.pitch - prevP) / dt;
      this.rollVel = (this.roll - prevR) / dt;
      this.yawVel = 0;
      this.gimbalX = clamp((targetPitch - this.pitch) * 1.8, -0.2618, 0.2618);
      this.gimbalZ = 0;
      this.rcsThrust = { pitch: 0, yaw: 0, roll: 0 };
    }

    const activeThrottle = hasFuel ? this.throttle : 0;
    if (!this.stageSeparated) {
      this.boosterThrottle = activeThrottle;
      this.shipThrottle = 0;
      this.boosterFuel = Math.max(0, this.boosterFuel - activeThrottle * 0.018 * dt);
      if (
        (this.controlMode === "autopilot" || this.controlMode === "ai_ppo") &&
        (altM >= 2200 || this.boosterFuel <= 0.16)
      ) {
        this.triggerStageSeparation();
      }
    } else {
      this.boosterThrottle = 0;
      this.shipThrottle = activeThrottle;
      this.shipFuel = Math.max(0, this.shipFuel - activeThrottle * 0.015 * dt);
      if (this.phase === "STAGE_SEP" && altM > 2350) {
        this.phase = "ORBIT_INSERTION";
      }
    }

    if (this.phase === "LIFTOFF" && altM > 140) {
      this.phase = "ASCENT";
    }
    if ((this.phase === "ASCENT" || this.phase === "ORBIT_INSERTION") && altM > 14000) {
      this.phase = "COMPLETE";
    }

    this.frostLevel = clamp(this.frostLevel - dt * 0.045, 0, 1);
    this.flapAngleRad = approach(this.flapAngleRad, 0.05, dt * 1.2);
    this.gridFinPitch = this.gimbalX * 0.9;
    this.gridFinYaw = this.gimbalZ * 0.9;

    const maxThrustAccel = this.stageSeparated ? 24.0 : 22.0;
    const thrustAccel = activeThrottle * maxThrustAccel;
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    const dirX = sinP;
    const dirY = cosP * Math.cos(this.roll);
    const dirZ = cosP * Math.sin(this.roll);

    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    const dragFactor = rho > 0 ? 0.000035 * rho * speed : 0;

    const ax = dirX * thrustAccel - dragFactor * this.vel.x;
    const ay = dirY * thrustAccel - g - dragFactor * this.vel.y;
    const az = dirZ * thrustAccel - dragFactor * this.vel.z;

    this.vel.x += ax * dt;
    this.vel.y += ay * dt;
    this.vel.z += az * dt;

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    // Before clearing the pad on initial spool/liftoff, hold on pad deck smoothly
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

    const thrustAccel = activeThrottle * maxShipAccel;
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    const dirX = sinP;
    const dirY = cosP * Math.cos(this.roll);
    const dirZ = cosP * Math.sin(this.roll);

    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    const bellyAreaFactor = 0.002 + 0.012 * Math.abs(Math.sin(this.pitch));
    const dragFactor = rho > 0 ? bellyAreaFactor * rho * speed : 0;

    const ax = dirX * thrustAccel - dragFactor * this.vel.x;
    const ay = dirY * thrustAccel - g - dragFactor * this.vel.y;
    const az = dirZ * thrustAccel - dragFactor * this.vel.z;

    this.vel.x += ax * dt;
    this.vel.y += ay * dt;
    this.vel.z += az * dt;

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
  }

  getTelemetry(): FlightTelemetry {
    const surfaceHeightM = this.getSurfaceHeightAt(this.pos.x, this.pos.z);
    const speedMps = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
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
      altitudeM: Math.max(0, this.pos.y - surfaceHeightM),
      speedMps,
      speedKmh: speedMps * 3.6,
      verticalSpeedMps: this.vel.y,
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
        impactEvent: this.booster.impactEvent,
      },
      landingVerdict: this.landingVerdict,
      crashEvent: this.crashEvent,
      touchdownVerticalSpeedMps: this.touchdownVerticalSpeedMps,
      touchdownOffsetM: this.touchdownOffsetM,
      touchdownTiltDeg: this.touchdownTiltDeg,
    };
  }
}
