export {};

export interface DesktopAppBridge {
  isElectron: boolean;
  platform: string;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
}

export interface SimDiagnostics {
  ready: boolean;
  version?: string;
  planet: string;
  missionMode: string;
  controlMode: string;
  phase: string;
  quality: string;
  sasEnabled: boolean;
  crashed: boolean;
  fps: number;
  rendererName: string;
  isElectron: boolean;
  drawCalls: number;
  triangles: number;
  aiState?: string;
  aiBrainLevel?: string;
  aiBestSuccessPct?: number;
  aiEpisodes?: number;
  aiTotalSteps?: number;
  aiMeanReturn?: number;
  cameraPreset?: string;
  audioMuted?: boolean;
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
  jsHeapUsedMB: number | null;
  canvasWidth: number;
  canvasHeight: number;
}

export interface AetherSimProfilerApi {
  setPlanet: (id: "mars" | "earth" | "moon") => void;
  setQuality: (q: "low" | "med" | "high") => void;
  startMission: () => void;
  resetMission: () => void;
  sampleFrames: (durationMs?: number) => Promise<ProfilerSampleResult>;
}

declare global {
  interface Window {
    desktopApp?: DesktopAppBridge;
    __STARSHIP_SIM__?: SimDiagnostics;
    __AETHERSIM_PROFILER__?: AetherSimProfilerApi;
  }
}
