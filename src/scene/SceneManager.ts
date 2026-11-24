import * as THREE from "three";
import type {
  ActivationSnapshot,
  PolicyCheckpoint,
} from "../ai/NeuralNetwork";
import { PPOTrainer, type TrainingMetrics } from "../ai/PPOTrainer";
import { PPOWorkerClient } from "../ai/PPOWorkerClient";
import { SeededPRNG } from "../ai/prng";
import {
  ACTION_DIM,
  OBS_DIM,
  RL_CONTROL_DT,
  applyRLSpawnToController,
  computeStepReward,
  extractObservation,
  isLandingSuccess,
  isLaunchSuccess,
  isRLOutOfBounds,
  mapRawActionToAIInput,
} from "../ai/RLEnvironment";
import { SoundEngine } from "../audio/SoundEngine";
import { type PlanetConfig, type PlanetId, getPlanetConfig } from "../config/planets";
import { ExplosionSystem } from "../effects/ExplosionSystem";
import { PropulsionEffects, type QualityPreset } from "../effects/PropulsionEffects";
import type { FlightLogSample } from "../research/DataExporter";
import type { MonteCarloPilot, MonteCarloSummary } from "../research/MonteCarloRunner";
import { AtmosphereDome } from "../shaders/atmosphereShader";
import {
  type FaultConfig,
  createDefaultFaultConfig,
  sanitizeFaultConfig,
} from "../sim/FaultInjector";
import {
  type AIActionInput,
  type ControlMode,
  FlightController,
  type FlightTelemetry,
  type ManualInputState,
  type MissionMode,
} from "../sim/FlightController";
import {
  CameraDirector,
  type CameraFocusMode,
  type CameraPreset,
} from "./CameraDirector";
import { LaunchComplex } from "./LaunchComplex";
import { PostProcessingPipeline } from "./PostProcessing";
import { disposeVehicleTextureCache } from "./ProceduralTextures";
import { StarshipVehicle } from "./StarshipVehicle";
import { TerrainSystem } from "./TerrainSystem";

export type { CameraFocusMode, CameraPreset } from "./CameraDirector";
export type AITrainingMode = "idle" | "live_train" | "turbo_train" | "eval";

export interface AIStatusSnapshot {
  mode: AITrainingMode;
  learningRate: number;
  randomizeSpawn: boolean;
  metrics: TrainingMetrics;
  outputs: {
    throttle: number;
    pitchCmd: number;
    yawCmd: number;
    value: number;
  };
  lastError: string | null;
}

export interface SceneTelemetry {
  fps: number;
  rendererName: string;
  drawCalls: number;
  triangles: number;
  quality: QualityPreset;
  cameraPreset: CameraPreset;
  autoDirector: boolean;
  audioMuted: boolean;
  flight: FlightTelemetry;
  ai: AIStatusSnapshot;
}

const MAX_FLIGHT_LOG_SAMPLES = 3000;

/**
 * Coordinates WebGL rendering, planet switching, lighting, PMREM reflections,
 * LaunchComplex, StarshipVehicle, PropulsionEffects, ExplosionSystem, PostProcessing,
 * CameraDirector, SoundEngine, FaultInjector, and the PPO AI Engine.
 */
export class SceneManager {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly cameraDirector: CameraDirector;
  private readonly soundEngine: SoundEngine;

  private readonly sunLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly pmremGenerator: THREE.PMREMGenerator;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;

  private readonly atmosphereDome: AtmosphereDome;
  private readonly terrainSystem: TerrainSystem;
  private readonly launchComplex: LaunchComplex;
  private readonly vehicle: StarshipVehicle;
  private readonly propulsionEffects: PropulsionEffects;
  private readonly explosionSystem: ExplosionSystem;
  private readonly postProcessing: PostProcessingPipeline;
  private readonly flightController: FlightController;

  private currentPlanet: PlanetConfig;
  private quality: QualityPreset = "med";
  private prevStageSeparated = false;
  private vehicleIntact = true;
  private lastCrashId = -1;

  private readonly shakeOffset = new THREE.Vector3();
  private readonly projVec = new THREE.Vector3();

  private manualInput: ManualInputState = {
    throttleDelta: 0,
    throttleSet: null,
    pitchInput: 0,
    yawInput: 0,
    rollInput: 0,
  };

  // Milestone 2 & 3: PPO AI, Fault Injection, Monte Carlo & Telemetry Log
  private readonly liveTrainer: PPOTrainer;
  private readonly workerClient: PPOWorkerClient;
  private aiMode: AITrainingMode = "idle";
  private aiLearningRate = 6e-4;
  private aiRandomizeSpawn = true;
  private aiLastError: string | null = null;
  private readonly aiPrng = new SeededPRNG(1337);
  private aiDecisionTimer = 0;
  private aiCurrentAction: AIActionInput = {
    throttle: 0.5,
    pitchCmd: 0,
    yawCmd: 0,
    autoLegs: true,
  };
  private aiLastActivations: ActivationSnapshot | null = null;
  private aiLastOutputs = { throttle: 0, pitchCmd: 0, yawCmd: 0, value: 0 };
  private aiMetrics: TrainingMetrics;
  private aiHistory: TrainingMetrics[] = [];

  private faultConfig: FaultConfig = createDefaultFaultConfig();
  private readonly flightLog: FlightLogSample[] = [];
  private logAccumSec = 0;
  private lastMonteCarloSummary: MonteCarloSummary | null = null;
  private monteCarloRunning = false;
  private readonly onMonteCarloResult?: (summary: MonteCarloSummary) => void;

  private liveEpActive = false;
  private liveEpSteps = 0;
  private liveEpReturn = 0;
  private liveResetWaitTimer = 0;
  private livePrevTel: FlightTelemetry | null = null;
  private liveLastObs: Float32Array | null = null;
  private readonly liveLastRawAction = new Float32Array(ACTION_DIM);
  private liveLastLogProb = 0;
  private liveLastValue = 0;

  private rafId = 0;
  private disposed = false;
  private elapsedSec = 0;
  private lastFrameTime = performance.now();
  private fpsAccumTime = 0;
  private fpsFrameCount = 0;
  private currentFps = 0;
  private readonly rendererName: string;
  private readonly onTelemetry?: (telemetry: SceneTelemetry) => void;

  constructor(
    canvas: HTMLCanvasElement,
    initialPlanetId: PlanetId = "mars",
    onTelemetry?: (telemetry: SceneTelemetry) => void,
    onMonteCarloResult?: (summary: MonteCarloSummary) => void
  ) {
    this.canvas = canvas;
    this.onTelemetry = onTelemetry;
    this.onMonteCarloResult = onMonteCarloResult;
    this.currentPlanet = getPlanetConfig(initialPlanetId);

    this.liveTrainer = new PPOTrainer(
      {
        planetId: initialPlanetId,
        missionMode: "landing",
        randomizeSpawn: this.aiRandomizeSpawn,
        faultConfig: this.faultConfig,
      },
      { learningRate: this.aiLearningRate, rolloutSteps: 256 },
      42
    );
    this.aiMetrics = this.liveTrainer.getLastMetrics();

    this.workerClient = new PPOWorkerClient({
      onProgress: (metrics, checkpoint, historyTail, running) => {
        this.liveTrainer.loadCheckpoint(checkpoint);
        this.aiMetrics = metrics;
        this.aiHistory = historyTail;
        this.aiLastError = null;
        if (!running && this.aiMode === "turbo_train") {
          this.aiMode = "idle";
        }
        this.emitTelemetryNow();
      },
      onPaused: (metrics, checkpoint) => {
        this.liveTrainer.loadCheckpoint(checkpoint);
        this.aiMetrics = metrics;
        if (this.aiMode === "turbo_train") {
          this.aiMode = "idle";
        }
        this.emitTelemetryNow();
      },
      onReady: (metrics, checkpoint) => {
        this.liveTrainer.loadCheckpoint(checkpoint);
        this.aiMetrics = metrics;
        this.emitTelemetryNow();
      },
      onMonteCarloResult: (summary) => {
        this.monteCarloRunning = false;
        this.lastMonteCarloSummary = summary;
        this.onMonteCarloResult?.(summary);
      },
      onError: (message) => {
        this.monteCarloRunning = false;
        this.aiLastError = message;
        this.aiMode = "idle";
        this.emitTelemetryNow();
      },
    });

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.currentPlanet.lighting.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.rendererName = this.detectRendererName();
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      52,
      window.innerWidth / Math.max(1, window.innerHeight),
      0.5,
      65000
    );
    this.cameraDirector = new CameraDirector(this.camera, this.canvas);
    this.soundEngine = new SoundEngine();

    this.sunLight = new THREE.DirectionalLight("#ffffff", 3.0);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 900;
    this.sunLight.shadow.camera.left = -220;
    this.sunLight.shadow.camera.right = 220;
    this.sunLight.shadow.camera.top = 240;
    this.sunLight.shadow.camera.bottom = -160;
    this.sunLight.shadow.bias = -0.0005;
    this.scene.add(this.sunLight, this.sunLight.target);

    this.hemiLight = new THREE.HemisphereLight("#ffffff", "#222222", 0.6);
    this.scene.add(this.hemiLight);

    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.pmremGenerator.compileEquirectangularShader();

    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.atmosphereDome = new AtmosphereDome(this.currentPlanet);
    this.terrainSystem = new TerrainSystem(this.currentPlanet, maxAnisotropy);
    this.launchComplex = new LaunchComplex(this.currentPlanet, maxAnisotropy);
    this.vehicle = new StarshipVehicle(maxAnisotropy);
    this.propulsionEffects = new PropulsionEffects(
      this.currentPlanet,
      this.vehicle.getBoosterPlumeAnchor(),
      this.vehicle.getShipPlumeAnchor(),
      this.vehicle.getRcsAnchorGroup()
    );
    this.explosionSystem = new ExplosionSystem(this.currentPlanet);

    this.scene.add(
      this.atmosphereDome.group,
      this.terrainSystem.group,
      this.launchComplex.group,
      this.vehicle.root,
      this.vehicle.detachedBoosterRoot,
      this.propulsionEffects.worldGroup,
      this.explosionSystem.group
    );

    this.postProcessing = new PostProcessingPipeline(
      this.renderer,
      this.scene,
      this.camera,
      window.innerWidth,
      window.innerHeight
    );

    this.flightController = new FlightController(
      this.currentPlanet.id,
      this.launchComplex.getPadDeckY(),
      "launch"
    );

    this.applyPlanetEnvironment(this.currentPlanet);
    this.syncVisualsFromTelemetry(this.flightController.getTelemetry());
    this.cameraDirector.reLockOnVehicle(
      this.flightController.getTelemetry(),
      this.launchComplex.getBaseFocusTarget(),
      true
    );

    window.addEventListener("resize", this.handleResize);
    this.lastFrameTime = performance.now();
    this.animate();
  }

  private detectRendererName(): string {
    try {
      const gl = this.renderer.getContext();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) {
        const unmasked = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
        if (typeof unmasked === "string" && unmasked.trim().length > 0) {
          return unmasked.trim();
        }
      }
      const fallback = gl.getParameter(gl.RENDERER);
      return typeof fallback === "string" ? fallback : "WebGL";
    } catch {
      return "WebGL";
    }
  }

  private rebuildEnvironmentMap(config: PlanetConfig): void {
    const envScene = new THREE.Scene();
    const skyGeo = new THREE.SphereGeometry(24, 16, 12);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        uTop: { value: new THREE.Color(config.atmosphere.zenithColor) },
        uHorizon: { value: new THREE.Color(config.atmosphere.horizonColor) },
        uGround: { value: new THREE.Color(config.terrain.soilPalette[2]) },
      },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        uniform vec3 uGround;
        varying vec3 vPos;
        void main() {
          vec3 c = vPos.y >= 0.0
            ? mix(uHorizon, uTop, pow(vPos.y, 0.65))
            : mix(uHorizon * 0.45, uGround, clamp(-vPos.y * 2.0, 0.0, 1.0));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    const dome = new THREE.Mesh(skyGeo, skyMat);
    envScene.add(dome);

    const nextTarget = this.pmremGenerator.fromScene(envScene, 0.04);
    this.scene.environment = nextTarget.texture;
    if (this.envRenderTarget) {
      this.envRenderTarget.dispose();
    }
    this.envRenderTarget = nextTarget;

    skyGeo.dispose();
    skyMat.dispose();
  }

  private applyPlanetEnvironment(config: PlanetConfig): void {
    const { atmosphere, lighting } = config;
    const sunDir = new THREE.Vector3(
      atmosphere.sunDirection[0],
      atmosphere.sunDirection[1],
      atmosphere.sunDirection[2]
    ).normalize();

    this.sunLight.position.copy(sunDir).multiplyScalar(320);
    this.sunLight.color.set(lighting.sunLightColor);
    this.sunLight.intensity = lighting.sunLightIntensity;

    this.hemiLight.color.set(lighting.hemiSkyColor);
    this.hemiLight.groundColor.set(lighting.hemiGroundColor);
    this.hemiLight.intensity = lighting.hemiIntensity;

    this.renderer.toneMappingExposure = lighting.exposure;
    this.scene.fog =
      atmosphere.fogDensity > 0
        ? new THREE.FogExp2(atmosphere.fogColor, atmosphere.fogDensity)
        : null;

    this.atmosphereDome.updatePlanet(config);
    this.rebuildEnvironmentMap(config);
  }

  private syncVisualsFromTelemetry(tel: FlightTelemetry): void {
    if (tel.stageSeparated && !this.prevStageSeparated && tel.missionMode === "launch") {
      this.vehicle.triggerStageSeparation(
        new THREE.Vector3(tel.booster.position.x, tel.booster.position.y, tel.booster.position.z),
        tel.booster.pitch,
        tel.booster.yaw,
        tel.booster.roll
      );
    }
    this.prevStageSeparated = tel.stageSeparated;

    if (tel.crashEvent && tel.crashEvent.id !== this.lastCrashId) {
      this.lastCrashId = tel.crashEvent.id;
      this.vehicleIntact = false;
      this.vehicle.setIntactVisible(false);
      this.explosionSystem.trigger(tel.crashEvent);
      this.soundEngine.triggerExplosion(
        tel.crashEvent,
        this.currentPlanet.physics.surfacePressureBar
      );
    }

    this.vehicle.root.position.set(tel.position.x, tel.position.y, tel.position.z);
    this.vehicle.root.rotation.set(tel.roll, tel.yaw, -tel.pitch);

    if (tel.stageSeparated && tel.missionMode === "launch") {
      this.vehicle.detachedBoosterRoot.position.set(
        tel.booster.position.x,
        tel.booster.position.y,
        tel.booster.position.z
      );
      this.vehicle.detachedBoosterRoot.rotation.set(
        tel.booster.roll,
        tel.booster.yaw,
        -tel.booster.pitch
      );
    }

    this.vehicle.setFrostLevel(tel.frostLevel);
    this.vehicle.setFlapAngle(tel.flapAngleRad);
    this.vehicle.setGridFinDeflection(tel.gridFinPitch, tel.gridFinYaw);
    this.vehicle.setLandingLegsDeployed(tel.landingLegsDeployed);
    this.vehicle.setEngineVisualState(
      tel.boosterThrottle,
      tel.shipThrottle,
      tel.gimbalX,
      tel.gimbalZ
    );

    this.launchComplex.setUmbilicalRetracted(tel.umbilicalRetracted);
    this.launchComplex.setCatchArmsOpen(tel.catchArmsOpen);
  }

  setQualityPreset(preset: QualityPreset): void {
    this.quality = preset;
    this.propulsionEffects.setQuality(preset);
    this.explosionSystem.setQuality(preset);
    this.postProcessing.setQuality(preset);

    const maxPr = preset === "low" ? 1.25 : preset === "med" ? 1.5 : 2.0;
    const pr = Math.min(window.devicePixelRatio || 1, maxPr);
    this.renderer.setPixelRatio(pr);
    this.postProcessing.setSize(window.innerWidth, Math.max(1, window.innerHeight), pr);

    const shadowRes = preset === "low" ? 1024 : 2048;
    if (this.sunLight.shadow.mapSize.x !== shadowRes) {
      this.sunLight.shadow.mapSize.set(shadowRes, shadowRes);
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
      }
    }
  }

  getQualityPreset(): QualityPreset {
    return this.quality;
  }

  setPlanet(id: PlanetId): PlanetConfig {
    if (this.currentPlanet.id === id) {
      return this.currentPlanet;
    }
    const next = getPlanetConfig(id);
    this.currentPlanet = next;
    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.terrainSystem.updatePlanet(next, maxAnisotropy);
    this.launchComplex.updatePlanet(next, maxAnisotropy);
    this.propulsionEffects.setPlanet(next);
    this.explosionSystem.setPlanet(next);
    this.applyPlanetEnvironment(next);

    const mission = this.flightController.getTelemetry().missionMode;
    this.liveTrainer.setEnvConfig(id, mission, this.aiRandomizeSpawn, this.faultConfig);
    if (this.aiMode === "turbo_train") {
      this.workerClient.startTurboTrain(
        id,
        mission,
        this.aiRandomizeSpawn,
        this.aiLearningRate,
        this.faultConfig
      );
    }

    this.resetMission();
    return next;
  }

  setMissionMode(mode: MissionMode): void {
    this.flightController.setMissionMode(mode);
    this.liveTrainer.setEnvConfig(
      this.currentPlanet.id,
      mode,
      this.aiRandomizeSpawn,
      this.faultConfig
    );
    if (this.aiMode === "turbo_train") {
      this.workerClient.startTurboTrain(
        this.currentPlanet.id,
        mode,
        this.aiRandomizeSpawn,
        this.aiLearningRate,
        this.faultConfig
      );
    }
    this.flightLog.length = 0;
    this.resetVehicleToFlightState();
    this.cameraDirector.reLockOnVehicle(
      this.flightController.getTelemetry(),
      this.launchComplex.getBaseFocusTarget(),
      true
    );
  }

  setControlMode(mode: ControlMode): void {
    this.flightController.setControlMode(mode);
    if (mode === "ai_ppo" && this.aiMode === "idle") {
      this.aiMode = "eval";
    } else if (mode !== "ai_ppo" && (this.aiMode === "live_train" || this.aiMode === "eval")) {
      this.aiMode = "idle";
      this.liveEpActive = false;
    }
  }

  // --- Camera & Audio Controls ---

  setCameraPreset(preset: CameraPreset): void {
    this.cameraDirector.setPreset(
      preset,
      this.flightController.getTelemetry(),
      this.launchComplex.getBaseFocusTarget(),
      false
    );
  }

  getCameraPreset(): CameraPreset {
    return this.cameraDirector.getPreset();
  }

  setAutoDirector(enabled: boolean): void {
    this.cameraDirector.setAutoDirector(enabled);
  }

  getAutoDirector(): boolean {
    return this.cameraDirector.getAutoDirector();
  }

  setAudioMuted(muted: boolean): void {
    this.soundEngine.setMuted(muted);
  }

  isAudioMuted(): boolean {
    return this.soundEngine.isMuted();
  }

  // --- Fault Injection Controls ---

  setFaultConfig(next: Partial<FaultConfig>): void {
    this.faultConfig = sanitizeFaultConfig({ ...this.faultConfig, ...next });
    this.flightController.setFaultConfig(this.faultConfig);
    const mission = this.flightController.getTelemetry().missionMode;
    this.liveTrainer.setEnvConfig(
      this.currentPlanet.id,
      mission,
      this.aiRandomizeSpawn,
      this.faultConfig
    );
    if (this.aiMode === "turbo_train") {
      this.startTurboTrain();
    }
  }

  getFaultConfig(): FaultConfig {
    return { ...this.faultConfig };
  }

  resetFaults(): void {
    this.faultConfig = createDefaultFaultConfig();
    this.flightController.resetFaults();
    const mission = this.flightController.getTelemetry().missionMode;
    this.liveTrainer.setEnvConfig(
      this.currentPlanet.id,
      mission,
      this.aiRandomizeSpawn,
      this.faultConfig
    );
    if (this.aiMode === "turbo_train") {
      this.startTurboTrain();
    }
  }

  // --- Monte Carlo & Data Log Accessors ---

  runMonteCarlo(episodes: number, pilot: MonteCarloPilot): void {
    if (this.monteCarloRunning) {
      return;
    }
    this.monteCarloRunning = true;
    this.workerClient.syncWeights(this.liveTrainer.exportCheckpoint());
    this.workerClient.runMonteCarlo(
      episodes,
      pilot,
      this.currentPlanet.id,
      this.flightController.getTelemetry().missionMode,
      this.faultConfig,
      2026
    );
  }

  isMonteCarloRunning(): boolean {
    return this.monteCarloRunning;
  }

  getLastMonteCarloSummary(): MonteCarloSummary | null {
    return this.lastMonteCarloSummary;
  }

  getFlightLog(): readonly FlightLogSample[] {
    return this.flightLog;
  }

  // --- Milestone 2/3: Neural AI (PPO) Controls ---

  startLiveTrain(): void {
    this.workerClient.pause();
    this.aiLastError = null;
    this.aiMode = "live_train";
    this.flightController.setControlMode("ai_ppo");
    this.spawnLive3DRLEpisode();
  }

  startTurboTrain(): void {
    this.aiLastError = null;
    this.liveEpActive = false;
    this.aiMode = "turbo_train";
    const mission = this.flightController.getTelemetry().missionMode;
    this.workerClient.syncWeights(this.liveTrainer.exportCheckpoint());
    this.workerClient.startTurboTrain(
      this.currentPlanet.id,
      mission,
      this.aiRandomizeSpawn,
      this.aiLearningRate,
      this.faultConfig
    );
  }

  pauseAI(): void {
    if (this.aiMode === "turbo_train") {
      this.workerClient.pause();
    }
    this.aiMode = "idle";
    this.liveEpActive = false;
  }

  startAIEval(): void {
    if (this.aiMode === "turbo_train") {
      this.workerClient.pause();
    }
    this.aiLastError = null;
    this.aiMode = "eval";
    this.flightController.setControlMode("ai_ppo");
    this.spawnLive3DRLEpisode();
  }

  runWarmStartAndPPO(): void {
    this.aiLastError = null;
    const mission = this.flightController.getTelemetry().missionMode;
    this.liveTrainer.setEnvConfig(
      this.currentPlanet.id,
      mission,
      this.aiRandomizeSpawn,
      this.faultConfig
    );
    this.liveTrainer.warmStartFromGuidance(12, 8);
    this.aiMetrics = this.liveTrainer.getLastMetrics();
    this.workerClient.syncWeights(this.liveTrainer.exportCheckpoint());
    this.startTurboTrain();
  }

  resetAIWeights(): void {
    this.aiLastError = null;
    this.liveEpActive = false;
    this.liveTrainer.resetWeights(42);
    this.aiMetrics = this.liveTrainer.getLastMetrics();
    this.aiHistory = [];
    this.workerClient.resetWeights(42);
    if (this.aiMode === "turbo_train") {
      this.aiMode = "idle";
    }
    this.emitTelemetryNow();
  }

  setAILearningRate(lr: number): void {
    this.aiLearningRate = lr;
    this.liveTrainer.setLearningRate(lr);
    if (this.aiMode === "turbo_train") {
      this.startTurboTrain();
    }
  }

  setDomainRandomization(enabled: boolean): void {
    this.aiRandomizeSpawn = enabled;
    const mission = this.flightController.getTelemetry().missionMode;
    this.liveTrainer.setEnvConfig(
      this.currentPlanet.id,
      mission,
      enabled,
      this.faultConfig
    );
    if (this.aiMode === "turbo_train") {
      this.startTurboTrain();
    }
  }

  exportPolicyCheckpoint(): PolicyCheckpoint {
    return this.liveTrainer.exportCheckpoint();
  }

  importPolicyCheckpoint(json: string): void {
    try {
      const cp = this.liveTrainer.loadCheckpoint(json);
      this.aiLastError = null;
      this.aiMetrics = {
        ...this.liveTrainer.getLastMetrics(),
        totalSteps: cp.totalSteps,
        episodesCompleted: cp.episodesCompleted,
      };
      this.workerClient.loadCheckpoint(cp);
      this.emitTelemetryNow();
    } catch (err) {
      this.aiLastError = err instanceof Error ? err.message : "Invalid checkpoint JSON";
      this.emitTelemetryNow();
    }
  }

  getAIStatus(): AIStatusSnapshot {
    return {
      mode: this.aiMode,
      learningRate: this.aiLearningRate,
      randomizeSpawn: this.aiRandomizeSpawn,
      metrics: this.aiMetrics,
      outputs: { ...this.aiLastOutputs },
      lastError: this.aiLastError,
    };
  }

  getLastAIActivations(): ActivationSnapshot | null {
    return this.aiLastActivations;
  }

  getAIMetrics(): TrainingMetrics {
    return this.aiMetrics;
  }

  getTrainingHistory(): readonly TrainingMetrics[] {
    return this.aiHistory;
  }

  private spawnLive3DRLEpisode(): void {
    const mission = this.flightController.getTelemetry().missionMode;
    this.flightController.setControlMode("ai_ppo");
    this.flightController.setFaultConfig(this.faultConfig);
    applyRLSpawnToController(
      this.flightController,
      this.currentPlanet.id,
      mission,
      this.aiRandomizeSpawn,
      this.aiPrng
    );
    this.flightLog.length = 0;
    this.resetVehicleToFlightState();
    this.cameraDirector.reLockOnVehicle(
      this.flightController.getTelemetry(),
      this.launchComplex.getBaseFocusTarget(),
      true
    );

    this.liveEpActive = true;
    this.liveEpSteps = 0;
    this.liveEpReturn = 0;
    this.liveResetWaitTimer = 0;
    this.aiDecisionTimer = RL_CONTROL_DT;
    this.livePrevTel = this.flightController.getTelemetry();
    this.liveLastObs = null;
  }

  private stepLiveAIControl(dt: number, currentTel: FlightTelemetry): void {
    if (currentTel.controlMode !== "ai_ppo" || !currentTel.running || currentTel.paused) {
      return;
    }

    this.aiDecisionTimer += dt;
    if (this.aiDecisionTimer < RL_CONTROL_DT) {
      return;
    }
    this.aiDecisionTimer -= RL_CONTROL_DT;

    const sensedTel = this.flightController.getSensedTelemetry(
      this.aiPrng.gaussian(0, 1),
      this.aiPrng.gaussian(0, 1)
    );
    const obs = extractObservation(sensedTel, new Float32Array(OBS_DIM));
    const deterministic = this.aiMode !== "live_train";

    if (
      this.aiMode === "live_train" &&
      this.liveEpActive &&
      this.liveLastObs &&
      this.livePrevTel
    ) {
      const stepRew = computeStepReward(this.livePrevTel, currentTel, false);
      this.liveEpReturn += stepRew.totalReward;
      this.liveEpSteps += 1;
      const updated = this.liveTrainer.recordExternalTransition(
        this.liveLastObs,
        this.liveLastRawAction,
        this.liveLastLogProb,
        stepRew.totalReward,
        this.liveLastValue,
        false
      );
      if (updated) {
        this.aiMetrics = updated;
        this.aiHistory = [...this.liveTrainer.getHistory().slice(-60)];
      }
      this.livePrevTel = currentTel;
    }

    const snap = this.liveTrainer.policy.forwardWithActivations(obs);
    this.aiLastActivations = snap;

    const sampled = this.liveTrainer.policy.sampleAction(
      obs,
      this.aiPrng,
      deterministic,
      this.liveLastRawAction
    );
    this.liveLastObs = obs;
    this.liveLastLogProb = sampled.logProb;
    this.liveLastValue = sampled.value;

    const mapped = mapRawActionToAIInput(this.liveLastRawAction);
    this.aiCurrentAction = mapped;
    this.aiLastOutputs = {
      throttle: mapped.throttle,
      pitchCmd: mapped.pitchCmd,
      yawCmd: mapped.yawCmd,
      value: snap.value,
    };
  }

  private handleLiveTrainPostPhysics(dt: number, nextTel: FlightTelemetry): void {
    if (this.aiMode !== "live_train") {
      return;
    }

    if (this.liveResetWaitTimer > 0) {
      this.liveResetWaitTimer -= dt;
      if (this.liveResetWaitTimer <= 0) {
        this.spawnLive3DRLEpisode();
      }
      return;
    }

    if (!this.liveEpActive || !this.livePrevTel || !this.liveLastObs) {
      return;
    }

    const outOfBounds = isRLOutOfBounds(nextTel);
    const tiltDeg = (Math.hypot(nextTel.pitch, nextTel.roll) * 180) / Math.PI;
    const launchSuccess = nextTel.missionMode === "launch" && isLaunchSuccess(nextTel);
    const launchSidewaysFail = nextTel.missionMode === "launch" && tiltDeg > 65;
    const terminalPhase =
      nextTel.phase === "TOUCHDOWN" ||
      nextTel.phase === "CRASHED" ||
      nextTel.phase === "COMPLETE" ||
      launchSuccess ||
      launchSidewaysFail;
    const maxSteps = nextTel.missionMode === "landing" ? 400 : 500;
    const timedOut = this.liveEpSteps >= maxSteps;

    if (terminalPhase || outOfBounds || timedOut) {
      const termRew = computeStepReward(this.livePrevTel, nextTel, outOfBounds);
      this.liveEpReturn += termRew.totalReward;
      const success =
        nextTel.missionMode === "landing"
          ? isLandingSuccess(nextTel)
          : isLaunchSuccess(nextTel);
      const crashed = nextTel.phase === "CRASHED" || launchSidewaysFail;

      const updated = this.liveTrainer.recordExternalTransition(
        this.liveLastObs,
        this.liveLastRawAction,
        this.liveLastLogProb,
        termRew.totalReward,
        this.liveLastValue,
        true,
        {
          episodeReturn: this.liveEpReturn,
          success,
          crashed,
          touchdownVy: nextTel.touchdownVerticalSpeedMps,
        }
      );
      if (updated) {
        this.aiMetrics = updated;
        this.aiHistory = [...this.liveTrainer.getHistory().slice(-60)];
      } else {
        this.aiMetrics = {
          ...this.aiMetrics,
          episodesCompleted: this.liveTrainer.episodesCompleted,
          totalSteps: this.liveTrainer.totalSteps,
          lastEpisodeReturn: this.liveEpReturn,
        };
      }
      this.liveEpActive = false;
      this.liveResetWaitTimer = crashed ? 2.0 : 1.25;
    }
  }

  private emitTelemetryNow(): void {
    this.onTelemetry?.({
      fps: this.currentFps,
      rendererName: this.rendererName,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      quality: this.quality,
      cameraPreset: this.cameraDirector.getPreset(),
      autoDirector: this.cameraDirector.getAutoDirector(),
      audioMuted: this.soundEngine.isMuted(),
      flight: this.flightController.getTelemetry(),
      ai: this.getAIStatus(),
    });
  }

  toggleSas(): boolean {
    return this.flightController.toggleSas();
  }

  startMission(): void {
    const tel = this.flightController.getTelemetry();
    if (tel.controlMode === "ai_ppo") {
      if (this.aiMode === "idle") {
        this.aiMode = "eval";
      }
      this.spawnLive3DRLEpisode();
      return;
    }
    this.flightLog.length = 0;
    this.flightController.startMission();
    this.cameraDirector.reLockOnVehicle(
      this.flightController.getTelemetry(),
      this.launchComplex.getBaseFocusTarget(),
      false
    );
  }

  togglePause(): boolean {
    return this.flightController.togglePause();
  }

  triggerStageSeparation(): boolean {
    return this.flightController.triggerStageSeparation();
  }

  toggleLandingLegs(): void {
    this.flightController.toggleLandingLegs();
  }

  resetMission(): void {
    const tel = this.flightController.getTelemetry();
    if (tel.controlMode === "ai_ppo" && (this.aiMode === "live_train" || this.aiMode === "eval")) {
      this.spawnLive3DRLEpisode();
      return;
    }
    this.flightLog.length = 0;
    this.flightController.reset(
      this.currentPlanet.id,
      this.launchComplex.getPadDeckY(),
      tel.missionMode
    );
    this.flightController.setFaultConfig(this.faultConfig);
    this.resetVehicleToFlightState();
    this.cameraDirector.reLockOnVehicle(
      this.flightController.getTelemetry(),
      this.launchComplex.getBaseFocusTarget(),
      true
    );
  }

  private resetVehicleToFlightState(): void {
    const tel = this.flightController.getTelemetry();
    this.prevStageSeparated = false;
    this.vehicleIntact = true;
    this.lastCrashId = -1;
    this.vehicle.setIntactVisible(true);
    this.vehicle.resetStack(tel.missionMode);
    this.propulsionEffects.reset();
    this.explosionSystem.reset();
    this.syncVisualsFromTelemetry(tel);
  }

  setFocusMode(focus: CameraFocusMode): void {
    this.cameraDirector.setFocusMode(
      focus,
      this.flightController.getTelemetry(),
      this.launchComplex.getBaseFocusTarget()
    );
  }

  getFocusMode(): CameraFocusMode {
    return this.cameraDirector.getFocusMode();
  }

  setManualInput(next: Partial<ManualInputState>): void {
    this.manualInput = {
      ...this.manualInput,
      ...next,
    };
  }

  getPlanet(): PlanetConfig {
    return this.currentPlanet;
  }

  getFlightTelemetry(): FlightTelemetry {
    return this.flightController.getTelemetry();
  }

  getRendererName(): string {
    return this.rendererName;
  }

  resetCamera(): void {
    this.cameraDirector.reLockOnVehicle(
      this.flightController.getTelemetry(),
      this.launchComplex.getBaseFocusTarget(),
      false
    );
  }

  private readonly handleResize = (): void => {
    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    const maxPr = this.quality === "low" ? 1.25 : this.quality === "med" ? 1.5 : 2.0;
    const pr = Math.min(window.devicePixelRatio || 1, maxPr);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(width, height, false);
    this.postProcessing.setSize(width, height, pr);
  };

  private recordFlightSample(tel: FlightTelemetry, dt: number): void {
    if (!tel.running || tel.paused) {
      return;
    }
    this.logAccumSec += dt;
    if (this.logAccumSec < 0.1) {
      return;
    }
    this.logAccumSec = 0;
    const fuelFrac =
      tel.missionMode === "launch" && !tel.stageSeparated
        ? tel.boosterFuel
        : tel.shipFuel;
    this.flightLog.push({
      tSec: tel.missionTimeSec,
      phase: tel.phase,
      planet: tel.planetId,
      mission: tel.missionMode,
      pilot: tel.controlMode,
      x: tel.position.x,
      altM: tel.altitudeM,
      z: tel.position.z,
      vx: tel.velocity.x,
      vy: tel.velocity.y,
      vz: tel.velocity.z,
      speedMps: tel.speedMps,
      tiltDeg: (Math.hypot(tel.pitch, tel.roll) * 180) / Math.PI,
      throttle: tel.throttle,
      qKpa: tel.dynamicPressurePa / 1000,
      gLoad: tel.gLoad,
      fuelFrac,
      rcsPitch: tel.rcsThrust.pitch,
      rcsYaw: tel.rcsThrust.roll,
      activeFaults: tel.activeFaults,
    });
    if (this.flightLog.length > MAX_FLIGHT_LOG_SAMPLES) {
      this.flightLog.shift();
    }
  }

  private readonly animate = (): void => {
    if (this.disposed) {
      return;
    }
    this.rafId = window.requestAnimationFrame(this.animate);

    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.0001, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;
    this.elapsedSec += dt;

    const preTel = this.flightController.getTelemetry();
    this.stepLiveAIControl(dt, preTel);
    const tel = this.flightController.update(
      dt,
      this.manualInput,
      preTel.controlMode === "ai_ppo" ? this.aiCurrentAction : undefined
    );
    this.manualInput.throttleSet = null;
    this.handleLiveTrainPostPhysics(dt, tel);
    this.recordFlightSample(tel, dt);

    this.syncVisualsFromTelemetry(tel);
    this.propulsionEffects.update(dt, tel, this.vehicleIntact);
    this.explosionSystem.update(dt);
    this.launchComplex.update(this.elapsedSec);

    this.cameraDirector.update(dt, tel, this.launchComplex.getBaseFocusTarget());

    const camDist = this.camera.position.distanceTo(
      new THREE.Vector3(tel.position.x, tel.position.y, tel.position.z)
    );
    this.soundEngine.update(
      tel,
      camDist,
      this.currentPlanet.physics.surfacePressureBar,
      this.vehicleIntact
    );

    // Attenuate atmospheric ground fog gracefully as vehicle climbs toward space
    if (this.scene.fog instanceof THREE.FogExp2) {
      const baseFog = this.currentPlanet.atmosphere.fogDensity;
      const altFade = Math.exp(-Math.max(0, this.camera.position.y) / 9500);
      this.scene.fog.density = baseFog * altFade;
    }

    // Apply transient camera shake around CameraDirector position, then restore cleanly
    this.explosionSystem.getCameraShakeOffset(this.shakeOffset);
    this.camera.position.add(this.shakeOffset);
    this.camera.updateMatrixWorld();

    // Project active nozzle exit to screen UV for Schlieren heat distortion pass
    const activeThr = Math.max(tel.boosterThrottle, tel.shipThrottle);
    if (this.vehicleIntact && activeThr > 0.05) {
      this.projVec.set(tel.position.x, tel.position.y, tel.position.z).project(this.camera);
      const uvX = this.projVec.x * 0.5 + 0.5;
      const uvY = this.projVec.y * 0.5 + 0.5;
      const distFactor = Math.max(0, Math.min(1, 220 / Math.max(40, camDist)));
      const inFront = this.projVec.z < 1.0 ? 1.0 : 0.0;
      this.postProcessing.setSchlierenState(
        this.elapsedSec,
        uvX,
        uvY,
        activeThr * distFactor * inFront
      );
    } else {
      this.postProcessing.setSchlierenState(this.elapsedSec, 0.5, 0.5, 0.0);
    }

    this.atmosphereDome.update(dt, this.camera.position);
    this.postProcessing.render(this.scene, this.camera);
    this.camera.position.sub(this.shakeOffset);

    this.fpsAccumTime += dt;
    this.fpsFrameCount += 1;
    if (this.fpsAccumTime >= 0.25) {
      this.currentFps = Math.round(this.fpsFrameCount / this.fpsAccumTime);
      this.fpsAccumTime = 0;
      this.fpsFrameCount = 0;
      this.emitTelemetryNow();
    }
  };

  dispose(): void {
    this.disposed = true;
    this.workerClient.dispose();
    this.soundEngine.dispose();
    window.cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.handleResize);

    this.cameraDirector.dispose();
    this.atmosphereDome.dispose();
    this.terrainSystem.dispose();
    this.launchComplex.dispose();
    this.vehicle.dispose();
    this.propulsionEffects.dispose();
    this.explosionSystem.dispose();
    this.postProcessing.dispose();
    disposeVehicleTextureCache();

    if (this.envRenderTarget) {
      this.envRenderTarget.dispose();
      this.envRenderTarget = null;
    }
    this.pmremGenerator.dispose();
    this.renderer.dispose();
  }
}
