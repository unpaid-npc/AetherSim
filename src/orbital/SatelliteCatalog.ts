import * as THREE from "three";
import {
  type OMMJsonObject,
  type SatRec,
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
} from "satellite.js";
import type { PlanetId } from "../config/planets";
import { geoToSphereUnitVector } from "../scene/earthGeography";

export type OrbitalCategory =
  | "station"
  | "science"
  | "earth_obs"
  | "nav_geo"
  | "starlink";

export type OrbitalDataSource =
  | "live_celestrak"
  | "cached_celestrak"
  | "simulated";

export type OrbitalMeshStyle =
  | "iss"
  | "tiangong"
  | "hubble"
  | "earth_obs"
  | "gps"
  | "geo"
  | "starlink"
  | "gateway"
  | "orbiter";

export interface KeplerianFallbackParams {
  readonly semiMajorAxisKm: number;
  readonly eccentricity: number;
  readonly inclinationDeg: number;
  readonly raanDeg: number;
  readonly argPerigeeDeg: number;
  readonly meanAnomalyEpochDeg: number;
  readonly periodMin: number;
  /** Planet sidereal rotation rate in deg/sec (for ground-track motion). */
  readonly planetRotationDegPerSec: number;
}

export interface SatelliteDefinition {
  readonly id: string;
  readonly planetId: PlanetId;
  readonly name: string;
  readonly shortName: string;
  readonly noradId: number | null;
  readonly operator: string;
  readonly category: OrbitalCategory;
  readonly meshStyle: OrbitalMeshStyle;
  readonly accentHex: string;
  readonly inspectRadiusM: number;
  readonly description: string;
  readonly fallbackOmm?: OMMJsonObject;
  readonly keplerianFallback?: KeplerianFallbackParams;
}

export interface SatelliteStateSnapshot {
  readonly id: string;
  readonly planetId: PlanetId;
  readonly name: string;
  readonly shortName: string;
  readonly noradId: number | null;
  readonly operator: string;
  readonly category: OrbitalCategory;
  readonly meshStyle: OrbitalMeshStyle;
  readonly accentHex: string;
  readonly inspectRadiusM: number;
  readonly description: string;
  readonly dataSource: OrbitalDataSource;
  readonly lastUpdatedUtc: string;
  readonly tleEpochUtc: string;
  readonly altitudeKm: number;
  readonly velocityKms: number;
  readonly inclinationDeg: number;
  readonly periodMin: number;
  readonly apogeeKm: number;
  readonly perigeeKm: number;
  readonly latDeg: number;
  readonly lonDeg: number;
  readonly rangeFromSiteKm: number;
  readonly worldPos: { readonly x: number; readonly y: number; readonly z: number };
  readonly velocityDir: { readonly x: number; readonly y: number; readonly z: number };
}

export interface OrbitalProvenanceSummary {
  readonly dataSource: OrbitalDataSource;
  readonly lastUpdatedUtc: string;
  readonly liveCount: number;
  readonly totalCatalogCount: number;
  readonly fetching: boolean;
  readonly lastError: string | null;
}

export interface RuntimeSatelliteEntry {
  readonly def: SatelliteDefinition;
  satrec: SatRec | null;
  ommEpochMs: number;
  tleEpochUtc: string;
  dataSource: OrbitalDataSource;
  lastUpdatedUtc: string;
  inclinationDeg: number;
  periodMin: number;
  apogeeKm: number;
  perigeeKm: number;
}

export const GROUND_TRACK_OFFSET_M = 1_800;

const EARTH_MU_KM3_S2 = 398_600.4418;
const EARTH_MEAN_RADIUS_KM = 6_371.0;
const FALLBACK_EPOCH_ISO = "2026-11-25T12:00:00.000000";
const FALLBACK_EPOCH_MS = Date.parse("2026-11-25T12:00:00.000Z");

function makeFallbackOmm(params: {
  name: string;
  objectId: string;
  noradId: number;
  meanMotion: number;
  eccentricity: number;
  inclinationDeg: number;
  raanDeg: number;
  argPericenterDeg: number;
  meanAnomalyDeg: number;
  bstar?: number;
}): OMMJsonObject {
  return {
    OBJECT_NAME: params.name,
    OBJECT_ID: params.objectId,
    EPOCH: FALLBACK_EPOCH_ISO,
    MEAN_MOTION: params.meanMotion,
    ECCENTRICITY: params.eccentricity,
    INCLINATION: params.inclinationDeg,
    RA_OF_ASC_NODE: params.raanDeg,
    ARG_OF_PERICENTER: params.argPericenterDeg,
    MEAN_ANOMALY: params.meanAnomalyDeg,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: "U",
    NORAD_CAT_ID: params.noradId,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 10000,
    BSTAR: params.bstar ?? 0.00008,
    MEAN_MOTION_DOT: 0.000012,
    MEAN_MOTION_DDOT: 0,
  };
}

const STARLINK_TRAIN_DEFS: SatelliteDefinition[] = Array.from({ length: 6 }, (_, i) => ({
  id: `starlink_${i + 1}`,
  planetId: "earth",
  name: `Starlink-310${i + 1} (Demo Train)`,
  shortName: i === 0 ? "STARLINK TRAIN" : `STARLINK-${i + 1}`,
  noradId: null,
  operator: "SpaceX (Demo Train)",
  category: "starlink",
  meshStyle: "starlink",
  accentHex: "#94a3b8",
  inspectRadiusM: 28,
  description: "Representative LEO broadband constellation plane demonstrating orbital train spacing at 550 km",
  fallbackOmm: makeFallbackOmm({
    name: `STARLINK-310${i + 1}`,
    objectId: `2025-090${String.fromCharCode(65 + i)}`,
    noradId: 90101 + i,
    meanMotion: 15.0641,
    eccentricity: 0.00014,
    inclinationDeg: 53.215,
    raanDeg: 212.0,
    argPericenterDeg: 90.0,
    meanAnomalyDeg: 40.0 + i * 2.1,
    bstar: 0.00004,
  }),
}));

export const EARTH_SATELLITE_DEFINITIONS: readonly SatelliteDefinition[] = [
  {
    id: "iss",
    planetId: "earth",
    name: "ISS (ZARYA)",
    shortName: "ISS",
    noradId: 25544,
    operator: "NASA / Roscosmos / ESA / JAXA / CSA",
    category: "station",
    meshStyle: "iss",
    accentHex: "#38bdf8",
    inspectRadiusM: 76,
    description: "International Space Station modular orbital laboratory cruising at ~420 km LEO (51.6° inclination)",
    fallbackOmm: makeFallbackOmm({
      name: "ISS (ZARYA)",
      objectId: "1998-067A",
      noradId: 25544,
      meanMotion: 15.4956,
      eccentricity: 0.00052,
      inclinationDeg: 51.6416,
      raanDeg: 148.5,
      argPericenterDeg: 62.4,
      meanAnomalyDeg: 298.0,
      bstar: 0.00014,
    }),
  },
  {
    id: "tiangong",
    planetId: "earth",
    name: "Tiangong (CSS / Tianhe)",
    shortName: "TIANGONG",
    noradId: 48274,
    operator: "CMSA",
    category: "station",
    meshStyle: "tiangong",
    accentHex: "#22d3ee",
    inspectRadiusM: 52,
    description: "China Space Station modular orbital outpost orbiting at ~390 km LEO (41.5° inclination)",
    fallbackOmm: makeFallbackOmm({
      name: "CSS (TIANHE)",
      objectId: "2021-035A",
      noradId: 48274,
      meanMotion: 15.589,
      eccentricity: 0.00045,
      inclinationDeg: 41.4745,
      raanDeg: 24.2,
      argPericenterDeg: 118.0,
      meanAnomalyDeg: 144.0,
      bstar: 0.00016,
    }),
  },
  {
    id: "hubble",
    planetId: "earth",
    name: "Hubble Space Telescope (HST)",
    shortName: "HUBBLE",
    noradId: 20580,
    operator: "NASA / ESA",
    category: "science",
    meshStyle: "hubble",
    accentHex: "#a78bfa",
    inspectRadiusM: 34,
    description: "Flagship 2.4 m optical/UV space observatory in 535 km low-inclination LEO (28.5°)",
    fallbackOmm: makeFallbackOmm({
      name: "HST",
      objectId: "1990-037B",
      noradId: 20580,
      meanMotion: 15.1072,
      eccentricity: 0.00028,
      inclinationDeg: 28.4692,
      raanDeg: 285.0,
      argPericenterDeg: 185.0,
      meanAnomalyDeg: 52.0,
      bstar: 0.00005,
    }),
  },
  {
    id: "sentinel2a",
    planetId: "earth",
    name: "Sentinel-2A",
    shortName: "SENTINEL-2A",
    noradId: 40697,
    operator: "ESA / Copernicus",
    category: "earth_obs",
    meshStyle: "earth_obs",
    accentHex: "#34d399",
    inspectRadiusM: 32,
    description: "10 m multispectral Copernicus land-monitoring satellite in 786 km Sun-synchronous polar orbit",
    fallbackOmm: makeFallbackOmm({
      name: "SENTINEL-2A",
      objectId: "2015-028A",
      noradId: 40697,
      meanMotion: 14.3082,
      eccentricity: 0.00012,
      inclinationDeg: 98.568,
      raanDeg: 42.0,
      argPericenterDeg: 90.0,
      meanAnomalyDeg: 215.0,
      bstar: 0.00002,
    }),
  },
  {
    id: "noaa20",
    planetId: "earth",
    name: "NOAA-20 (JPSS-1)",
    shortName: "NOAA-20",
    noradId: 43013,
    operator: "NOAA / NASA",
    category: "earth_obs",
    meshStyle: "earth_obs",
    accentHex: "#4ade80",
    inspectRadiusM: 32,
    description: "Polar-orbiting operational weather & atmospheric sounder at 824 km SSO (98.7°)",
    fallbackOmm: makeFallbackOmm({
      name: "NOAA 20",
      objectId: "2017-073A",
      noradId: 43013,
      meanMotion: 14.1956,
      eccentricity: 0.00015,
      inclinationDeg: 98.742,
      raanDeg: 102.0,
      argPericenterDeg: 72.0,
      meanAnomalyDeg: 322.0,
      bstar: 0.00002,
    }),
  },
  {
    id: "gps3_sv01",
    planetId: "earth",
    name: "GPS III SV01",
    shortName: "GPS III SV01",
    noradId: 43873,
    operator: "US Space Force",
    category: "nav_geo",
    meshStyle: "gps",
    accentHex: "#fbbf24",
    inspectRadiusM: 36,
    description: "Medium Earth Orbit (20,200 km, 55°) next-generation PNT navigation spacecraft",
    fallbackOmm: makeFallbackOmm({
      name: "GPS BIII-1 (NAVSTAR 77)",
      objectId: "2018-109A",
      noradId: 43873,
      meanMotion: 2.00563,
      eccentricity: 0.0018,
      inclinationDeg: 55.021,
      raanDeg: 168.0,
      argPericenterDeg: 38.0,
      meanAnomalyDeg: 112.0,
      bstar: 0.0,
    }),
  },
  {
    id: "goes16",
    planetId: "earth",
    name: "GOES-16",
    shortName: "GOES-16",
    noradId: 41866,
    operator: "NOAA / NASA",
    category: "nav_geo",
    meshStyle: "geo",
    accentHex: "#f59e0b",
    inspectRadiusM: 38,
    description: "Geostationary Earth weather satellite stationed at ~35,786 km altitude over the Americas",
    fallbackOmm: makeFallbackOmm({
      name: "GOES 16",
      objectId: "2016-071A",
      noradId: 41866,
      meanMotion: 1.002701,
      eccentricity: 0.00012,
      inclinationDeg: 0.048,
      raanDeg: 74.0,
      argPericenterDeg: 120.0,
      meanAnomalyDeg: 165.0,
      bstar: 0.0,
    }),
  },
  ...STARLINK_TRAIN_DEFS,
];

export const MOON_SATELLITE_DEFINITIONS: readonly SatelliteDefinition[] = [
  {
    id: "lunar_gateway",
    planetId: "moon",
    name: "Lunar Gateway (Simulated)",
    shortName: "GATEWAY",
    noradId: null,
    operator: "NASA / ESA / JAXA / CSA (Simulated)",
    category: "station",
    meshStyle: "gateway",
    accentHex: "#38bdf8",
    inspectRadiusM: 58,
    description: "Simulated cislunar staging outpost in an elliptical polar NRHO-inspired halo orbit",
    keplerianFallback: {
      semiMajorAxisKm: 1737.4 + 920,
      eccentricity: 0.28,
      inclinationDeg: 86.0,
      raanDeg: 32.0,
      argPerigeeDeg: 270.0,
      meanAnomalyEpochDeg: 45.0,
      periodMin: 215.0,
      planetRotationDegPerSec: 0.0001525,
    },
  },
  {
    id: "lro",
    planetId: "moon",
    name: "Lunar Reconnaissance Orbiter (LRO)",
    shortName: "LRO",
    noradId: null,
    operator: "NASA (Simulated)",
    category: "science",
    meshStyle: "orbiter",
    accentHex: "#a78bfa",
    inspectRadiusM: 32,
    description: "Simulated 100 km polar lunar mapping & Shackleton South Pole reconnaissance orbiter",
    keplerianFallback: {
      semiMajorAxisKm: 1737.4 + 100,
      eccentricity: 0.004,
      inclinationDeg: 89.5,
      raanDeg: 118.0,
      argPerigeeDeg: 15.0,
      meanAnomalyEpochDeg: 190.0,
      periodMin: 118.0,
      planetRotationDegPerSec: 0.0001525,
    },
  },
];

export const MARS_SATELLITE_DEFINITIONS: readonly SatelliteDefinition[] = [
  {
    id: "mars_transfer_station",
    planetId: "mars",
    name: "Mars Orbital Transfer Station",
    shortName: "MARS STATION",
    noradId: null,
    operator: "AetherSim Deep Space (Simulated)",
    category: "station",
    meshStyle: "gateway",
    accentHex: "#fb923c",
    inspectRadiusM: 64,
    description: "Simulated low-Mars-orbit refueling & crew transfer station with centrifugal habitat ring",
    keplerianFallback: {
      semiMajorAxisKm: 3389.5 + 320,
      eccentricity: 0.005,
      inclinationDeg: 18.5,
      raanDeg: 74.0,
      argPerigeeDeg: 20.0,
      meanAnomalyEpochDeg: 105.0,
      periodMin: 114.8,
      planetRotationDegPerSec: 0.004061,
    },
  },
  {
    id: "mro",
    planetId: "mars",
    name: "Mars Reconnaissance Orbiter (MRO)",
    shortName: "MRO",
    noradId: null,
    operator: "NASA JPL (Simulated)",
    category: "science",
    meshStyle: "orbiter",
    accentHex: "#34d399",
    inspectRadiusM: 34,
    description: "Simulated ~300 km near-polar HiRISE imaging & relay orbiter around Mars",
    keplerianFallback: {
      semiMajorAxisKm: 3389.5 + 300,
      eccentricity: 0.008,
      inclinationDeg: 92.6,
      raanDeg: 165.0,
      argPerigeeDeg: 90.0,
      meanAnomalyEpochDeg: 260.0,
      periodMin: 112.0,
      planetRotationDegPerSec: 0.004061,
    },
  },
];

export const ALL_SATELLITE_DEFINITIONS: readonly SatelliteDefinition[] = [
  ...EARTH_SATELLITE_DEFINITIONS,
  ...MOON_SATELLITE_DEFINITIONS,
  ...MARS_SATELLITE_DEFINITIONS,
];

export function getSatelliteDefinitionsForPlanet(
  planetId: PlanetId
): readonly SatelliteDefinition[] {
  if (planetId === "earth") return EARTH_SATELLITE_DEFINITIONS;
  if (planetId === "moon") return MOON_SATELLITE_DEFINITIONS;
  return MARS_SATELLITE_DEFINITIONS;
}

export function getPrimaryStationIdForPlanet(planetId: PlanetId): string {
  if (planetId === "earth") return "iss";
  if (planetId === "moon") return "lunar_gateway";
  return "mars_transfer_station";
}

export function formatUtcTimestamp(input: Date | number | string): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    return "Unknown UTC";
  }
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

export function normalizeLonDeg(lonDeg: number): number {
  let l = ((lonDeg + 180) % 360 + 360) % 360 - 180;
  if (l === -180) l = 180;
  return l;
}

function computeOmmApsidesAndPeriod(omm: OMMJsonObject): {
  inclinationDeg: number;
  periodMin: number;
  apogeeKm: number;
  perigeeKm: number;
} {
  const meanMotionRevDay = Math.max(0.05, Number(omm.MEAN_MOTION) || 15.0);
  const ecc = Math.max(0, Math.min(0.95, Number(omm.ECCENTRICITY) || 0));
  const inc = Number(omm.INCLINATION) || 0;
  const periodMin = 1440 / meanMotionRevDay;
  const nRadS = (meanMotionRevDay * 2 * Math.PI) / 86400;
  const aKm = Math.cbrt(EARTH_MU_KM3_S2 / (nRadS * nRadS));
  const apogeeKm = Math.max(0, aKm * (1 + ecc) - EARTH_MEAN_RADIUS_KM);
  const perigeeKm = Math.max(0, aKm * (1 - ecc) - EARTH_MEAN_RADIUS_KM);
  return { inclinationDeg: inc, periodMin, apogeeKm, perigeeKm };
}

export function parseOmmEpochMs(epochStr: string | undefined): number {
  if (!epochStr) return FALLBACK_EPOCH_MS;
  const normalized = epochStr.endsWith("Z") ? epochStr : `${epochStr}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : FALLBACK_EPOCH_MS;
}

export function createRuntimeSatelliteEntry(
  def: SatelliteDefinition,
  liveOmm?: OMMJsonObject,
  dataSource: OrbitalDataSource = "simulated",
  lastUpdatedUtc: string = formatUtcTimestamp(new Date())
): RuntimeSatelliteEntry {
  if (def.planetId === "earth") {
    const omm = liveOmm ?? def.fallbackOmm;
    let satrec: SatRec | null = null;
    if (omm) {
      try {
        satrec = json2satrec(omm);
      } catch {
        satrec = def.fallbackOmm ? json2satrec(def.fallbackOmm) : null;
      }
    }
    const effectiveOmm = omm ?? def.fallbackOmm!;
    const derived = computeOmmApsidesAndPeriod(effectiveOmm);
    const epochMs = parseOmmEpochMs(effectiveOmm.EPOCH);
    const isRealLive = Boolean(liveOmm) && dataSource !== "simulated";
    return {
      def,
      satrec,
      ommEpochMs: epochMs,
      tleEpochUtc: isRealLive
        ? formatUtcTimestamp(epochMs)
        : "Approximate Simulated Epoch",
      dataSource: isRealLive ? dataSource : "simulated",
      lastUpdatedUtc,
      inclinationDeg: derived.inclinationDeg,
      periodMin: derived.periodMin,
      apogeeKm: derived.apogeeKm,
      perigeeKm: derived.perigeeKm,
    };
  }

  const kep = def.keplerianFallback!;
  const planetRadiusKm = def.planetId === "moon" ? 1737.4 : 3389.5;
  const apogeeKm = Math.max(0, kep.semiMajorAxisKm * (1 + kep.eccentricity) - planetRadiusKm);
  const perigeeKm = Math.max(0, kep.semiMajorAxisKm * (1 - kep.eccentricity) - planetRadiusKm);

  return {
    def,
    satrec: null,
    ommEpochMs: FALLBACK_EPOCH_MS,
    tleEpochUtc: "Approximate Simulated Epoch",
    dataSource: "simulated",
    lastUpdatedUtc,
    inclinationDeg: kep.inclinationDeg,
    periodMin: kep.periodMin,
    apogeeKm,
    perigeeKm,
  };
}

/**
 * Transforms planet-surface geodetic (latDeg, lonDeg, altM) into AetherSim's
 * 1:1 Float64 ENU world frame where the launch site sits at (0, 0, 0) and planet center at (0, -simRadiusM, 0).
 */
export function geodeticToPlanetWorld(
  latDeg: number,
  lonDeg: number,
  altM: number,
  simRadiusM: number,
  zenithQuat: THREE.Quaternion,
  scratchVec = new THREE.Vector3()
): { x: number; y: number; z: number } {
  const [ux, uy, uz] = geoToSphereUnitVector(latDeg, lonDeg);
  scratchVec.set(ux, uy, uz).applyQuaternion(zenithQuat);
  const r = simRadiusM + altM;
  return {
    x: scratchVec.x * r,
    y: scratchVec.y * r - simRadiusM,
    z: scratchVec.z * r,
  };
}

function solveKeplerEccentricAnomaly(M: number, e: number): number {
  let E = M;
  for (let i = 0; i < 6; i++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    E -= f / Math.max(1e-6, fp);
  }
  return E;
}

export interface PropagatedGeodeticPoint {
  readonly latDeg: number;
  readonly lonDeg: number;
  readonly altKm: number;
  readonly velKms: number;
}

/**
 * Propagates an Earth SGP4 entry or Moon/Mars Keplerian orbiter to `sampleDate`.
 * When `fixedGmstDate` is provided (for inertial 3D orbital rings), Earth's rotation
 * angle is held fixed at `fixedGmstDate` so the closed 3D orbital ellipse passes directly
 * through the satellite's instantaneous position.
 */
export function propagateSatelliteGeodetic(
  entry: RuntimeSatelliteEntry,
  sampleDate: Date,
  fixedGmstDate?: Date
): PropagatedGeodeticPoint | null {
  if (entry.def.planetId === "earth" && entry.satrec) {
    let effectiveDate = sampleDate;
    const maxAgeMs = 150 * 86_400_000;
    if (
      entry.dataSource === "simulated" &&
      Math.abs(sampleDate.getTime() - entry.ommEpochMs) > maxAgeMs
    ) {
      const periodMs = Math.max(60_000, entry.periodMin * 60_000);
      const phaseMs =
        (((sampleDate.getTime() - entry.ommEpochMs) % periodMs) + periodMs) % periodMs;
      effectiveDate = new Date(entry.ommEpochMs + phaseMs);
    }

    let pv = propagate(entry.satrec, effectiveDate);
    if (!pv || !Number.isFinite(pv.position.x)) {
      const periodMs = Math.max(60_000, entry.periodMin * 60_000);
      const phaseMs =
        (((sampleDate.getTime() - entry.ommEpochMs) % periodMs) + periodMs) % periodMs;
      effectiveDate = new Date(entry.ommEpochMs + phaseMs);
      pv = propagate(entry.satrec, effectiveDate);
      if (!pv || !Number.isFinite(pv.position.x)) {
        return null;
      }
    }

    const gmstRef = fixedGmstDate ?? sampleDate;
    const gmst = gstime(
      entry.dataSource === "simulated" && Math.abs(gmstRef.getTime() - entry.ommEpochMs) > maxAgeMs
        ? effectiveDate
        : gmstRef
    );
    const geo = eciToGeodetic(pv.position, gmst);
    const latDeg = degreesLat(geo.latitude);
    const lonDeg = normalizeLonDeg(degreesLong(geo.longitude));
    const altKm = geo.height;
    const velKms = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || !Number.isFinite(altKm)) {
      return null;
    }
    return { latDeg, lonDeg, altKm, velKms };
  }

  const kep = entry.def.keplerianFallback;
  if (!kep) return null;

  const planetRadiusKm = entry.def.planetId === "moon" ? 1737.4 : 3389.5;
  const planetMuKm3S2 = entry.def.planetId === "moon" ? 4902.8 : 42828.37;
  const periodSec = Math.max(60, kep.periodMin * 60);
  const dtSec = (sampleDate.getTime() - entry.ommEpochMs) / 1000;
  const M0 = THREE.MathUtils.degToRad(kep.meanAnomalyEpochDeg);
  const M = ((M0 + (2 * Math.PI * dtSec) / periodSec) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const E = solveKeplerEccentricAnomaly(M, kep.eccentricity);

  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const sqrt1MinusE2 = Math.sqrt(Math.max(1e-6, 1 - kep.eccentricity * kep.eccentricity));
  const nu = Math.atan2(sqrt1MinusE2 * sinE, cosE - kep.eccentricity);
  const rKm = kep.semiMajorAxisKm * (1 - kep.eccentricity * cosE);

  const inc = THREE.MathUtils.degToRad(kep.inclinationDeg);
  const raan = THREE.MathUtils.degToRad(kep.raanDeg);
  const argP = THREE.MathUtils.degToRad(kep.argPerigeeDeg);
  const u = argP + nu;

  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosO = Math.cos(raan);
  const sinO = Math.sin(raan);
  const cosI = Math.cos(inc);
  const sinI = Math.sin(inc);

  const xInert = rKm * (cosO * cosU - sinO * sinU * cosI);
  const yInert = rKm * (sinO * cosU + cosO * sinU * cosI);
  const zInert = rKm * (sinU * sinI);

  const rotRefSec = ((fixedGmstDate ?? sampleDate).getTime() - entry.ommEpochMs) / 1000;
  const rotRad = THREE.MathUtils.degToRad(kep.planetRotationDegPerSec * rotRefSec);
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const xFix = xInert * cosR + yInert * sinR;
  const yFix = -xInert * sinR + yInert * cosR;
  const zFix = zInert;

  const latDeg = THREE.MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, zFix / Math.max(1, rKm)))));
  const lonDeg = normalizeLonDeg(THREE.MathUtils.radToDeg(Math.atan2(yFix, xFix)));
  const altKm = Math.max(10, rKm - planetRadiusKm);
  const velKms = Math.sqrt(Math.max(0.01, planetMuKm3S2 * (2 / rKm - 1 / kep.semiMajorAxisKm)));

  return { latDeg, lonDeg, altKm, velKms };
}

export function evaluateSatelliteSnapshot(
  entry: RuntimeSatelliteEntry,
  simDate: Date,
  simRadiusM: number,
  zenithQuat: THREE.Quaternion,
  padAltM = 0
): SatelliteStateSnapshot | null {
  const nowPt = propagateSatelliteGeodetic(entry, simDate);
  if (!nowPt) return null;

  const scratch = new THREE.Vector3();
  const worldPos = geodeticToPlanetWorld(
    nowPt.latDeg,
    nowPt.lonDeg,
    nowPt.altKm * 1000,
    simRadiusM,
    zenithQuat,
    scratch
  );

  // Sample +2 seconds in inertial frame (fixed GMST) for clean spacecraft forward tangent
  const nextDate = new Date(simDate.getTime() + 2000);
  const nextPt = propagateSatelliteGeodetic(entry, nextDate, simDate);
  let vx = 1;
  let vy = 0;
  let vz = 0;
  if (nextPt) {
    const nextWorld = geodeticToPlanetWorld(
      nextPt.latDeg,
      nextPt.lonDeg,
      nextPt.altKm * 1000,
      simRadiusM,
      zenithQuat,
      scratch
    );
    const dx = nextWorld.x - worldPos.x;
    const dy = nextWorld.y - worldPos.y;
    const dz = nextWorld.z - worldPos.z;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-3) {
      vx = dx / len;
      vy = dy / len;
      vz = dz / len;
    }
  }

  const rangeFromSiteKm =
    Math.hypot(worldPos.x, worldPos.y - padAltM, worldPos.z) / 1000;

  return {
    id: entry.def.id,
    planetId: entry.def.planetId,
    name: entry.def.name,
    shortName: entry.def.shortName,
    noradId: entry.def.noradId,
    operator: entry.def.operator,
    category: entry.def.category,
    meshStyle: entry.def.meshStyle,
    accentHex: entry.def.accentHex,
    inspectRadiusM: entry.def.inspectRadiusM,
    description: entry.def.description,
    dataSource: entry.dataSource,
    lastUpdatedUtc: entry.lastUpdatedUtc,
    tleEpochUtc: entry.tleEpochUtc,
    altitudeKm: nowPt.altKm,
    velocityKms: nowPt.velKms,
    inclinationDeg: entry.inclinationDeg,
    periodMin: entry.periodMin,
    apogeeKm: entry.apogeeKm,
    perigeeKm: entry.perigeeKm,
    latDeg: nowPt.latDeg,
    lonDeg: nowPt.lonDeg,
    rangeFromSiteKm,
    worldPos,
    velocityDir: { x: vx, y: vy, z: vz },
  };
}

/**
 * Samples 1 full closed inertial orbital ring in planet-center-relative meters
 * (centered around `(0, 0, 0)` so the Three.js Line sits cleanly at `planetCenter - renderOrigin`).
 */
export function sampleOrbitalPathPlanetCentered(
  entry: RuntimeSatelliteEntry,
  simDate: Date,
  simRadiusM: number,
  zenithQuat: THREE.Quaternion,
  segments = 128
): Float32Array {
  const out = new Float32Array((segments + 1) * 3);
  const periodMs = Math.max(60_000, entry.periodMin * 60_000);
  const scratch = new THREE.Vector3();
  let lastValidX = 0;
  let lastValidY = simRadiusM + 400_000;
  let lastValidZ = 0;

  for (let i = 0; i <= segments; i++) {
    const frac = i / segments;
    const t = new Date(simDate.getTime() + frac * periodMs);
    const pt = propagateSatelliteGeodetic(entry, t, simDate);
    if (pt) {
      const [ux, uy, uz] = geoToSphereUnitVector(pt.latDeg, pt.lonDeg);
      scratch.set(ux, uy, uz).applyQuaternion(zenithQuat);
      const r = simRadiusM + pt.altKm * 1000;
      lastValidX = scratch.x * r;
      lastValidY = scratch.y * r;
      lastValidZ = scratch.z * r;
    }
    out[i * 3] = lastValidX;
    out[i * 3 + 1] = lastValidY;
    out[i * 3 + 2] = lastValidZ;
  }
  return out;
}

export interface GroundTrackSample {
  /** Planet-center-relative 3D positions at radius `simRadiusM + offsetM`. */
  readonly planetCenteredPoints: Float32Array;
  /** World-frame 3D positions (launch site = (0,0,0), planet center = (0,-simRadiusM,0)). */
  readonly worldPoints: Float64Array;
  readonly latLon: ReadonlyArray<{ readonly latDeg: number; readonly lonDeg: number }>;
}

/**
 * Samples Earth-fixed sub-satellite ground track for ±1 full orbital period
 * projected onto radius `simRadiusM + offsetM` (default `R + 1,800 m`).
 */
export function sampleGroundTrack(
  entry: RuntimeSatelliteEntry,
  simDate: Date,
  simRadiusM: number,
  zenithQuat: THREE.Quaternion,
  segments = 240,
  offsetM = GROUND_TRACK_OFFSET_M
): GroundTrackSample {
  const count = segments + 1;
  const planetCenteredPoints = new Float32Array(count * 3);
  const worldPoints = new Float64Array(count * 3);
  const latLon: Array<{ latDeg: number; lonDeg: number }> = [];
  const periodMs = Math.max(60_000, entry.periodMin * 60_000);
  const scratch = new THREE.Vector3();
  const r = simRadiusM + offsetM;

  let lastX = 0;
  let lastY = r;
  let lastZ = 0;

  for (let i = 0; i <= segments; i++) {
    // Sweep -1 orbit .. +1 orbit around simDate
    const orbitFrac = -1 + (2 * i) / segments;
    const t = new Date(simDate.getTime() + orbitFrac * periodMs);
    const pt = propagateSatelliteGeodetic(entry, t);
    if (pt) {
      latLon.push({ latDeg: pt.latDeg, lonDeg: pt.lonDeg });
      const [ux, uy, uz] = geoToSphereUnitVector(pt.latDeg, pt.lonDeg);
      scratch.set(ux, uy, uz).applyQuaternion(zenithQuat);
      lastX = scratch.x * r;
      lastY = scratch.y * r;
      lastZ = scratch.z * r;
    } else {
      latLon.push({ latDeg: 0, lonDeg: 0 });
    }
    planetCenteredPoints[i * 3] = lastX;
    planetCenteredPoints[i * 3 + 1] = lastY;
    planetCenteredPoints[i * 3 + 2] = lastZ;

    worldPoints[i * 3] = lastX;
    worldPoints[i * 3 + 1] = lastY - simRadiusM;
    worldPoints[i * 3 + 2] = lastZ;
  }

  return { planetCenteredPoints, worldPoints, latLon };
}
