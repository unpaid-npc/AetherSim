import type { PlanetId } from "./planets";

export type VehicleId = "starship" | "falcon9" | "lvm3" | "saturn5";
export type PlumeStyle = "methalox" | "kerolox" | "solid_hybrid";

export interface VehiclePropulsionProfile {
  readonly stackDryAndPayloadKg: number;
  readonly boosterPropKg: number;
  readonly boosterThrustN: number;
  readonly boosterVeMps: number;
  readonly shipDryKg: number;
  readonly shipPropKg: number;
  readonly shipThrustN: number;
  readonly shipVeMps: number;
  readonly maxGLoadMps2: number;
  readonly stage1TurnAltEndM: number;
  readonly stage1MaxTurnRad: number;
  readonly boosterRtlsDryKg: number;
  readonly boosterRtlsMaxAccel: number;
  readonly dragCoeff: number;
  readonly sideBoosterDryKg: number;
  readonly sideBoosterPropKg: number;
  readonly sideBoosterThrustN: number;
  readonly sideBoosterVeMps: number;
}

export interface VehicleConfig {
  readonly id: VehicleId;
  readonly name: string;
  readonly shortName: string;
  readonly agency: string;
  readonly heightM: number;
  readonly diameterM: number;
  readonly hullRadiusM: number;
  readonly stage1HeightM: number;
  readonly boosterMidY: number;
  readonly shipMidY: number;
  readonly stackMidY: number;
  readonly stageCount: number;
  readonly hasSideBoosters: boolean;
  readonly rtlsCapable: boolean;
  readonly supportsLandingMode: boolean;
  readonly rtlsReserveFuel: number;
  readonly boosterPlumeStyle: PlumeStyle;
  readonly upperPlumeStyle: PlumeStyle;
  readonly sideBoosterPlumeStyle: PlumeStyle;
  readonly stage1Label: string;
  readonly stage2Label: string;
  readonly sideBoosterLabel: string;
  readonly badge: string;
  readonly enginesSummary: string;
  readonly description: string;
  readonly earthProfile: VehiclePropulsionProfile;
}

const G0 = 9.807;

export const VEHICLES: Record<VehicleId, VehicleConfig> = {
  starship: {
    id: "starship",
    name: "Starship + Super Heavy",
    shortName: "STARSHIP",
    agency: "SpaceX",
    heightM: 121.0,
    diameterM: 9.0,
    hullRadiusM: 4.5,
    stage1HeightM: 71.0,
    boosterMidY: 35.5,
    shipMidY: 24.0,
    stackMidY: 58.0,
    stageCount: 2,
    hasSideBoosters: false,
    rtlsCapable: true,
    supportsLandingMode: true,
    rtlsReserveFuel: 0.18,
    boosterPlumeStyle: "methalox",
    upperPlumeStyle: "methalox",
    sideBoosterPlumeStyle: "methalox",
    stage1Label: "BSTR",
    stage2Label: "SHIP",
    sideBoosterLabel: "S200",
    badge: "RTLS CATCH",
    enginesSummary: "33 Booster + 6 Ship Raptors",
    description: "121 m fully reusable stainless steel heavy-lift vehicle with autonomous RTLS catch",
    earthProfile: {
      stackDryAndPayloadKg: 1_750_000,
      boosterPropKg: 3_400_000,
      boosterThrustN: 76_000_000,
      boosterVeMps: 335 * G0,
      shipDryKg: 200_000,
      shipPropKg: 1_340_000,
      shipThrustN: 19_500_000,
      shipVeMps: 382 * G0,
      maxGLoadMps2: 3.8 * G0,
      stage1TurnAltEndM: 64_000,
      stage1MaxTurnRad: 0.84,
      boosterRtlsDryKg: 250_000,
      boosterRtlsMaxAccel: 42.0,
      dragCoeff: 0.000018,
      sideBoosterDryKg: 0,
      sideBoosterPropKg: 0,
      sideBoosterThrustN: 0,
      sideBoosterVeMps: 1,
    },
  },
  falcon9: {
    id: "falcon9",
    name: "Falcon 9 Block 5",
    shortName: "FALCON 9",
    agency: "SpaceX",
    heightM: 70.0,
    diameterM: 3.7,
    hullRadiusM: 1.85,
    stage1HeightM: 47.0,
    boosterMidY: 23.5,
    shipMidY: 11.5,
    stackMidY: 35.0,
    stageCount: 2,
    hasSideBoosters: false,
    rtlsCapable: true,
    supportsLandingMode: true,
    rtlsReserveFuel: 0.16,
    boosterPlumeStyle: "kerolox",
    upperPlumeStyle: "kerolox",
    sideBoosterPlumeStyle: "kerolox",
    stage1Label: "STG 1",
    stage2Label: "STG 2",
    sideBoosterLabel: "S200",
    badge: "RTLS LANDING",
    enginesSummary: "9 Merlin 1D + 1 MVac",
    description: "70 m two-stage orbital workhorse with deployable carbon landing legs & RTLS",
    earthProfile: {
      stackDryAndPayloadKg: 138_000,
      boosterPropKg: 411_000,
      boosterThrustN: 7_607_000,
      boosterVeMps: 305 * G0,
      shipDryKg: 11_000,
      shipPropKg: 102_000,
      shipThrustN: 1_350_000,
      shipVeMps: 348 * G0,
      maxGLoadMps2: 4.2 * G0,
      stage1TurnAltEndM: 58_000,
      stage1MaxTurnRad: 0.86,
      boosterRtlsDryKg: 25_000,
      boosterRtlsMaxAccel: 38.0,
      dragCoeff: 0.000016,
      sideBoosterDryKg: 0,
      sideBoosterPropKg: 0,
      sideBoosterThrustN: 0,
      sideBoosterVeMps: 1,
    },
  },
  lvm3: {
    id: "lvm3",
    name: "ISRO LVM3",
    shortName: "LVM3",
    agency: "ISRO",
    heightM: 43.5,
    diameterM: 4.0,
    hullRadiusM: 2.0,
    stage1HeightM: 21.0,
    boosterMidY: 10.5,
    shipMidY: 11.0,
    stackMidY: 22.0,
    stageCount: 3,
    hasSideBoosters: true,
    rtlsCapable: false,
    supportsLandingMode: false,
    rtlsReserveFuel: 0.005,
    boosterPlumeStyle: "kerolox",
    upperPlumeStyle: "methalox",
    sideBoosterPlumeStyle: "solid_hybrid",
    stage1Label: "L110",
    stage2Label: "C25",
    sideBoosterLabel: "S200×2",
    badge: "SIDE BOOSTERS",
    enginesSummary: "2× S200 Solid + L110 + C25",
    description: "43.5 m heavy launcher with twin strap-on S200 solid boosters and CE-20 upper stage",
    earthProfile: {
      stackDryAndPayloadKg: 58_000,
      boosterPropKg: 110_000,
      boosterThrustN: 2_150_000,
      boosterVeMps: 300 * G0,
      shipDryKg: 10_000,
      shipPropKg: 33_000,
      shipThrustN: 520_000,
      shipVeMps: 443 * G0,
      maxGLoadMps2: 4.0 * G0,
      stage1TurnAltEndM: 54_000,
      stage1MaxTurnRad: 0.86,
      boosterRtlsDryKg: 15_000,
      boosterRtlsMaxAccel: 20.0,
      dragCoeff: 0.000018,
      sideBoosterDryKg: 62_000,
      sideBoosterPropKg: 410_000,
      sideBoosterThrustN: 10_300_000,
      sideBoosterVeMps: 275 * G0,
    },
  },
  saturn5: {
    id: "saturn5",
    name: "NASA Saturn V",
    shortName: "SATURN V",
    agency: "NASA",
    heightM: 110.6,
    diameterM: 10.1,
    hullRadiusM: 5.05,
    stage1HeightM: 42.0,
    boosterMidY: 21.0,
    shipMidY: 32.0,
    stackMidY: 52.0,
    stageCount: 3,
    hasSideBoosters: false,
    rtlsCapable: false,
    supportsLandingMode: false,
    rtlsReserveFuel: 0.005,
    boosterPlumeStyle: "kerolox",
    upperPlumeStyle: "methalox",
    sideBoosterPlumeStyle: "kerolox",
    stage1Label: "S-IC",
    stage2Label: "S-II/IVB",
    sideBoosterLabel: "S200",
    badge: "APOLLO HEAVY",
    enginesSummary: "5× F-1 + 5× J-2",
    description: "110.6 m iconic super heavy-lift Apollo moon rocket with roll-pattern S-IC stage",
    earthProfile: {
      stackDryAndPayloadKg: 885_000,
      boosterPropKg: 2_080_000,
      boosterThrustN: 38_000_000,
      boosterVeMps: 295 * G0,
      shipDryKg: 92_000,
      shipPropKg: 658_000,
      shipThrustN: 11_500_000,
      shipVeMps: 425 * G0,
      maxGLoadMps2: 4.0 * G0,
      stage1TurnAltEndM: 60_000,
      stage1MaxTurnRad: 0.85,
      boosterRtlsDryKg: 130_000,
      boosterRtlsMaxAccel: 20.0,
      dragCoeff: 0.000016,
      sideBoosterDryKg: 0,
      sideBoosterPropKg: 0,
      sideBoosterThrustN: 0,
      sideBoosterVeMps: 1,
    },
  },
};

export const VEHICLE_ORDER: readonly VehicleId[] = [
  "starship",
  "falcon9",
  "lvm3",
  "saturn5",
] as const;

export const VEHICLE_LIST: readonly VehicleConfig[] = VEHICLE_ORDER.map((id) => VEHICLES[id]);

export const DEFAULT_VEHICLE_ID: VehicleId = "starship";

export function getVehicleConfig(id: VehicleId | string): VehicleConfig {
  if (id in VEHICLES) {
    return VEHICLES[id as VehicleId];
  }
  return VEHICLES.starship;
}

const MARS_STARSHIP_PROFILE: VehiclePropulsionProfile = {
  stackDryAndPayloadKg: 1_250_000,
  boosterPropKg: 1_200_000,
  boosterThrustN: 32_000_000,
  boosterVeMps: 345 * G0,
  shipDryKg: 200_000,
  shipPropKg: 750_000,
  shipThrustN: 10_500_000,
  shipVeMps: 382 * G0,
  maxGLoadMps2: 3.4 * G0,
  stage1TurnAltEndM: 32_000,
  stage1MaxTurnRad: 0.9,
  boosterRtlsDryKg: 220_000,
  boosterRtlsMaxAccel: 34.0,
  dragCoeff: 0.000018,
  sideBoosterDryKg: 0,
  sideBoosterPropKg: 0,
  sideBoosterThrustN: 0,
  sideBoosterVeMps: 1,
};

const MOON_STARSHIP_PROFILE: VehiclePropulsionProfile = {
  stackDryAndPayloadKg: 1_000_000,
  boosterPropKg: 420_000,
  boosterThrustN: 12_500_000,
  boosterVeMps: 345 * G0,
  shipDryKg: 200_000,
  shipPropKg: 500_000,
  shipThrustN: 6_500_000,
  shipVeMps: 382 * G0,
  maxGLoadMps2: 3.0 * G0,
  stage1TurnAltEndM: 14_000,
  stage1MaxTurnRad: 0.96,
  boosterRtlsDryKg: 115_000,
  boosterRtlsMaxAccel: 26.0,
  dragCoeff: 0.0,
  sideBoosterDryKg: 0,
  sideBoosterPropKg: 0,
  sideBoosterThrustN: 0,
  sideBoosterVeMps: 1,
};

export function getVehicleLaunchProfile(
  vehicleId: VehicleId,
  planetId: PlanetId
): VehiclePropulsionProfile {
  if (planetId === "earth") {
    return getVehicleConfig(vehicleId).earthProfile;
  }
  const base = planetId === "mars" ? MARS_STARSHIP_PROFILE : MOON_STARSHIP_PROFILE;
  if (vehicleId === "starship") {
    return base;
  }
  const ep = getVehicleConfig(vehicleId).earthProfile;
  const starEp = VEHICLES.starship.earthProfile;
  const massRatio = ep.stackDryAndPayloadKg / starEp.stackDryAndPayloadKg;
  const twrRatio = planetId === "mars" ? 0.55 : 0.35;
  return {
    stackDryAndPayloadKg: ep.stackDryAndPayloadKg,
    boosterPropKg: ep.boosterPropKg * (planetId === "mars" ? 0.45 : 0.25),
    boosterThrustN: ep.boosterThrustN * twrRatio,
    boosterVeMps: ep.boosterVeMps,
    shipDryKg: ep.shipDryKg,
    shipPropKg: ep.shipPropKg * (planetId === "mars" ? 0.58 : 0.38),
    shipThrustN: ep.shipThrustN * (planetId === "mars" ? 0.65 : 0.45),
    shipVeMps: ep.shipVeMps,
    maxGLoadMps2: base.maxGLoadMps2,
    stage1TurnAltEndM: base.stage1TurnAltEndM,
    stage1MaxTurnRad: base.stage1MaxTurnRad,
    boosterRtlsDryKg: ep.boosterRtlsDryKg,
    boosterRtlsMaxAccel: Math.max(18, 28 * Math.min(1.3, 1 / Math.max(0.1, massRatio * 0.25 + 0.75))),
    dragCoeff: planetId === "moon" ? 0.0 : base.dragCoeff,
    sideBoosterDryKg: ep.sideBoosterDryKg,
    sideBoosterPropKg: ep.sideBoosterPropKg * (planetId === "mars" ? 0.45 : 0.25),
    sideBoosterThrustN: ep.sideBoosterThrustN * twrRatio,
    sideBoosterVeMps: ep.sideBoosterVeMps,
  };
}
