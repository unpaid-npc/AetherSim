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
  aiEpisodes?: number;
  aiTotalSteps?: number;
  aiMeanReturn?: number;
  cameraPreset?: string;
  audioMuted?: boolean;
}

declare global {
  interface Window {
    desktopApp?: DesktopAppBridge;
    __STARSHIP_SIM__?: SimDiagnostics;
  }
}
