import type { PlanetId } from "./planets";

export type LaunchSiteId =
  | "starbase"
  | "ksc_lc39a"
  | "sriharikota"
  | "kourou"
  | "tanegashima"
  | "baikonur"
  | "moon_shackleton"
  | "mars_jezero";

export type SiteBiome =
  | "gulf_coast"
  | "atlantic_coast"
  | "tropical_coast"
  | "coastal_bluff"
  | "arid_steppe"
  | "lunar_pole"
  | "martian_crater";

export type PadStyle =
  | "starbase_olm"
  | "ksc_fss_ramp"
  | "shar_umbilical"
  | "kourou_gantry"
  | "tanegashima_bluff"
  | "baikonur_tulip"
  | "lunar_regolith"
  | "mars_octagonal";

export interface LaunchSiteConfig {
  readonly id: LaunchSiteId;
  readonly planetId: PlanetId;
  readonly name: string;
  readonly shortName: string;
  readonly country: string;
  readonly region: string;
  readonly latDeg: number;
  readonly lonDeg: number;
  readonly elevationM: number;
  readonly biome: SiteBiome;
  readonly hasOcean: boolean;
  readonly coastAzimuthDeg: number | null;
  readonly padStyle: PadStyle;
  readonly defaultOrbitInclinationDeg: number;
  readonly supportsBoosterCatch: boolean;
  readonly biomeBadge: string;
  readonly description: string;
}

export const LAUNCH_SITES: Record<LaunchSiteId, LaunchSiteConfig> = {
  starbase: {
    id: "starbase",
    planetId: "earth",
    name: "Starbase Boca Chica",
    shortName: "STARBASE",
    country: "USA",
    region: "Boca Chica, Texas, USA",
    latDeg: 25.997,
    lonDeg: -97.156,
    elevationM: 18.0,
    biome: "gulf_coast",
    hasOcean: true,
    coastAzimuthDeg: 90,
    padStyle: "starbase_olm",
    defaultOrbitInclinationDeg: 26.0,
    supportsBoosterCatch: true,
    biomeBadge: "GULF COAST",
    description: "18 m OLM & Mechazilla catch tower beside flat Gulf dunes and Highway 4",
  },
  ksc_lc39a: {
    id: "ksc_lc39a",
    planetId: "earth",
    name: "Kennedy Space Center LC-39A",
    shortName: "KSC LC-39A",
    country: "USA",
    region: "Merritt Island, Florida, USA",
    latDeg: 28.608,
    lonDeg: -80.604,
    elevationM: 12.0,
    biome: "atlantic_coast",
    hasOcean: true,
    coastAzimuthDeg: 90,
    padStyle: "ksc_fss_ramp",
    defaultOrbitInclinationDeg: 28.6,
    supportsBoosterCatch: false,
    biomeBadge: "ATLANTIC ISLAND",
    description: "Historic Apollo & Crew pad with fixed service tower, crew arm & 160 m VAB",
  },
  sriharikota: {
    id: "sriharikota",
    planetId: "earth",
    name: "Satish Dhawan Space Centre",
    shortName: "SDSC SHAR",
    country: "India",
    region: "Sriharikota, Andhra Pradesh, India",
    latDeg: 13.72,
    lonDeg: 80.23,
    elevationM: 8.5,
    biome: "tropical_coast",
    hasOcean: true,
    coastAzimuthDeg: 90,
    padStyle: "shar_umbilical",
    defaultOrbitInclinationDeg: 13.7,
    supportsBoosterCatch: false,
    biomeBadge: "BAY OF BENGAL",
    description: "ISRO Second Launch Pad pedestal & umbilical tower on a lush palm island",
  },
  kourou: {
    id: "kourou",
    planetId: "earth",
    name: "Guiana Space Centre (ELA-4)",
    shortName: "CSG KOUROU",
    country: "French Guiana",
    region: "Kourou, French Guiana",
    latDeg: 5.239,
    lonDeg: -52.768,
    elevationM: 9.0,
    biome: "tropical_coast",
    hasOcean: true,
    coastAzimuthDeg: 45,
    padStyle: "kourou_gantry",
    defaultOrbitInclinationDeg: 5.2,
    supportsBoosterCatch: false,
    biomeBadge: "EQUATORIAL COAST",
    description: "Near-equatorial Atlantic launch corridor bordered by tropical rainforest",
  },
  tanegashima: {
    id: "tanegashima",
    planetId: "earth",
    name: "Tanegashima Space Center",
    shortName: "TANEGASHIMA",
    country: "Japan",
    region: "Kagoshima Prefecture, Japan",
    latDeg: 30.401,
    lonDeg: 130.977,
    elevationM: 10.0,
    biome: "coastal_bluff",
    hasOcean: true,
    coastAzimuthDeg: 90,
    padStyle: "tanegashima_bluff",
    defaultOrbitInclinationDeg: 30.4,
    supportsBoosterCatch: false,
    biomeBadge: "PACIFIC BLUFF",
    description: "JAXA Yoshinobu green coastal bluff pad overlooking the Pacific Ocean",
  },
  baikonur: {
    id: "baikonur",
    planetId: "earth",
    name: "Baikonur Cosmodrome",
    shortName: "BAIKONUR",
    country: "Kazakhstan",
    region: "Kyzylorda Steppe, Kazakhstan",
    latDeg: 45.92,
    lonDeg: 63.342,
    elevationM: 6.5,
    biome: "arid_steppe",
    hasOcean: false,
    coastAzimuthDeg: null,
    padStyle: "baikonur_tulip",
    defaultOrbitInclinationDeg: 51.6,
    supportsBoosterCatch: false,
    biomeBadge: "ARID STEPPE",
    description: "Inland steppe complex with rail-fed launch ring & hinged tulip hold-down arms",
  },
  moon_shackleton: {
    id: "moon_shackleton",
    planetId: "moon",
    name: "Shackleton Rim Base",
    shortName: "SHACKLETON",
    country: "Lunar South Pole",
    region: "Shackleton Crater Rim",
    latDeg: -89.5,
    lonDeg: 0.0,
    elevationM: 1.6,
    biome: "lunar_pole",
    hasOcean: false,
    coastAzimuthDeg: null,
    padStyle: "lunar_regolith",
    defaultOrbitInclinationDeg: 89.5,
    supportsBoosterCatch: false,
    biomeBadge: "VACUUM REGOLITH",
    description: "Sintered regolith pad with 360° ejecta berm & vertical solar arrays",
  },
  mars_jezero: {
    id: "mars_jezero",
    planetId: "mars",
    name: "Jezero / Arcadia Complex",
    shortName: "JEZERO",
    country: "Mars",
    region: "Isidis–Arcadia Margin",
    latDeg: 18.38,
    lonDeg: 77.58,
    elevationM: 2.2,
    biome: "martian_crater",
    hasOcean: false,
    coastAzimuthDeg: null,
    padStyle: "mars_octagonal",
    defaultOrbitInclinationDeg: 18.4,
    supportsBoosterCatch: false,
    biomeBadge: "RED CRATER",
    description: "Octagonal sintered pad with geodesic habitats & Sabatier ISRU depot",
  },
};

export const EARTH_LAUNCH_SITE_IDS: readonly LaunchSiteId[] = [
  "starbase",
  "ksc_lc39a",
  "sriharikota",
  "kourou",
  "tanegashima",
  "baikonur",
] as const;

export const EARTH_LAUNCH_SITES: readonly LaunchSiteConfig[] = EARTH_LAUNCH_SITE_IDS.map(
  (id) => LAUNCH_SITES[id]
);

export const ALL_LAUNCH_SITES: readonly LaunchSiteConfig[] = Object.values(LAUNCH_SITES);

export const DEFAULT_EARTH_SITE_ID: LaunchSiteId = "starbase";

export function getLaunchSiteConfig(id: LaunchSiteId | string): LaunchSiteConfig {
  if (id in LAUNCH_SITES) {
    return LAUNCH_SITES[id as LaunchSiteId];
  }
  return LAUNCH_SITES.starbase;
}

export function getLaunchSitesForPlanet(planetId: PlanetId): readonly LaunchSiteConfig[] {
  if (planetId === "earth") {
    return EARTH_LAUNCH_SITES;
  }
  if (planetId === "moon") {
    return [LAUNCH_SITES.moon_shackleton];
  }
  return [LAUNCH_SITES.mars_jezero];
}

export function getDefaultLaunchSiteForPlanet(planetId: PlanetId): LaunchSiteConfig {
  if (planetId === "earth") {
    return LAUNCH_SITES[DEFAULT_EARTH_SITE_ID];
  }
  if (planetId === "moon") {
    return LAUNCH_SITES.moon_shackleton;
  }
  return LAUNCH_SITES.mars_jezero;
}
