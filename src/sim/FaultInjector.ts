import type { FlightTelemetry } from "./FlightController";

export interface FaultConfig {
  /** Percentage of nominal thrust lost when active (0..50). */
  thrustLossPct: number;
  /** Altitude (m) at or above which thrust loss activates (0 = immediate). */
  thrustLossTriggerAltM: number;
  /** Mission elapsed time (s) at or above which thrust loss activates (0 = immediate). */
  thrustLossTriggerTimeSec: number;
  /** Horizontal crosswind speed at dense 1-bar atmosphere (0..40 m/s). */
  windSpeedMps: number;
  /** Crosswind azimuth in degrees (0 = +X, 90 = +Z). */
  windDirectionDeg: number;
  /** Constant IMU pitch/roll measurement bias in degrees (0..10). */
  imuBiasDeg: number;
  /** Standard deviation of Gaussian IMU pitch/roll measurement noise in degrees (0..5). */
  imuNoiseDeg: number;
  /** Adds actuator slew lag & reduces TVC control authority by 45%. */
  tvcLagEnabled: boolean;
}

const DEG_TO_RAD = Math.PI / 180;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function createDefaultFaultConfig(): FaultConfig {
  return {
    thrustLossPct: 0,
    thrustLossTriggerAltM: 0,
    thrustLossTriggerTimeSec: 0,
    windSpeedMps: 0,
    windDirectionDeg: 0,
    imuBiasDeg: 0,
    imuNoiseDeg: 0,
    tvcLagEnabled: false,
  };
}

export function sanitizeFaultConfig(cfg: Partial<FaultConfig>): FaultConfig {
  const base = createDefaultFaultConfig();
  return {
    thrustLossPct: clamp(cfg.thrustLossPct ?? base.thrustLossPct, 0, 50),
    thrustLossTriggerAltM: Math.max(0, cfg.thrustLossTriggerAltM ?? base.thrustLossTriggerAltM),
    thrustLossTriggerTimeSec: Math.max(
      0,
      cfg.thrustLossTriggerTimeSec ?? base.thrustLossTriggerTimeSec
    ),
    windSpeedMps: clamp(cfg.windSpeedMps ?? base.windSpeedMps, 0, 40),
    windDirectionDeg: cfg.windDirectionDeg ?? base.windDirectionDeg,
    imuBiasDeg: clamp(cfg.imuBiasDeg ?? base.imuBiasDeg, 0, 10),
    imuNoiseDeg: clamp(cfg.imuNoiseDeg ?? base.imuNoiseDeg, 0, 5),
    tvcLagEnabled: Boolean(cfg.tvcLagEnabled ?? base.tvcLagEnabled),
  };
}

export function isThrustFaultActive(
  cfg: FaultConfig,
  altM: number,
  missionTimeSec: number
): boolean {
  if (cfg.thrustLossPct <= 0.01) {
    return false;
  }
  return (
    altM >= cfg.thrustLossTriggerAltM &&
    missionTimeSec >= cfg.thrustLossTriggerTimeSec
  );
}

export function computeEffectiveThrustScale(
  cfg: FaultConfig,
  altM: number,
  missionTimeSec: number
): number {
  if (!isThrustFaultActive(cfg, altM, missionTimeSec)) {
    return 1.0;
  }
  return clamp(1.0 - cfg.thrustLossPct / 100, 0.5, 1.0);
}

/**
 * Computes lateral crosswind acceleration (m/s^2) scaled by ambient atmospheric density.
 * Strictly zero in hard vacuum (e.g. Moon where rho === 0).
 */
export function computeCrosswindAccel(
  cfg: FaultConfig,
  rho: number,
  altM: number,
  missionTimeSec: number
): { ax: number; az: number } {
  if (rho <= 0 || cfg.windSpeedMps <= 0.01) {
    return { ax: 0, az: 0 };
  }
  const rad = cfg.windDirectionDeg * DEG_TO_RAD;
  const gust = 1.0 + 0.25 * Math.sin(missionTimeSec * 1.4 + altM * 0.015);
  const shear = clamp(0.65 + Math.min(1, altM / 350) * 0.55, 0.65, 1.2);
  const effectiveWind = cfg.windSpeedMps * gust * shear;
  // Density scaling relative to Earth sea-level 1.225 kg/m^3 -> realistic lateral acceleration
  const densityScale = rho / 1.225;
  const accelMag = effectiveWind * 0.14 * densityScale;
  return {
    ax: Math.cos(rad) * accelMag,
    az: Math.sin(rad) * accelMag,
  };
}

/**
 * Applies IMU measurement bias & noise to create a sensed telemetry snapshot
 * without mutating true FlightController physics state.
 */
export function applySensorFaultsToTelemetry(
  trueTel: FlightTelemetry,
  cfg: FaultConfig,
  pitchNoiseSample = 0,
  rollNoiseSample = 0
): FlightTelemetry {
  if (cfg.imuBiasDeg <= 0 && cfg.imuNoiseDeg <= 0) {
    return trueTel;
  }
  const biasRad = cfg.imuBiasDeg * DEG_TO_RAD;
  const noiseRad = cfg.imuNoiseDeg * DEG_TO_RAD;
  return {
    ...trueTel,
    pitch: trueTel.pitch + biasRad + pitchNoiseSample * noiseRad,
    roll: trueTel.roll + biasRad * 0.5 + rollNoiseSample * noiseRad,
  };
}

export function describeActiveFaults(
  cfg: FaultConfig,
  altM: number,
  missionTimeSec: number
): string {
  const tags: string[] = [];
  if (isThrustFaultActive(cfg, altM, missionTimeSec)) {
    tags.push(`ENG-${Math.round(cfg.thrustLossPct)}%`);
  }
  if (cfg.windSpeedMps > 0.5) {
    tags.push(`WIND ${Math.round(cfg.windSpeedMps)}m/s`);
  }
  if (cfg.imuBiasDeg > 0.1 || cfg.imuNoiseDeg > 0.1) {
    tags.push(`IMU±${(cfg.imuBiasDeg + cfg.imuNoiseDeg).toFixed(1)}°`);
  }
  if (cfg.tvcLagEnabled) {
    tags.push("TVC-LAG");
  }
  return tags.length > 0 ? tags.join(" · ") : "NOMINAL";
}
