import * as THREE from "three";

export interface GeoPolygon {
  readonly name: string;
  readonly points: readonly (readonly [number, number])[];
}

export interface CityCluster {
  readonly lon: number;
  readonly lat: number;
  readonly radiusDeg: number;
  readonly intensity: number;
}

/**
 * Compact, recognizable equirectangular continent and major island outlines in [lonDeg, latDeg]
 * so AetherSim renders realistic Earth geography 100% offline with zero network texture fetches.
 */
export const EARTH_CONTINENT_POLYGONS: readonly GeoPolygon[] = [
  {
    name: "North America",
    points: [
      [-168, 65], [-162, 70], [-152, 71], [-138, 69], [-126, 70], [-110, 72],
      [-94, 71], [-82, 68], [-78, 62], [-80, 56], [-72, 60], [-64, 60],
      [-55, 52], [-60, 46], [-66, 44], [-70, 42], [-74, 40.5], [-76, 36],
      [-80, 32], [-80.2, 26], [-81.8, 25], [-82.8, 28], [-85, 30], [-89, 30],
      [-94, 29.5], [-96.5, 28], [-97.1, 25.5], [-96.8, 21.5], [-95.5, 19],
      [-91, 18.8], [-90.2, 21.3], [-87, 21.5], [-88.2, 16], [-84, 15],
      [-83.5, 10], [-79, 8.8], [-77.5, 8], [-80, 7.2], [-84.5, 8.5],
      [-87.5, 12.8], [-92, 14.5], [-96.5, 15.8], [-104.5, 19], [-106, 23],
      [-110, 23], [-114, 31], [-112, 27], [-117, 32.5], [-121, 35],
      [-124.5, 40], [-124.5, 48], [-131, 54], [-138, 59], [-151, 60],
      [-162, 55], [-166, 60],
    ],
  },
  {
    name: "Greenland",
    points: [
      [-52, 60], [-43, 60], [-36, 65.5], [-21, 70.5], [-18, 77], [-24, 82],
      [-45, 83.2], [-68, 78], [-64, 74], [-54, 70], [-53, 64],
    ],
  },
  {
    name: "Cuba",
    points: [
      [-84.9, 21.9], [-82.5, 23.1], [-79.5, 22.8], [-75.5, 21.1],
      [-74.1, 20.2], [-77.0, 19.9], [-81.0, 22.0],
    ],
  },
  {
    name: "Hispaniola",
    points: [
      [-74.4, 18.5], [-72.8, 19.9], [-68.4, 18.6], [-70.2, 18.1], [-73.2, 18.2],
    ],
  },
  {
    name: "South America",
    points: [
      [-78, 9], [-75, 11], [-71, 12.2], [-63, 10.6], [-52, 4.5], [-49, 0],
      [-41, -3], [-35, -6], [-38, -13], [-41, -22], [-48, -26], [-53, -33.5],
      [-58, -38.5], [-65, -42.5], [-67, -47], [-68, -53], [-67, -55.2],
      [-73.5, -53.5], [-75, -46], [-72, -35], [-70.5, -20], [-77, -12],
      [-81.2, -5], [-79.8, 2], [-77.8, 7],
    ],
  },
  {
    name: "Great Britain",
    points: [
      [-5.6, 50.1], [-3.0, 51.4], [-4.8, 53.3], [-4.8, 55.2], [-6.2, 57.5],
      [-3.5, 58.6], [-1.8, 57.5], [-1.2, 54.5], [1.7, 52.6], [1.4, 51.1],
      [-2.0, 50.6],
    ],
  },
  {
    name: "Ireland",
    points: [
      [-10.2, 51.6], [-9.5, 54.2], [-7.5, 55.3], [-5.5, 54.4], [-6.1, 52.2],
      [-8.5, 51.5],
    ],
  },
  {
    name: "Iceland",
    points: [
      [-24.2, 65.5], [-21.0, 66.5], [-14.0, 66.2], [-14.2, 64.0], [-20.5, 63.4],
      [-22.7, 64.0],
    ],
  },
  {
    name: "Eurasia",
    points: [
      [-9.3, 37.0], [-9.0, 43.0], [-2.0, 43.4], [-4.5, 48.3], [2.0, 51.0],
      [8.5, 54.0], [8.2, 57.0], [10.6, 57.7], [11.5, 55.5], [13.0, 55.5],
      [11.0, 59.0], [5.0, 60.5], [11.0, 65.0], [20.0, 70.0], [28.5, 71.1],
      [32.0, 69.5], [42.0, 67.5], [50.0, 68.5], [64.0, 69.5], [73.0, 72.5],
      [88.0, 73.5], [104.0, 77.5], [116.0, 74.0], [138.0, 72.5], [160.0, 70.0],
      [179.0, 66.5], [174.0, 62.0], [162.0, 59.0], [157.0, 51.0], [152.0, 57.0],
      [142.0, 54.5], [136.0, 45.0], [129.0, 40.5], [129.2, 35.1], [126.2, 35.0],
      [126.5, 39.5], [120.0, 39.8], [122.0, 37.0], [119.5, 34.5], [121.8, 31.2],
      [120.5, 27.0], [115.0, 22.4], [109.0, 21.0], [106.5, 20.5], [109.2, 12.0],
      [105.0, 8.6], [100.5, 13.5], [103.8, 1.3], [100.2, 5.5], [98.2, 10.0],
      [96.5, 16.5], [91.5, 22.0], [86.0, 19.5], [80.2, 13.0], [77.5, 8.1],
      [73.0, 15.0], [69.0, 22.5], [66.5, 25.0], [57.0, 25.5], [55.0, 24.5],
      [59.8, 22.5], [54.0, 17.0], [45.0, 12.8], [43.3, 12.7], [39.0, 21.5],
      [34.8, 28.0], [32.6, 29.9], [32.3, 31.2], [35.5, 33.8], [36.0, 36.8],
      [27.0, 37.0], [26.0, 40.5], [23.8, 38.0], [22.0, 36.6], [19.5, 40.5],
      [13.8, 45.5], [15.5, 41.5], [16.0, 38.0], [12.5, 41.5], [9.0, 44.3],
      [4.5, 43.3], [3.1, 42.4], [-0.5, 38.0], [-5.4, 36.1],
    ],
  },
  {
    name: "Africa",
    points: [
      [-6.0, 35.8], [3.0, 36.8], [10.8, 37.2], [11.5, 33.0], [20.0, 32.0],
      [32.4, 31.2], [34.2, 27.5], [38.0, 21.0], [43.3, 12.6], [51.3, 11.9],
      [48.0, 5.0], [41.5, -1.5], [40.5, -10.5], [35.0, -19.5], [32.8, -26.0],
      [28.0, -33.0], [20.0, -34.8], [18.3, -34.0], [14.5, -23.0], [12.0, -15.5],
      [12.3, -6.0], [9.4, 1.0], [8.5, 4.5], [2.5, 6.4], [-7.5, 4.4],
      [-13.5, 8.5], [-17.5, 14.7], [-16.0, 21.0], [-13.2, 27.5], [-9.5, 32.0],
    ],
  },
  {
    name: "Madagascar",
    points: [
      [49.3, -12.0], [50.4, -15.5], [47.5, -24.8], [44.2, -25.2], [43.3, -21.5],
      [44.5, -17.0], [47.5, -13.8],
    ],
  },
  {
    name: "Sri Lanka",
    points: [
      [80.1, 9.7], [81.8, 7.6], [80.7, 6.0], [79.8, 7.0],
    ],
  },
  {
    name: "Japan",
    points: [
      [130.5, 31.5], [132.0, 34.0], [136.8, 34.8], [140.8, 36.0], [141.8, 41.0],
      [145.5, 43.3], [141.9, 45.4], [139.8, 42.8], [139.5, 39.0], [136.5, 36.8],
      [132.5, 35.4], [129.6, 33.4],
    ],
  },
  {
    name: "Taiwan",
    points: [
      [121.5, 25.2], [121.9, 23.8], [120.8, 21.9], [120.1, 23.3],
    ],
  },
  {
    name: "Philippines",
    points: [
      [120.0, 18.4], [122.4, 17.5], [124.2, 13.5], [126.4, 7.2], [124.0, 5.8],
      [122.0, 7.2], [120.5, 14.2], [119.8, 16.2],
    ],
  },
  {
    name: "Sumatra",
    points: [
      [95.3, 5.5], [99.5, 3.0], [104.5, -1.8], [105.9, -5.8], [103.5, -5.0],
      [99.8, -0.8],
    ],
  },
  {
    name: "Java",
    points: [
      [105.3, -6.1], [111.0, -6.7], [114.5, -7.8], [114.2, -8.7], [106.4, -7.3],
    ],
  },
  {
    name: "Borneo",
    points: [
      [109.0, 1.5], [115.0, 5.2], [118.8, 6.6], [118.9, 1.0], [116.0, -3.5],
      [111.5, -3.2], [109.2, -0.5],
    ],
  },
  {
    name: "Sulawesi",
    points: [
      [119.2, 1.2], [125.1, 1.7], [123.5, -1.5], [122.8, -4.8], [119.5, -5.5],
      [118.9, -2.5],
    ],
  },
  {
    name: "New Guinea",
    points: [
      [131.0, -1.5], [137.0, -2.2], [144.5, -4.2], [150.5, -10.3], [147.0, -9.5],
      [142.5, -9.1], [138.0, -8.2], [133.5, -4.2],
    ],
  },
  {
    name: "Australia",
    points: [
      [113.6, -22.2], [122.2, -17.9], [130.5, -12.3], [136.8, -12.2], [136.5, -15.5],
      [140.5, -17.4], [142.5, -10.7], [146.0, -17.5], [153.5, -28.1],
      [150.0, -37.5], [144.8, -38.4], [137.8, -35.2], [129.0, -31.8],
      [121.8, -33.9], [115.2, -34.2], [115.6, -31.0],
    ],
  },
  {
    name: "Tasmania",
    points: [
      [144.7, -40.7], [148.2, -40.9], [147.9, -43.3], [145.4, -43.0],
    ],
  },
  {
    name: "New Zealand North",
    points: [
      [172.8, -34.5], [176.0, -36.8], [178.5, -37.7], [175.3, -41.5], [173.8, -39.1],
    ],
  },
  {
    name: "New Zealand South",
    points: [
      [172.6, -40.6], [174.1, -41.5], [171.2, -44.8], [167.8, -46.6], [166.5, -45.6],
    ],
  },
  {
    name: "Antarctica",
    points: [
      [-180, -72], [-145, -74], [-105, -73], [-68, -72], [-58, -63.2], [-54, -64.5],
      [-59, -74], [-35, -77], [0, -70], [45, -67.5], [95, -66.5], [145, -67.5],
      [170, -71.5], [166, -77.5], [180, -77.5], [180, -90], [-180, -90],
    ],
  },
];

export const EARTH_CITY_CLUSTERS: readonly CityCluster[] = [
  // North America
  { lon: -74.0, lat: 40.7, radiusDeg: 7.5, intensity: 1.0 },
  { lon: -87.6, lat: 41.8, radiusDeg: 6.5, intensity: 0.9 },
  { lon: -95.4, lat: 29.8, radiusDeg: 5.5, intensity: 0.85 },
  { lon: -118.2, lat: 34.0, radiusDeg: 5.5, intensity: 0.9 },
  { lon: -99.1, lat: 19.4, radiusDeg: 4.5, intensity: 0.85 },
  { lon: -80.2, lat: 25.8, radiusDeg: 3.8, intensity: 0.75 },
  // South America
  { lon: -46.6, lat: -23.5, radiusDeg: 5.5, intensity: 0.9 },
  { lon: -58.4, lat: -34.6, radiusDeg: 4.5, intensity: 0.8 },
  { lon: -74.1, lat: 4.7, radiusDeg: 3.5, intensity: 0.65 },
  // Europe & Mediterranean
  { lon: 0.0, lat: 51.5, radiusDeg: 6.5, intensity: 1.0 },
  { lon: 8.5, lat: 49.0, radiusDeg: 7.5, intensity: 1.0 },
  { lon: 12.5, lat: 42.5, radiusDeg: 5.0, intensity: 0.85 },
  { lon: -3.7, lat: 40.4, radiusDeg: 4.2, intensity: 0.78 },
  { lon: 37.6, lat: 55.8, radiusDeg: 5.5, intensity: 0.85 },
  { lon: 31.2, lat: 30.0, radiusDeg: 4.2, intensity: 0.92 },
  // Middle East & Asia
  { lon: 55.3, lat: 25.2, radiusDeg: 4.2, intensity: 0.82 },
  { lon: 77.2, lat: 28.6, radiusDeg: 8.5, intensity: 0.95 },
  { lon: 72.9, lat: 19.1, radiusDeg: 6.5, intensity: 0.88 },
  { lon: 100.5, lat: 13.7, radiusDeg: 4.5, intensity: 0.75 },
  { lon: 116.4, lat: 39.9, radiusDeg: 7.5, intensity: 1.0 },
  { lon: 121.5, lat: 31.2, radiusDeg: 7.5, intensity: 1.0 },
  { lon: 113.3, lat: 23.1, radiusDeg: 5.5, intensity: 0.95 },
  { lon: 127.0, lat: 37.5, radiusDeg: 4.0, intensity: 0.92 },
  { lon: 139.7, lat: 35.7, radiusDeg: 5.0, intensity: 1.0 },
  { lon: 106.8, lat: -6.2, radiusDeg: 4.0, intensity: 0.8 },
  // Africa & Oceania
  { lon: 3.4, lat: 6.5, radiusDeg: 4.5, intensity: 0.72 },
  { lon: 28.0, lat: -26.2, radiusDeg: 3.8, intensity: 0.72 },
  { lon: 151.2, lat: -33.8, radiusDeg: 3.5, intensity: 0.72 },
];

function pointInPolygon(lon: number, lat: number, pts: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Classifies whether a geodetic coordinate (lonDeg in [-180, 180], latDeg in [-90, 90])
 * falls over a major Earth continent or island polygon.
 */
export function isEarthLand(lonDeg: number, latDeg: number): boolean {
  let lon = ((lonDeg + 180) % 360 + 360) % 360 - 180;
  if (lonDeg === 180) {
    lon = 180;
  }
  if (latDeg <= -78) {
    return true;
  }
  for (const poly of EARTH_CONTINENT_POLYGONS) {
    if (pointInPolygon(lon, latDeg, poly.points)) {
      return true;
    }
  }
  return false;
}

/**
 * Maps geodetic (latDeg, lonDeg) to Three.js SphereGeometry unit local direction vector
 * matching equirectangular CanvasTexture UV layout:
 * u = (lonDeg + 180) / 360, v = (90 - latDeg) / 180 (north pole at +Y).
 */
export function geoToSphereUnitVector(latDeg: number, lonDeg: number): [number, number, number] {
  const phi = ((lonDeg + 180) / 360) * Math.PI * 2;
  const theta = ((90 - latDeg) / 180) * Math.PI;
  const sinT = Math.sin(theta);
  return [
    -Math.cos(phi) * sinT,
    Math.cos(theta),
    Math.sin(phi) * sinT,
  ];
}

/**
 * Computes the Quaternion that rotates a planetary globe centered at (0, -simRadiusM, 0)
 * so that `launchSiteCoords` sits directly at the top zenith (0, 1, 0) beneath the launchpad.
 */
export function computeLaunchSiteZenithQuaternion(
  latDeg: number,
  lonDeg: number
): THREE.Quaternion {
  const [vx, vy, vz] = geoToSphereUnitVector(latDeg, lonDeg);
  const localDir = new THREE.Vector3(vx, vy, vz).normalize();
  const zenith = new THREE.Vector3(0, 1, 0);
  if (localDir.y < -0.99999) {
    return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  }
  return new THREE.Quaternion().setFromUnitVectors(localDir, zenith);
}
