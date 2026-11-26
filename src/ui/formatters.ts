import { type PlanetId, getPlanetConfig } from "../config/planets";
import type { BoosterState, MissionMode } from "../sim/FlightController";

export interface LaunchSiteMeta {
  readonly id: string;
  readonly planetId: PlanetId;
  readonly name: string;
  readonly shortName: string;
  readonly region: string;
  readonly latDeg: number;
  readonly lonDeg: number;
  readonly padElevationM: number;
  readonly summary: string;
}

export interface VehicleMeta {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly heightM: number;
  readonly enginesSummary: string;
  readonly rtlsCapable: boolean;
  readonly summary: string;
}

export const SITE_CATALOG: readonly LaunchSiteMeta[] = [
  {
    id: "earth-starbase",
    planetId: "earth",
    name: "Starbase Boca Chica",
    shortName: "STARBASE",
    region: "Texas Gulf Coast, USA",
    latDeg: 25.997,
    lonDeg: -97.156,
    padElevationM: 18.0,
    summary: "18 m Orbital Launch Mount, Mechazilla catch tower & coastal tank farm",
  },
  {
    id: "moon-shackleton",
    planetId: "moon",
    name: "Shackleton Rim Base",
    shortName: "SHACKLETON",
    region: "Lunar South Pole",
    latDeg: -89.5,
    lonDeg: 0.0,
    padElevationM: 1.6,
    summary: "Sintered regolith pad with 360° ejecta berm & vertical solar outpost",
  },
  {
    id: "mars-jezero",
    planetId: "mars",
    name: "Jezero / Arcadia Complex",
    shortName: "JEZERO",
    region: "Isidis–Arcadia Margin",
    latDeg: 18.38,
    lonDeg: 77.58,
    padElevationM: 2.2,
    summary: "Octagonal sintered pad with geodesic domes & Sabatier ISRU plant",
  },
];

export const VEHICLE_CATALOG: readonly VehicleMeta[] = [
  {
    id: "starship-sh",
    name: "Starship + Super Heavy",
    shortName: "STARSHIP",
    heightM: 121,
    enginesSummary: "33 Booster + 6 Ship Raptors",
    rtlsCapable: true,
    summary: "Full-stack reusable heavy lift with 18% reserve autonomous Booster RTLS",
  },
];

export const DEFAULT_VEHICLE_ID = VEHICLE_CATALOG[0].id;

export function getDefaultSiteForPlanet(planetId: PlanetId): LaunchSiteMeta {
  return SITE_CATALOG.find((s) => s.planetId === planetId) ?? SITE_CATALOG[0];
}

export function getVehicleById(id: string): VehicleMeta {
  return VEHICLE_CATALOG.find((v) => v.id === id) ?? VEHICLE_CATALOG[0];
}

export function formatTClock(tSec: number): string {
  const sign = tSec < 0 ? "-" : "+";
  const abs = Math.abs(tSec);
  const mins = Math.floor(abs / 60);
  const secs = abs % 60;
  return `T${sign}${String(mins).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;
}

export function formatAltitude(altM: number): string {
  if (!Number.isFinite(altM)) return "—";
  if (Math.abs(altM) >= 1000) {
    return `${(altM / 1000).toFixed(2)} km`;
  }
  return `${altM.toFixed(1)} m`;
}

export function formatCompactAltitude(altM: number): string {
  if (!Number.isFinite(altM)) return "—";
  if (Math.abs(altM) >= 1000) {
    return `${(altM / 1000).toFixed(1)}k`;
  }
  return `${Math.round(altM)}m`;
}

export function formatSpeed(speedMps: number): string {
  if (!Number.isFinite(speedMps)) return "—";
  return `${speedMps.toFixed(1)} m/s`;
}

export function formatSignedVelocity(vMps: number): string {
  if (!Number.isFinite(vMps)) return "—";
  const sign = vMps >= 0 ? "+" : "";
  return `${sign}${vMps.toFixed(1)} m/s`;
}

export function formatOrbitalAltitude(altM: number): string {
  if (!Number.isFinite(altM)) return "ESCAPE";
  if (altM <= 0) return "SUBORB";
  return altM >= 1000 ? `${(altM / 1000).toFixed(2)} km` : `${altM.toFixed(0)} m`;
}

export function formatDynamicPressure(qPa: number): string {
  if (!Number.isFinite(qPa)) return "—";
  return `${(qPa / 1000).toFixed(2)} kPa`;
}

export function formatCoordinates(latDeg: number, lonDeg: number): string {
  const ns = latDeg >= 0 ? "N" : "S";
  const ew = lonDeg >= 0 ? "E" : "W";
  return `${Math.abs(latDeg).toFixed(2)}°${ns}, ${Math.abs(lonDeg).toFixed(2)}°${ew}`;
}

export function formatMissionPillLabel(
  planetId: PlanetId,
  missionMode: MissionMode,
  vehicleShort = VEHICLE_CATALOG[0].shortName,
  siteShort?: string
): string {
  const planet = getPlanetConfig(planetId).name;
  const site = siteShort ?? getDefaultSiteForPlanet(planetId).shortName;
  const mode = missionMode === "launch" ? "LAUNCH" : "LANDING";
  return `${planet} · ${site} · ${vehicleShort} · ${mode}`;
}

export function formatBoosterStatusLabel(booster: BoosterState): {
  text: string;
  tone: "neutral" | "active" | "ok" | "fail";
} {
  if (booster.status === "BOOSTER_CAUGHT" || booster.status === "BOOSTER_LANDED") {
    const off = booster.touchdownOffsetM?.toFixed(1) ?? "0.0";
    const vy = booster.touchdownVerticalSpeedMps?.toFixed(1) ?? "0.0";
    return {
      text:
        booster.status === "BOOSTER_CAUGHT"
          ? `BSTR: CAUGHT (${off}m · ${vy}m/s)`
          : `BSTR: LANDED (${off}m · ${vy}m/s)`,
      tone: "ok",
    };
  }
  if (booster.status === "BOOSTER_CRASHED") {
    return { text: "BSTR: CRASHED", tone: "fail" };
  }
  if (booster.status === "BOOSTER_EXPENDED") {
    return { text: "STG 1: EXPENDED", tone: "neutral" };
  }
  if (booster.status !== "ATTACHED" && booster.status !== "NONE") {
    const label =
      booster.status === "BOOSTER_FLIP"
        ? "RTLS FLIP"
        : booster.status === "BOOSTER_BOOSTBACK"
          ? "BOOSTBACK"
          : booster.status === "BOOSTER_DESCENT"
            ? "DESCENT"
            : "LANDING BURN";
    const altLabel =
      booster.altitudeM >= 1000
        ? `${(booster.altitudeM / 1000).toFixed(1)}km`
        : `${booster.altitudeM.toFixed(0)}m`;
    return {
      text: `BSTR: ${label} · ${altLabel}`,
      tone: "active",
    };
  }
  return {
    text: `BSTR: ${booster.status}`,
    tone: "neutral",
  };
}

const REDUCED_MOTION_STORAGE_KEY = "aethersim.reducedMotion";

export function resolveReducedMotion(
  systemPrefersReduced: boolean,
  userOverride: boolean | null
): boolean {
  return userOverride !== null ? userOverride : systemPrefersReduced;
}

export function loadReducedMotionOverride(): boolean | null {
  try {
    const raw = window.localStorage.getItem(REDUCED_MOTION_STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    return null;
  }
}

export function saveReducedMotionOverride(val: boolean | null): void {
  try {
    if (val === null) {
      window.localStorage.removeItem(REDUCED_MOTION_STORAGE_KEY);
    } else {
      window.localStorage.setItem(REDUCED_MOTION_STORAGE_KEY, String(val));
    }
  } catch {
    // Ignore storage unavailability in restricted contexts
  }
}

export function applyReducedMotionToDocument(enabled: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.reducedMotion = enabled ? "true" : "false";
}
