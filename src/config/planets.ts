export type PlanetId = "mars" | "earth" | "moon";

export const PLANET_ORDER: readonly PlanetId[] = ["mars", "earth", "moon"] as const;

export interface PlanetPhysics {
  /** Verified NASA Planetary Fact Sheet surface gravity (m/s^2). */
  readonly gravityMps2: number;
  /** Verified NASA Planetary Fact Sheet mean surface pressure (bar). */
  readonly surfacePressureBar: number;
  /** Atmospheric scale height (km); 0 for vacuum. */
  readonly atmosphereScaleHeightKm: number;
  /** Near-surface atmospheric density (kg/m^3). */
  readonly airDensityKgM3: number;
  /** Mean solar irradiance at orbit (W/m^2). */
  readonly solarIrradianceWm2: number;
  readonly atmosphereLabel: string;
  readonly daySkyHint: string;
}

export interface PlanetAtmosphereShaderParams {
  /** Artistic + physical-inspired Rayleigh scattering RGB weights. */
  readonly rayleighCoeff: readonly [number, number, number];
  /** Artistic Mie aerosol/dust forward-scattering weight. */
  readonly mieCoeff: number;
  /** Henyey-Greenstein phase asymmetry factor (-1..1). */
  readonly mieDirectionalG: number;
  /** Overall atmospheric scattering multiplier (0 = vacuum). */
  readonly atmosphereStrength: number;
  readonly zenithColor: string;
  readonly horizonColor: string;
  readonly sunColor: string;
  readonly sunDirection: readonly [number, number, number];
  readonly sunIntensity: number;
  readonly starIntensity: number;
  readonly hasClouds: boolean;
  readonly fogColor: string;
  readonly fogDensity: number;
}

export interface PlanetLightingParams {
  readonly sunLightColor: string;
  readonly sunLightIntensity: number;
  readonly hemiSkyColor: string;
  readonly hemiGroundColor: string;
  readonly hemiIntensity: number;
  readonly exposure: number;
}

export interface PlanetTerrainParams {
  readonly heightScale: number;
  readonly ridgeWeight: number;
  readonly craterWeight: number;
  readonly noiseFrequency: number;
  readonly seed: number;
  readonly soilPalette: readonly [string, string, string];
  readonly dustColor: string;
  readonly baseRoughness: number;
  readonly padConcreteTint: string;
}

export interface PlanetConfig {
  readonly id: PlanetId;
  readonly name: string;
  readonly subtitle: string;
  readonly physics: PlanetPhysics;
  readonly atmosphere: PlanetAtmosphereShaderParams;
  readonly lighting: PlanetLightingParams;
  readonly terrain: PlanetTerrainParams;
}

export const PLANETS: Record<PlanetId, PlanetConfig> = {
  mars: {
    id: "mars",
    name: "MARS",
    subtitle: "Jezero / Arcadia Launch Complex",
    physics: {
      gravityMps2: 3.721,
      surfacePressureBar: 0.00636,
      atmosphereScaleHeightKm: 11.1,
      airDensityKgM3: 0.02,
      solarIrradianceWm2: 586.2,
      atmosphereLabel: "Thin CO₂ (0.6% Earth)",
      daySkyHint: "Butterscotch ochre horizon to deep space zenith",
    },
    atmosphere: {
      rayleighCoeff: [0.68, 0.36, 0.18],
      mieCoeff: 0.022,
      mieDirectionalG: 0.78,
      atmosphereStrength: 0.78,
      zenithColor: "#140b0a",
      horizonColor: "#c87544",
      sunColor: "#ffe4c4",
      sunDirection: [0.62, 0.34, -0.71],
      sunIntensity: 18.0,
      starIntensity: 0.28,
      hasClouds: false,
      fogColor: "#b56c42",
      fogDensity: 0.00022,
    },
    lighting: {
      sunLightColor: "#ffd8b2",
      sunLightIntensity: 2.8,
      hemiSkyColor: "#d9895b",
      hemiGroundColor: "#5a2a19",
      hemiIntensity: 0.72,
      exposure: 1.05,
    },
    terrain: {
      heightScale: 62,
      ridgeWeight: 0.56,
      craterWeight: 0.42,
      noiseFrequency: 0.00145,
      seed: 4201,
      soilPalette: ["#8f4024", "#b55c35", "#4c281c"],
      dustColor: "#c96d40",
      baseRoughness: 0.9,
      padConcreteTint: "#8e7d72",
    },
  },
  earth: {
    id: "earth",
    name: "EARTH",
    subtitle: "Starbase Boca Chica Coastal Pad",
    physics: {
      gravityMps2: 9.807,
      surfacePressureBar: 1.01325,
      atmosphereScaleHeightKm: 8.5,
      airDensityKgM3: 1.225,
      solarIrradianceWm2: 1361.0,
      atmosphereLabel: "Dense N₂/O₂ (1.01 bar)",
      daySkyHint: "Rayleigh sky blue with drifting coastal clouds",
    },
    atmosphere: {
      rayleighCoeff: [0.22, 0.54, 0.98],
      mieCoeff: 0.011,
      mieDirectionalG: 0.82,
      atmosphereStrength: 1.0,
      zenithColor: "#154994",
      horizonColor: "#9fd0f2",
      sunColor: "#fff6e5",
      sunDirection: [0.58, 0.44, -0.68],
      sunIntensity: 22.0,
      starIntensity: 0.0,
      hasClouds: true,
      fogColor: "#9ccae8",
      fogDensity: 0.00018,
    },
    lighting: {
      sunLightColor: "#fff3df",
      sunLightIntensity: 3.4,
      hemiSkyColor: "#7ab4e8",
      hemiGroundColor: "#364432",
      hemiIntensity: 0.85,
      exposure: 1.0,
    },
    terrain: {
      heightScale: 46,
      ridgeWeight: 0.44,
      craterWeight: 0.0,
      noiseFrequency: 0.00125,
      seed: 7309,
      soilPalette: ["#7d745a", "#415938", "#5b6456"],
      dustColor: "#9e9478",
      baseRoughness: 0.86,
      padConcreteTint: "#8a9096",
    },
  },
  moon: {
    id: "moon",
    name: "MOON",
    subtitle: "Shackleton Crater South Pole",
    physics: {
      gravityMps2: 1.625,
      surfacePressureBar: 0.0,
      atmosphereScaleHeightKm: 0.0,
      airDensityKgM3: 0.0,
      solarIrradianceWm2: 1361.0,
      atmosphereLabel: "Hard Vacuum (Airless)",
      daySkyHint: "Pitch-black starfield with harsh solar glare",
    },
    atmosphere: {
      rayleighCoeff: [0.0, 0.0, 0.0],
      mieCoeff: 0.0,
      mieDirectionalG: 0.9,
      atmosphereStrength: 0.0,
      zenithColor: "#010205",
      horizonColor: "#030408",
      sunColor: "#ffffff",
      sunDirection: [0.66, 0.36, -0.66],
      sunIntensity: 26.0,
      starIntensity: 1.0,
      hasClouds: false,
      fogColor: "#000000",
      fogDensity: 0.0,
    },
    lighting: {
      sunLightColor: "#ffffff",
      sunLightIntensity: 3.8,
      hemiSkyColor: "#252932",
      hemiGroundColor: "#14161a",
      hemiIntensity: 0.24,
      exposure: 1.02,
    },
    terrain: {
      heightScale: 78,
      ridgeWeight: 0.38,
      craterWeight: 0.88,
      noiseFrequency: 0.0016,
      seed: 9103,
      soilPalette: ["#7c8087", "#a0a5ad", "#43464d"],
      dustColor: "#8b9099",
      baseRoughness: 0.94,
      padConcreteTint: "#777c84",
    },
  },
};

export function getPlanetConfig(id: PlanetId): PlanetConfig {
  return PLANETS[id];
}
