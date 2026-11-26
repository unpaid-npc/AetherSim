import type { LaunchSiteId } from "../config/launchSites";
import type { VehicleId } from "../config/vehicles";
import type { GpuTier, GpuTierTag, SystemHardwareInfo } from "../utils/hardwareInfo";

export interface DesktopAppBridge {
  isElectron: boolean;
  platform: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}

export interface AetherDesktopBridge {
  isElectron: boolean;
  getSystemHardware: () => Promise<SystemHardwareInfo>;
}

export interface SimDiagnostics {
  ready: boolean;
  version?: string;
  planet: string;
  launchSiteId?: LaunchSiteId;
  vehicleId?: VehicleId;
  missionMode: string;
  controlMode: string;
  phase: string;
  quality: string;
  autoQualityEnabled?: boolean;
  sasEnabled: boolean;
  crashed: boolean;
  fps: number;
  rendererName: string;
  cpuModel?: string;
  cpuCores?: number;
  totalRamGb?: number;
  gpuShortName?: string;
  gpuTier?: GpuTier;
  gpuTag?: GpuTierTag;
  isHybridOnIgpu?: boolean;
  detectedDiscreteGpuName?: string | null;
  estimatedVramMB?: number;
  glbLoadedCount?: number;
  shadowCascades?: number;
  isElectron: boolean;
  drawCalls: number;
  triangles: number;
  canvasNonBlackPct?: number;
  canvasMeanRgb?: [number, number, number];
  aiState?: string;
  aiBrainLevel?: string;
  aiBestSuccessPct?: number;
  aiEpisodes?: number;
  aiTotalSteps?: number;
  aiMeanReturn?: number;
  cameraPreset?: string;
  trackTarget?: string;
  boosterStatus?: string;
  audioMuted?: boolean;
  orbitAchieved?: boolean;
  timeWarp?: number;
  reducedMotion?: boolean;
  gibsTilesLoaded?: boolean;
  orbitalObjectCount?: number;
  orbitalDataSource?: string;
  selectedOrbitalId?: string;
  inspectedOrbitalId?: string | null;
}

export interface ProfilerSampleResult {
  frames: number;
  durationMs: number;
  avgFps: number;
  p50FrameMs: number;
  p95FrameMs: number;
  drawCalls: number;
  triangles: number;
  rendererName: string;
  cpuModel: string;
  cpuCores: number;
  gpuShortName: string;
  gpuTier: GpuTier;
  isHybridOnIgpu: boolean;
  estimatedVramMB: number;
  glbLoadedCount: number;
  shadowCascades: number;
  jsHeapUsedMB: number | null;
  canvasWidth: number;
  canvasHeight: number;
}

export interface AetherSimProfilerApi {
  setPlanet: (id: "mars" | "earth" | "moon") => void;
  setLaunchSite: (id: LaunchSiteId) => void;
  setVehicle: (id: VehicleId) => void;
  selectOrbitalObject: (id: string) => void;
  inspectOrbitalObject: (id: string) => void;
  returnToVehicle: () => void;
  setQuality: (q: "low" | "med" | "high") => void;
  startMission: () => void;
  resetMission: () => void;
  setCameraPreset: (mode: "pad" | "chase" | "engine" | "station" | "free" | "map" | "booster") => void;
  setTrackTarget: (target: "ship" | "booster") => void;
  setAutoDirector: (enabled: boolean) => void;
  resetCamera: () => void;
  probeCanvas: () => { pct: number; meanRgb: [number, number, number] };
  sampleFrames: (durationMs?: number) => Promise<ProfilerSampleResult>;
}

declare global {
  interface Window {
    desktopApp?: DesktopAppBridge;
    aetherDesktop?: AetherDesktopBridge;
    __AETHERSIM_BOOT_ID__?: string;
    __STARSHIP_SIM__?: SimDiagnostics;
    __AETHERSIM_PROFILER__?: AetherSimProfilerApi;
  }
}
