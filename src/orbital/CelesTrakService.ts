import type { OMMJsonObject } from "satellite.js";
import {
  type OrbitalDataSource,
  formatUtcTimestamp,
} from "./SatelliteCatalog";

const CACHE_KEY = "aethersim.celestrak.gp.v1";
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2-hour respectful CelesTrak cache
const MIN_MANUAL_REFRESH_GAP_MS = 15_000; // Prevent accidental rapid spam
const FETCH_TIMEOUT_MS = 5_000;

const CELESTRAK_ENDPOINTS: readonly string[] = [
  "https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=JSON",
  "https://celestrak.org/NORAD/elements/gp.php?CATNR=20580&FORMAT=JSON",
  "https://celestrak.org/NORAD/elements/gp.php?CATNR=40697&FORMAT=JSON",
  "https://celestrak.org/NORAD/elements/gp.php?CATNR=43013&FORMAT=JSON",
  "https://celestrak.org/NORAD/elements/gp.php?CATNR=43873&FORMAT=JSON",
  "https://celestrak.org/NORAD/elements/gp.php?CATNR=41866&FORMAT=JSON",
];

const CURATED_NORAD_IDS = new Set<number>([
  25544, // ISS (ZARYA)
  48274, // Tiangong (CSS)
  20580, // Hubble (HST)
  40697, // Sentinel-2A
  43013, // NOAA-20
  43873, // GPS III SV01
  41866, // GOES-16
]);

interface CachedGpPayload {
  fetchedAtMs: number;
  records: Record<string, OMMJsonObject>;
}

export interface CelesTrakFetchResult {
  readonly dataSource: OrbitalDataSource;
  readonly fetchedAtMs: number;
  readonly lastUpdatedUtc: string;
  readonly recordsByNorad: ReadonlyMap<number, OMMJsonObject>;
  readonly errorMessage: string | null;
  readonly rateLimited: boolean;
}

export interface CelesTrakFetchOptions {
  readonly force?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: number;
  readonly bypassStorage?: boolean;
}

let lastNetworkAttemptMs = 0;

function isValidOmmRecord(raw: unknown): raw is OMMJsonObject {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.OBJECT_NAME === "string" &&
    typeof r.EPOCH === "string" &&
    r.NORAD_CAT_ID !== undefined &&
    r.MEAN_MOTION !== undefined &&
    r.ECCENTRICITY !== undefined &&
    r.INCLINATION !== undefined
  );
}

function readCachedPayload(nowMs: number): CachedGpPayload | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedGpPayload>;
    if (
      typeof parsed.fetchedAtMs !== "number" ||
      !parsed.records ||
      typeof parsed.records !== "object"
    ) {
      return null;
    }
    if (nowMs - parsed.fetchedAtMs > CACHE_TTL_MS) {
      return null;
    }
    return {
      fetchedAtMs: parsed.fetchedAtMs,
      records: parsed.records,
    };
  } catch {
    return null;
  }
}

function writeCachedPayload(payload: CachedGpPayload): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore restricted/full storage gracefully
  }
}

function recordsObjectToMap(records: Record<string, OMMJsonObject>): Map<number, OMMJsonObject> {
  const map = new Map<number, OMMJsonObject>();
  for (const [k, val] of Object.entries(records)) {
    const id = Number(k);
    if (Number.isFinite(id) && isValidOmmRecord(val)) {
      map.set(id, val);
    }
  }
  return map;
}

async function fetchJsonWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches curated Earth OMM/GP orbital elements from CelesTrak with respectful
 * 2-hour localStorage caching, 5-second request timeout, manual refresh rate limiting,
 * and completely error-free offline fallback (`dataSource: "simulated"`).
 */
export async function fetchCelesTrakGpSnapshot(
  options: CelesTrakFetchOptions = {}
): Promise<CelesTrakFetchResult> {
  const nowMs = options.nowMs ?? Date.now();
  const force = Boolean(options.force);
  const useStorage = !options.bypassStorage;

  const cached = useStorage ? readCachedPayload(nowMs) : null;

  if (!force && cached) {
    const cachedMap = recordsObjectToMap(cached.records);
    if (cachedMap.size > 0) {
      return {
        dataSource: "cached_celestrak",
        fetchedAtMs: cached.fetchedAtMs,
        lastUpdatedUtc: formatUtcTimestamp(cached.fetchedAtMs),
        recordsByNorad: cachedMap,
        errorMessage: null,
        rateLimited: false,
      };
    }
  }

  if (force && !options.fetchImpl && nowMs - lastNetworkAttemptMs < MIN_MANUAL_REFRESH_GAP_MS) {
    if (cached) {
      return {
        dataSource: "cached_celestrak",
        fetchedAtMs: cached.fetchedAtMs,
        lastUpdatedUtc: formatUtcTimestamp(cached.fetchedAtMs),
        recordsByNorad: recordsObjectToMap(cached.records),
        errorMessage: "Refreshed recently — wait 15 s before re-querying CelesTrak.",
        rateLimited: true,
      };
    }
    return {
      dataSource: "simulated",
      fetchedAtMs: nowMs,
      lastUpdatedUtc: formatUtcTimestamp(nowMs),
      recordsByNorad: new Map(),
      errorMessage: "Wait 15 s between manual CelesTrak refresh requests.",
      rateLimited: true,
    };
  }

  const fetchImpl = options.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) {
    return {
      dataSource: "simulated",
      fetchedAtMs: nowMs,
      lastUpdatedUtc: formatUtcTimestamp(nowMs),
      recordsByNorad: new Map(),
      errorMessage: "Offline environment — using simulated embedded orbital elements.",
      rateLimited: false,
    };
  }

  if (!options.fetchImpl) {
    lastNetworkAttemptMs = nowMs;
  }

  const settled = await Promise.allSettled(
    CELESTRAK_ENDPOINTS.map((url) =>
      fetchJsonWithTimeout(url, fetchImpl, FETCH_TIMEOUT_MS)
    )
  );

  const recordsByNorad = new Map<number, OMMJsonObject>();
  const recordsObj: Record<string, OMMJsonObject> = {};
  let lastFailReason: string | null = null;

  for (const res of settled) {
    if (res.status === "rejected") {
      lastFailReason =
        res.reason instanceof Error ? res.reason.message : String(res.reason);
      continue;
    }
    const items = Array.isArray(res.value) ? res.value : [res.value];
    for (const item of items) {
      if (!isValidOmmRecord(item)) continue;
      const noradId = Number(item.NORAD_CAT_ID);
      if (!CURATED_NORAD_IDS.has(noradId)) continue;
      recordsByNorad.set(noradId, item);
      recordsObj[String(noradId)] = item;
    }
  }

  if (recordsByNorad.size > 0) {
    if (useStorage) {
      writeCachedPayload({ fetchedAtMs: nowMs, records: recordsObj });
    }
    return {
      dataSource: "live_celestrak",
      fetchedAtMs: nowMs,
      lastUpdatedUtc: formatUtcTimestamp(nowMs),
      recordsByNorad,
      errorMessage: null,
      rateLimited: false,
    };
  }

  // Fallback to unexpired cache if network failed during forced refresh
  if (cached) {
    const cachedMap = recordsObjectToMap(cached.records);
    if (cachedMap.size > 0) {
      return {
        dataSource: "cached_celestrak",
        fetchedAtMs: cached.fetchedAtMs,
        lastUpdatedUtc: formatUtcTimestamp(cached.fetchedAtMs),
        recordsByNorad: cachedMap,
        errorMessage: lastFailReason
          ? `CelesTrak unavailable (${lastFailReason}) — showing cached GP data.`
          : "CelesTrak unavailable — showing cached GP data.",
        rateLimited: false,
      };
    }
  }

  return {
    dataSource: "simulated",
    fetchedAtMs: nowMs,
    lastUpdatedUtc: formatUtcTimestamp(nowMs),
    recordsByNorad: new Map(),
    errorMessage: lastFailReason
      ? `Offline fallback active (${lastFailReason}).`
      : "Offline fallback active.",
    rateLimited: false,
  };
}
