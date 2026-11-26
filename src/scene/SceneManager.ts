import * as THREE from "three";
import type {
  ActivationSnapshot,
  PolicyCheckpoint,
} from "../ai/NeuralNetwork";
import {
  type BestBrainSummary,
  type BrainLevel,
  PPOTrainer,
  type TrainingMetrics,
  createUntrainedBestBrain,
} from "../ai/PPOTrainer";
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
import {
  type LaunchSiteConfig,
  type LaunchSiteId,
  getDefaultLaunchSiteForPlanet,
  getLaunchSiteConfig,
} from "../config/launchSites";
import {
  DEFAULT_PLANET_ID,
  type PlanetConfig,
  type PlanetId,
  getPlanetConfig,
} from "../config/planets";
import {
  DEFAULT_VEHICLE_ID,
  type VehicleConfig,
  type VehicleId,
  getVehicleConfig,
} from "../config/vehicles";
import { ExplosionSystem } from "../effects/ExplosionSystem";
import { PropulsionEffects, type QualityPreset } from "../effects/PropulsionEffects";
import { AutoQualityGuard } from "../ui/uiGuards";
import { smoothstep } from "../utils/noise";
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
  type TimeWarp,
} from "../sim/FlightController";
import {
  CameraDirector,
  type CameraDirectorState,
  type CameraFocusMode,
  type CameraPreset,
  type CameraSceneContext,
  type TrackTarget,
} from "./CameraDirector";
import { LaunchComplex } from "./LaunchComplex";
import { CoastalEnvironment } from "./CoastalEnvironment";
import { EarthTileOverlay } from "./EarthTileOverlay";
import {
  OrbitalObjectManager,
  type OrbitalVisibilityOptions,
} from "./OrbitalObjectManager";
import { OrbitVisualizer } from "./OrbitVisualizer";
import type {
  OrbitalProvenanceSummary,
  SatelliteStateSnapshot,
} from "../orbital/SatelliteCatalog";
import { PlanetGlobe } from "./PlanetGlobe";
import { PostProcessingPipeline } from "./PostProcessing";
import { disposeVehicleTextureCache } from "./ProceduralTextures";
import { StarshipVehicle } from "./StarshipVehicle";
import { TerrainSystem } from "./TerrainSystem";

export type {
  CameraDirectorState,
  CameraFocusMode,
  CameraMode,
  CameraPreset,
  TrackTarget,
} from "./CameraDirector";
export type AITrainingMode = "idle" | "pre_training" | "live_train" | "turbo_train" | "eval";

export interface AIStatusSnapshot {
  mode: AITrainingMode;
  brainLevel: BrainLevel;
  bestBrain: BestBrainSummary;
  statusMessage: string;
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
  canvasNonBlackPct: number;
  canvasMeanRgb: [number, number, number];
  quality: QualityPreset;
  autoQualityEnabled: boolean;
  launchSiteId: LaunchSiteId;
  vehicleId: VehicleId;
  cameraPreset: CameraPreset;
  trackTarget: TrackTarget;
  autoDirector: boolean;
  padRangeHint: string | null;
  audioMuted: boolean;
  orbitPathEnabled: boolean;
  gibsTilesLoaded: boolean;
  orbitalObjects: readonly SatelliteStateSnapshot[];
  selectedOrbitalId: string;
  inspectedOrbitalId: string | null;
  orbitalProvenance: OrbitalProvenanceSummary;
  orbitalVisibility: OrbitalVisibilityOptions;
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
  private readonly planetGlobe: PlanetGlobe;
  private readonly earthTileOverlay: EarthTileOverlay;
  private readonly orbitVisualizer: OrbitVisualizer;
  private readonly orbitalObjects: OrbitalObjectManager;
  private readonly terrainSystem: TerrainSystem;
  private readonly coastalEnvironment: CoastalEnvironment;
  private readonly launchComplex: LaunchComplex;
  private readonly vehicle: StarshipVehicle;
  private readonly propulsionEffects: PropulsionEffects;
  private readonly explosionSystem: ExplosionSystem;
  private readonly postProcessing: PostProcessingPipeline;
  private readonly flightController: FlightController;
  private readonly sunDirVec = new THREE.Vector3(0.6, 0.4, -0.7).normalize();

  private currentPlanet: PlanetConfig;
  private currentSite: LaunchSiteConfig;
  private currentVehicle: VehicleConfig;
  private quality: QualityPreset = "med";
  private readonly autoQualityGuard = new AutoQualityGuard();
  private onAutoQualityStepDown?: (from: QualityPreset, to: QualityPreset, fps: number) => void;
  private prevStageSeparated = false;
  private prevSideSeparated = false;
  private vehicleIntact = true;
  private lastCrashId = -1;
  private lastBoosterCrashId = -1;

  private readonly shakeOffset = new THREE.Vector3();
  private readonly projVec = new THREE.Vector3();
  private readonly stationPosScratch = new THREE.Vector3();
  private readonly inspectedPosScratch = new THREE.Vector3();
  private onCameraStateChange?: (state: CameraDirectorState) => void;
  private onOrbitalObjectPicked?: (snap: SatelliteStateSnapshot) => void;
  private pointerDownX = 0;
  private pointerDownY = 0;
  private pointerDownBtn = -1;

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
  private bestCheckpoint: PolicyCheckpoint | null = null;
  private bestBrain: BestBrainSummary = createUntrainedBestBrain();
  private aiStatusMessage =
    "Untrained random brain. Click 1. PRE-TRAIN BRAIN or 2. FAST TRAIN.";

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
  private renderedFrames = 0;
  private pixelProbeDone = false;
  private canvasNonBlackPct = 0;
  private canvasMeanRgb: [number, number, number] = [0, 0, 0];
  private readonly rendererName: string;
  private readonly onTelemetry?: (telemetry: SceneTelemetry) => void;

  constructor(
    canvas: HTMLCanvasElement,
    initialPlanetId: PlanetId = DEFAULT_PLANET_ID,
    onTelemetry?: (telemetry: SceneTelemetry) => void,
    onMonteCarloResult?: (summary: MonteCarloSummary) => void
  ) {
    this.canvas = canvas;
    this.onTelemetry = onTelemetry;
    this.onMonteCarloResult = onMonteCarloResult;
    this.currentPlanet = getPlanetConfig(initialPlanetId);
    this.currentSite = getDefaultLaunchSiteForPlanet(initialPlanetId);
    this.currentVehicle = getVehicleConfig(DEFAULT_VEHICLE_ID);

    this.liveTrainer = new PPOTrainer(
      {
        planetId: initialPlanetId,
        missionMode: "launch",
        randomizeSpawn: this.aiRandomizeSpawn,
        faultConfig: this.faultConfig,
      },
      { learningRate: this.aiLearningRate, rolloutSteps: 256 },
      42
    );
    this.aiMetrics = this.liveTrainer.getLastMetrics();

    this.workerClient = new PPOWorkerClient({
      onWarmStartComplete: ({
        metrics,
        bestBrain,
        bestCheckpoint,
        statusMessage,
      }) => {
        this.liveTrainer.loadCheckpoint(bestCheckpoint, bestBrain);
        this.bestCheckpoint = bestCheckpoint;
        this.bestBrain = bestBrain;
        this.aiMetrics = { ...metrics, stepsPerSec: 0 };
        this.aiHistory = [...this.liveTrainer.getHistory(), this.aiMetrics].slice(-60);
        this.aiMode = "idle";
        this.aiStatusMessage = statusMessage;
        this.aiLastError = null;
        this.emitTelemetryNow();
      },
      onProgress: (
        metrics,
        checkpoint,
        historyTail,
        running,
        bestBrain,
        bestCheckpoint
      ) => {
        this.liveTrainer.loadCheckpoint(
          checkpoint,
          bestBrain.hasTrainedWeights ? bestBrain : undefined
        );
        this.bestCheckpoint = bestBrain.hasTrainedWeights ? bestCheckpoint : null;
        this.bestBrain = bestBrain;
        this.aiMetrics = metrics;
        this.aiHistory = historyTail;
        this.aiLastError = null;
        if (!running && this.aiMode === "turbo_train") {
          this.aiMode = "idle";
        }
        this.aiStatusMessage = bestBrain.hasTrainedWeights
          ? `PPO Ep ${metrics.episodesCompleted} · Best: ${bestBrain.evalSuccessCount}/${bestBrain.evalEpisodes} nom (${bestBrain.evalSafeRatePct.toFixed(0)}% safe)`
          : `Training Ep ${metrics.episodesCompleted} · Mean Return ${metrics.rollingMeanReturn.toFixed(1)}`;
        this.emitTelemetryNow();
      },
      onPaused: (metrics, _checkpoint, bestBrain, bestCheckpoint) => {
        this.bestCheckpoint = bestBrain.hasTrainedWeights ? bestCheckpoint : null;
        this.bestBrain = bestBrain;
        this.liveTrainer.loadCheckpoint(
          bestCheckpoint,
          bestBrain.hasTrainedWeights ? bestBrain : undefined
        );
        this.aiMetrics = { ...metrics, stepsPerSec: 0 };
        if (this.aiMode === "turbo_train") {
          this.aiMode = "idle";
        }
        this.aiStatusMessage = bestBrain.hasTrainedWeights
          ? `Paused — Best brain (${bestBrain.evalSuccessRatePct.toFixed(0)}% nominal, ${bestBrain.evalSafeRatePct.toFixed(0)}% safe) ready.`
          : "Training paused.";
        this.emitTelemetryNow();
      },
      onReady: (metrics, checkpoint, bestBrain, bestCheckpoint) => {
        this.bestCheckpoint = bestBrain.hasTrainedWeights ? bestCheckpoint : null;
        this.bestBrain = bestBrain;
        this.liveTrainer.loadCheckpoint(
          checkpoint,
          bestBrain.hasTrainedWeights ? bestBrain : undefined
        );
        this.aiMetrics = { ...metrics, stepsPerSec: 0 };
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
        this.aiStatusMessage = `Worker error: ${message}`;
        this.emitTelemetryNow();
      },
    });

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      logarithmicDepthBuffer: true,
      powerPreference: "high-performance",
    });
    const initialPr = Math.min(window.devicePixelRatio || 1, this.getMaxPixelRatio(this.quality));
    this.renderer.setPixelRatio(initialPr);
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
      Math.max(500_000, this.currentPlanet.scale.simRadiusM * 26)
    );
    this.cameraDirector = new CameraDirector(this.camera, this.canvas);
    this.cameraDirector.setPlanetRadius(this.currentPlanet.scale.simRadiusM);
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
    this.terrainSystem = new TerrainSystem(
      this.currentPlanet,
      maxAnisotropy,
      this.quality,
      this.currentSite
    );
    this.coastalEnvironment = new CoastalEnvironment(
      this.currentPlanet,
      this.quality,
      maxAnisotropy,
      this.currentSite
    );
    this.planetGlobe = new PlanetGlobe(
      this.currentPlanet,
      this.quality,
      maxAnisotropy,
      (color) => this.terrainSystem.setSatelliteSiteTint(color)
    );
    this.planetGlobe.setLaunchSite(
      this.currentSite.id,
      this.currentSite.latDeg,
      this.currentSite.lonDeg
    );
    this.earthTileOverlay = new EarthTileOverlay(this.currentPlanet);
    this.earthTileOverlay.setSiteCoords(this.currentSite.latDeg, this.currentSite.lonDeg);
    this.orbitVisualizer = new OrbitVisualizer(this.currentPlanet);
    this.orbitVisualizer.setSiteShortName(this.currentSite.shortName);
    this.orbitalObjects = new OrbitalObjectManager(this.currentPlanet, this.currentSite);
    this.launchComplex = new LaunchComplex(
      this.currentPlanet,
      maxAnisotropy,
      this.quality,
      this.currentSite
    );
    this.vehicle = new StarshipVehicle(maxAnisotropy, this.currentVehicle.id);
    this.propulsionEffects = new PropulsionEffects(
      this.currentPlanet,
      this.vehicle.getBoosterPlumeAnchor(),
      this.vehicle.getShipPlumeAnchor(),
      this.vehicle.getRcsAnchorGroup(),
      this.vehicle.getSideBoosterPlumeAnchors()
    );
    this.propulsionEffects.reconfigureSockets(this.vehicle.getPlumeSocketSpec());
    this.explosionSystem = new ExplosionSystem(this.currentPlanet);

    this.scene.add(
      this.atmosphereDome.group,
      this.planetGlobe.group,
      this.earthTileOverlay.group,
      this.orbitVisualizer.group,
      this.orbitalObjects.group,
      this.terrainSystem.group,
      this.coastalEnvironment.group,
      this.launchComplex.group,
      this.vehicle.root,
      this.vehicle.detachedBoosterRoot,
      this.vehicle.detachedLeftSideRoot,
      this.vehicle.detachedRightSideRoot,
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
    this.postProcessing.setSize(window.innerWidth, Math.max(1, window.innerHeight), initialPr);

    this.flightController = new FlightController(
      this.currentPlanet.id,
      this.launchComplex.getPadDeckY(),
      "launch",
      this.currentVehicle.id,
      this.currentSite.id
    );

    this.cameraDirector.setStateListener((camState) => {
      this.onCameraStateChange?.(camState);
    });
    this.applyPlanetEnvironment(this.currentPlanet);
    const initTel = this.flightController.getTelemetry();
    this.syncVisualsFromTelemetry(initTel);
    this.cameraDirector.reLockOnVehicle(this.buildCameraContext(initTel));
    this.syncFloatingOriginTransforms(initTel, 0);
    this.orbitalObjects.startInitialLiveSync();

    this.canvas.addEventListener("pointerdown", this.handleCanvasPointerDown);
    this.canvas.addEventListener("pointerup", this.handleCanvasPointerUp);
    window.addEventListener("resize", this.handleResize);
    this.lastFrameTime = performance.now();
    this.animate();
  }

  setOrbitalObjectPickedListener(listener: (snap: SatelliteStateSnapshot) => void): void {
    this.onOrbitalObjectPicked = listener;
  }

  private readonly handleCanvasPointerDown = (event: PointerEvent): void => {
    this.pointerDownX = event.clientX;
    this.pointerDownY = event.clientY;
    this.pointerDownBtn = event.button;
  };

  private readonly handleCanvasPointerUp = (event: PointerEvent): void => {
    if (this.pointerDownBtn !== 0 || event.button !== 0) {
      return;
    }
    const moved = Math.hypot(
      event.clientX - this.pointerDownX,
      event.clientY - this.pointerDownY
    );
    if (moved > 6) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) {
      return;
    }
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    const hit = this.orbitalObjects.pickAtNdc(
      ndcX,
      ndcY,
      this.camera,
      rect.width,
      rect.height,
      this.cameraDirector.getRenderOrigin()
    );
    if (hit) {
      this.selectOrbitalObject(hit.id);
      this.onOrbitalObjectPicked?.(hit);
    }
  };

  setCameraStateListener(listener: (state: CameraDirectorState) => void): void {
    this.onCameraStateChange = listener;
    listener(this.cameraDirector.getState());
  }

  private buildCameraContext(tel: FlightTelemetry): CameraSceneContext {
    const inspected = this.orbitalObjects.getInspectedWorldPosition(this.inspectedPosScratch);
    return {
      tel,
      baseTarget: this.launchComplex.getBaseFocusTarget(),
      stationWorldPos:
        this.orbitalObjects.getPrimaryStationWorldPosition(this.stationPosScratch) ??
        this.launchComplex.getOrbitalStationWorldPosition(this.stationPosScratch),
      inspectedOrbitalPos: inspected ? inspected.pos : null,
      inspectedOrbitalRadiusM: inspected?.inspectRadiusM,
      shipGroup: this.vehicle.getShipGroup(),
      boosterGroup: this.vehicle.getBoosterGroup(),
      vehicleRoot: this.vehicle.root,
      detachedBoosterRoot: this.vehicle.detachedBoosterRoot,
    };
  }

  private getCurrentCameraAltitudeM(): number {
    const camWorld = this.cameraDirector.getCameraWorldPosition();
    const R = this.currentPlanet.scale.simRadiusM;
    return Math.max(0, Math.hypot(camWorld.x, camWorld.y + R, camWorld.z) - R);
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
    const skyGeo = new THREE.SphereGeometry(24, 24, 16);
    const sunDir = new THREE.Vector3(
      config.atmosphere.sunDirection[0],
      config.atmosphere.sunDirection[1],
      config.atmosphere.sunDirection[2]
    ).normalize();
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        uTop: { value: new THREE.Color(config.atmosphere.zenithColor) },
        uHorizon: { value: new THREE.Color(config.atmosphere.horizonColor) },
        uGround: { value: new THREE.Color(config.lighting.hemiGroundColor) },
        uSunDir: { value: sunDir },
        uSunCol: { value: new THREE.Color(config.lighting.sunLightColor) },
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
        uniform vec3 uSunDir;
        uniform vec3 uSunCol;
        varying vec3 vPos;
        void main() {
          vec3 c = vPos.y >= 0.0
            ? mix(uHorizon, uTop, pow(vPos.y, 0.65))
            : mix(uHorizon * 0.55, uGround, clamp(-vPos.y * 2.0, 0.0, 1.0));
          float sunGlow = pow(max(dot(vPos, normalize(uSunDir)), 0.0), 18.0) * 0.85;
          c += uSunCol * sunGlow;
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
    this.sunDirVec
      .set(atmosphere.sunDirection[0], atmosphere.sunDirection[1], atmosphere.sunDirection[2])
      .normalize();

    this.sunLight.position.copy(this.sunDirVec).multiplyScalar(320);
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
    if (
      tel.sideBoostersSeparated &&
      !this.prevSideSeparated &&
      tel.missionMode === "launch"
    ) {
      this.vehicle.triggerSideBoosterSeparation(
        new THREE.Vector3(
          tel.sideBoosters.leftPos.x,
          tel.sideBoosters.leftPos.y,
          tel.sideBoosters.leftPos.z
        ),
        new THREE.Vector3(
          tel.sideBoosters.rightPos.x,
          tel.sideBoosters.rightPos.y,
          tel.sideBoosters.rightPos.z
        ),
        tel.sideBoosters.pitch,
        tel.sideBoosters.yaw,
        tel.sideBoosters.roll
      );
    }
    this.prevSideSeparated = tel.sideBoostersSeparated;

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

    if (tel.booster.impactEvent && tel.booster.impactEvent.id !== this.lastBoosterCrashId) {
      this.lastBoosterCrashId = tel.booster.impactEvent.id;
      this.vehicle.setBoosterIntactVisible(false);
      this.explosionSystem.trigger(tel.booster.impactEvent);
      this.soundEngine.triggerExplosion(
        tel.booster.impactEvent,
        this.currentPlanet.physics.surfacePressureBar
      );
    }

    const origin = this.cameraDirector.getRenderOrigin();
    this.vehicle.root.position.set(
      tel.position.x - origin.x,
      tel.position.y - origin.y,
      tel.position.z - origin.z
    );
    this.vehicle.root.rotation.set(tel.roll, tel.yaw, -tel.pitch);
    this.vehicle.root.updateMatrixWorld(true);

    if (tel.sideBoostersSeparated && tel.missionMode === "launch") {
      const showSide = tel.sideBoosters.active;
      this.vehicle.detachedLeftSideRoot.visible = showSide;
      this.vehicle.detachedRightSideRoot.visible = showSide;
      if (showSide) {
        this.vehicle.detachedLeftSideRoot.position.set(
          tel.sideBoosters.leftPos.x - origin.x,
          tel.sideBoosters.leftPos.y - origin.y,
          tel.sideBoosters.leftPos.z - origin.z
        );
        this.vehicle.detachedLeftSideRoot.rotation.set(
          tel.sideBoosters.roll + tel.sideBoosters.spinAngle * 0.45,
          tel.sideBoosters.yaw,
          -tel.sideBoosters.pitch - tel.sideBoosters.spinAngle * 0.35
        );
        this.vehicle.detachedLeftSideRoot.updateMatrixWorld(true);

        this.vehicle.detachedRightSideRoot.position.set(
          tel.sideBoosters.rightPos.x - origin.x,
          tel.sideBoosters.rightPos.y - origin.y,
          tel.sideBoosters.rightPos.z - origin.z
        );
        this.vehicle.detachedRightSideRoot.rotation.set(
          tel.sideBoosters.roll - tel.sideBoosters.spinAngle * 0.45,
          tel.sideBoosters.yaw,
          -tel.sideBoosters.pitch + tel.sideBoosters.spinAngle * 0.35
        );
        this.vehicle.detachedRightSideRoot.updateMatrixWorld(true);
      }
    }

    if (tel.stageSeparated && tel.missionMode === "launch") {
      this.vehicle.detachedBoosterRoot.position.set(
        tel.booster.position.x - origin.x,
        tel.booster.position.y - origin.y,
        tel.booster.position.z - origin.z
      );
      this.vehicle.detachedBoosterRoot.rotation.set(
        tel.booster.roll,
        tel.booster.yaw,
        -tel.booster.pitch
      );
      this.vehicle.detachedBoosterRoot.updateMatrixWorld(true);
    }

    this.vehicle.setFrostLevel(tel.frostLevel);
    this.vehicle.setFlapAngle(tel.flapAngleRad);
    this.vehicle.setGridFinDeflection(
      tel.stageSeparated ? tel.booster.gridFinPitch : tel.gridFinPitch,
      tel.stageSeparated ? tel.booster.gridFinYaw : tel.gridFinYaw
    );
    this.vehicle.setLandingLegsDeployed(tel.landingLegsDeployed);
    this.vehicle.setBoosterLandingLegsDeployed(tel.booster.landingLegsDeployed ?? 0);
    this.vehicle.setEngineVisualState(
      tel.boosterThrottle,
      tel.shipThrottle,
      tel.gimbalX,
      tel.gimbalZ,
      tel.stageSeparated && tel.booster.active ? tel.booster.throttle : 0,
      tel.sideBoosterThrottle
    );

    this.launchComplex.setUmbilicalRetracted(tel.umbilicalRetracted);
    this.launchComplex.setCatchArmsOpen(tel.catchArmsOpen);
    this.launchComplex.setCatchCarriageHeight(tel.catchCarriageY);
  }

  private getMaxPixelRatio(preset: QualityPreset): number {
    if (preset === "low") return 1.0;
    if (preset === "med") return 1.25;
    return 1.75;
  }

  setQualityPreset(preset: QualityPreset): void {
    this.quality = preset;
    this.autoQualityGuard.resetWindow();
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.propulsionEffects.setQuality(preset);
    this.explosionSystem.setQuality(preset);
    this.postProcessing.setQuality(preset);
    this.terrainSystem.setQuality(preset, maxAniso);
    this.coastalEnvironment.setQuality(preset, maxAniso);
    this.planetGlobe.setQuality(preset, maxAniso);

    const pr = Math.min(window.devicePixelRatio || 1, this.getMaxPixelRatio(preset));
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

  setAutoQualityEnabled(enabled: boolean): void {
    this.autoQualityGuard.setEnabled(enabled);
    this.emitTelemetryNow();
  }

  isAutoQualityEnabled(): boolean {
    return this.autoQualityGuard.isEnabled();
  }

  setAutoQualityStepDownListener(
    listener: (from: QualityPreset, to: QualityPreset, fps: number) => void
  ): void {
    this.onAutoQualityStepDown = listener;
  }

  private resetAIContext(planetId: PlanetId, missionMode: MissionMode): void {
    this.workerClient.bumpSession();
    this.liveEpActive = false;
    this.aiMode = "idle";
    this.liveTrainer.setEnvConfig(
      planetId,
      missionMode,
      this.aiRandomizeSpawn,
      this.faultConfig
    );
    this.bestCheckpoint = null;
    this.bestBrain = createUntrainedBestBrain();
    this.aiMetrics = { ...this.liveTrainer.getLastMetrics(), stepsPerSec: 0 };
    this.aiHistory = [];
    this.aiLastError = null;
    const pName = getPlanetConfig(planetId).name;
    this.aiStatusMessage = `Switched to ${pName} ${missionMode.toUpperCase()} — click 1. PRE-TRAIN BRAIN or 2. FAST TRAIN.`;
    this.workerClient.init(
      planetId,
      missionMode,
      this.aiRandomizeSpawn,
      this.aiLearningRate,
      this.faultConfig
    );
  }

  setPlanet(id: PlanetId, siteOverride?: LaunchSiteConfig): PlanetConfig {
    const targetSite = siteOverride ?? getDefaultLaunchSiteForPlanet(id);
    if (this.currentPlanet.id === id && this.currentSite.id === targetSite.id) {
      return this.currentPlanet;
    }
    if (this.currentPlanet.id === id) {
      this.setLaunchSite(targetSite.id);
      return this.currentPlanet;
    }

    const next = getPlanetConfig(id);
    this.currentPlanet = next;
    this.currentSite = targetSite;
    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.terrainSystem.updatePlanet(next, maxAnisotropy, this.quality, targetSite);
    this.coastalEnvironment.setPlanet(next, targetSite);
    this.planetGlobe.updatePlanet(next, this.quality, maxAnisotropy);
    this.planetGlobe.setLaunchSite(targetSite.id, targetSite.latDeg, targetSite.lonDeg);
    this.earthTileOverlay.setPlanet(next);
    this.earthTileOverlay.setSiteCoords(targetSite.latDeg, targetSite.lonDeg);
    this.orbitVisualizer.updatePlanet(next);
    this.orbitVisualizer.setSiteShortName(targetSite.shortName);
    this.orbitalObjects.setPlanet(next, targetSite);
    this.launchComplex.updatePlanet(next, maxAnisotropy, this.quality, targetSite);
    this.propulsionEffects.setPlanet(next);
    this.explosionSystem.setPlanet(next);
    this.applyPlanetEnvironment(next);
    this.cameraDirector.setPlanetRadius(next.scale.simRadiusM);

    const rawMission = this.flightController.getTelemetry().missionMode;
    const mission = !this.currentVehicle.supportsLandingMode && rawMission === "landing" ? "launch" : rawMission;
    this.vehicle.setVehicle(this.currentVehicle.id, mission);
    this.propulsionEffects.reconfigureSockets(this.vehicle.getPlumeSocketSpec());
    this.resetAIContext(id, mission);
    this.flightController.reset(
      id,
      this.launchComplex.getPadDeckY(),
      mission,
      this.currentVehicle.id,
      targetSite.id
    );
    this.resetMission();
    return next;
  }

  setLaunchSite(siteId: LaunchSiteId): LaunchSiteConfig {
    const nextSite = getLaunchSiteConfig(siteId);
    if (nextSite.planetId !== this.currentPlanet.id) {
      this.setPlanet(nextSite.planetId, nextSite);
      return nextSite;
    }
    if (this.currentSite.id === nextSite.id) {
      return this.currentSite;
    }
    this.currentSite = nextSite;
    const maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.planetGlobe.setLaunchSite(nextSite.id, nextSite.latDeg, nextSite.lonDeg);
    this.earthTileOverlay.setSiteCoords(nextSite.latDeg, nextSite.lonDeg);
    this.orbitVisualizer.setSiteShortName(nextSite.shortName);
    this.orbitalObjects.setLaunchSite(nextSite);
    this.terrainSystem.setLaunchSite(nextSite, maxAnisotropy, this.quality);
    this.coastalEnvironment.setLaunchSite(nextSite);
    this.launchComplex.setLaunchSite(nextSite, maxAnisotropy, this.quality);
    this.flightController.setLaunchSite(nextSite.id, this.launchComplex.getPadDeckY());
    this.resetMission();
    this.emitTelemetryNow();
    return nextSite;
  }

  getLaunchSite(): LaunchSiteConfig {
    return this.currentSite;
  }

  setVehicle(vehicleId: VehicleId): VehicleConfig {
    const nextVeh = getVehicleConfig(vehicleId);
    if (this.currentVehicle.id === nextVeh.id) {
      return this.currentVehicle;
    }
    this.currentVehicle = nextVeh;

    let mission = this.flightController.getTelemetry().missionMode;
    if (!nextVeh.supportsLandingMode && mission === "landing") {
      mission = "launch";
      this.resetAIContext(this.currentPlanet.id, mission);
    }

    this.flightController.setVehicle(nextVeh.id);
    this.flightController.reset(
      this.currentPlanet.id,
      this.launchComplex.getPadDeckY(),
      mission,
      nextVeh.id,
      this.currentSite.id
    );
    this.vehicle.setVehicle(nextVeh.id, mission);
    this.propulsionEffects.reconfigureSockets(this.vehicle.getPlumeSocketSpec());
    this.resetMission();
    this.emitTelemetryNow();
    return nextVeh;
  }

  getVehicle(): VehicleConfig {
    return this.currentVehicle;
  }

  setMissionMode(mode: MissionMode): void {
    const effectiveMode =
      mode === "landing" && !this.currentVehicle.supportsLandingMode ? "launch" : mode;
    this.resetAIContext(this.currentPlanet.id, effectiveMode);
    this.flightController.reset(
      this.currentPlanet.id,
      this.launchComplex.getPadDeckY(),
      effectiveMode,
      this.currentVehicle.id,
      this.currentSite.id
    );
    this.flightLog.length = 0;
    this.resetVehicleToFlightState();
    const tel = this.flightController.getTelemetry();
    this.cameraDirector.reLockOnVehicle(this.buildCameraContext(tel));
    this.syncFloatingOriginTransforms(tel, this.getCurrentCameraAltitudeM());
    this.emitTelemetryNow();
  }

  setControlMode(mode: ControlMode): void {
    this.flightController.setControlMode(mode);
    if (mode === "ai_ppo") {
      if (this.bestCheckpoint) {
        this.liveTrainer.loadCheckpoint(this.bestCheckpoint, this.bestBrain);
      }
      if (this.aiMode === "idle") {
        this.aiMode = "eval";
        this.aiStatusMessage = this.bestBrain.hasTrainedWeights
          ? `AI Pilot active — loaded best saved brain (${this.bestBrain.evalSuccessRatePct.toFixed(0)}% nominal).`
          : "AI Pilot active — untrained random weights (expect crash).";
      }
    } else if (this.aiMode === "live_train" || this.aiMode === "eval") {
      this.aiMode = "idle";
      this.liveEpActive = false;
    }
  }

  // --- Camera & Audio Controls ---

  setCameraPreset(preset: CameraPreset): void {
    this.orbitalObjects.setInspectedId(null);
    const tel = this.flightController.getTelemetry();
    this.syncVisualsFromTelemetry(tel);
    this.cameraDirector.setMode(preset, this.buildCameraContext(tel), false);
    const camAltM = this.getCurrentCameraAltitudeM();
    this.syncFloatingOriginTransforms(tel, camAltM);
    this.orbitalObjects.update(
      0,
      this.elapsedSec,
      tel.orbital.timeWarp,
      false,
      this.camera,
      camAltM,
      this.cameraDirector.getMode(),
      this.cameraDirector.getRenderOrigin()
    );
    this.emitTelemetryNow();
  }

  getCameraPreset(): CameraPreset {
    return this.cameraDirector.getMode();
  }

  setTrackTarget(target: TrackTarget): void {
    this.orbitalObjects.setInspectedId(null);
    const tel = this.flightController.getTelemetry();
    this.syncVisualsFromTelemetry(tel);
    this.cameraDirector.setTrackTarget(target, this.buildCameraContext(tel));
    this.syncFloatingOriginTransforms(tel, this.getCurrentCameraAltitudeM());
    this.emitTelemetryNow();
  }

  // --- Stage 6D: Explorable Orbital Objects & CelesTrak SGP4 Controls ---

  selectOrbitalObject(id: string): SatelliteStateSnapshot | null {
    const snap = this.orbitalObjects.setSelectedId(id);
    this.emitTelemetryNow();
    return snap;
  }

  inspectOrbitalObject(id: string): void {
    this.orbitalObjects.setInspectedId(id);
    const tel = this.flightController.getTelemetry();
    this.syncVisualsFromTelemetry(tel);
    this.cameraDirector.focusOrbitalObject(this.buildCameraContext(tel));
    const camAltM = this.getCurrentCameraAltitudeM();
    this.syncFloatingOriginTransforms(tel, camAltM);
    this.orbitalObjects.update(
      0,
      this.elapsedSec,
      tel.orbital.timeWarp,
      false,
      this.camera,
      camAltM,
      this.cameraDirector.getMode(),
      this.cameraDirector.getRenderOrigin()
    );
    this.emitTelemetryNow();
  }

  returnToVehicleFromOrbital(): void {
    this.orbitalObjects.setInspectedId(null);
    const tel = this.flightController.getTelemetry();
    this.syncVisualsFromTelemetry(tel);
    this.cameraDirector.reLockOnVehicle(this.buildCameraContext(tel));
    this.syncFloatingOriginTransforms(tel, this.getCurrentCameraAltitudeM());
    this.emitTelemetryNow();
  }

  setOrbitalVisibility(next: Partial<OrbitalVisibilityOptions>): void {
    this.orbitalObjects.setVisibilityOptions(next);
    this.emitTelemetryNow();
  }

  async refreshCelesTrakData(force = true): Promise<OrbitalProvenanceSummary> {
    const summary = await this.orbitalObjects.refreshLiveData(force);
    this.emitTelemetryNow();
    return summary;
  }

  getOrbitalStateSnapshot(): {
    objects: readonly SatelliteStateSnapshot[];
    selectedId: string;
    inspectedId: string | null;
    provenance: OrbitalProvenanceSummary;
    visibility: OrbitalVisibilityOptions;
  } {
    return {
      objects: this.orbitalObjects.getSnapshots(),
      selectedId: this.orbitalObjects.getSelectedId(),
      inspectedId: this.orbitalObjects.getInspectedId(),
      provenance: this.orbitalObjects.getProvenance(),
      visibility: this.orbitalObjects.getVisibilityOptions(),
    };
  }

  getTrackTarget(): TrackTarget {
    return this.cameraDirector.getTrackTarget();
  }

  setAutoDirector(enabled: boolean): void {
    const tel = this.flightController.getTelemetry();
    this.syncVisualsFromTelemetry(tel);
    this.cameraDirector.setAutoDirector(enabled, this.buildCameraContext(tel));
    this.syncFloatingOriginTransforms(tel, this.getCurrentCameraAltitudeM());
    this.emitTelemetryNow();
  }

  toggleAutoDirector(): boolean {
    const tel = this.flightController.getTelemetry();
    this.syncVisualsFromTelemetry(tel);
    const next = this.cameraDirector.toggleAutoDirector(this.buildCameraContext(tel));
    this.syncFloatingOriginTransforms(tel, this.getCurrentCameraAltitudeM());
    this.emitTelemetryNow();
    return next;
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

  isGibsTilesLoaded(): boolean {
    return this.earthTileOverlay.isLoaded();
  }

  setOrbitPathEnabled(enabled: boolean): void {
    this.orbitVisualizer.setEnabled(enabled);
    this.emitTelemetryNow();
  }

  isOrbitPathEnabled(): boolean {
    return this.orbitVisualizer.isEnabled();
  }

  setTimeWarp(warp: TimeWarp): void {
    this.flightController.setTimeWarp(warp);
    this.emitTelemetryNow();
  }

  getTimeWarp(): TimeWarp {
    return this.flightController.getTimeWarp();
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

  // --- Milestone 2/3/Hotfix: Neural AI (PPO) Controls ---

  startLiveTrain(): void {
    if (this.aiMode === "live_train") {
      this.pauseAI();
      return;
    }
    this.workerClient.bumpSession();
    this.workerClient.pause();
    this.aiLastError = null;
    this.aiMode = "live_train";
    this.aiStatusMessage = "Watching AI explore, crash & learn live in 3D...";
    this.flightController.setControlMode("ai_ppo");
    this.spawnLive3DRLEpisode();
    this.emitTelemetryNow();
  }

  toggleTurboTrain(): void {
    if (this.aiMode === "turbo_train") {
      this.pauseAI();
      return;
    }
    this.startTurboTrain();
  }

  startTurboTrain(): void {
    this.workerClient.bumpSession();
    this.aiLastError = null;
    this.liveEpActive = false;
    this.aiMode = "turbo_train";
    this.aiStatusMessage = "Training PPO in background Web Worker...";
    const mission = this.flightController.getTelemetry().missionMode;
    this.workerClient.syncWeights(this.liveTrainer.exportCheckpoint());
    this.workerClient.startTurboTrain(
      this.currentPlanet.id,
      mission,
      this.aiRandomizeSpawn,
      this.aiLearningRate,
      this.faultConfig
    );
    this.emitTelemetryNow();
  }

  pauseAI(): void {
    if (this.aiMode === "turbo_train" || this.aiMode === "pre_training") {
      this.workerClient.bumpSession();
      this.workerClient.pause();
    }
    this.aiMode = "idle";
    this.liveEpActive = false;
    this.aiMetrics = { ...this.aiMetrics, stepsPerSec: 0 };
    this.aiStatusMessage = this.bestBrain.hasTrainedWeights
      ? `Idle — Best saved brain (${this.bestBrain.evalSuccessRatePct.toFixed(0)}% nominal, ${this.bestBrain.evalSafeRatePct.toFixed(0)}% safe).`
      : "Idle — untrained random weights.";
    this.emitTelemetryNow();
  }

  startAIEval(): void {
    if (this.aiMode === "turbo_train" || this.aiMode === "pre_training") {
      this.workerClient.bumpSession();
      this.workerClient.pause();
    }
    if (this.bestCheckpoint) {
      this.liveTrainer.loadCheckpoint(this.bestCheckpoint, this.bestBrain);
    }
    this.aiLastError = null;
    this.aiMode = "eval";
    this.aiMetrics = { ...this.aiMetrics, stepsPerSec: 0 };
    this.aiStatusMessage = this.bestBrain.hasTrainedWeights
      ? `Flying best saved brain deterministically (${this.bestBrain.evalSuccessCount}/${this.bestBrain.evalEpisodes} nom, ${this.bestBrain.evalSafeRatePct.toFixed(0)}% safe).`
      : "Flying untrained random weights (expect crash — run 1. PRE-TRAIN BRAIN first).";
    this.flightController.setControlMode("ai_ppo");
    this.spawnLive3DRLEpisode();
    this.emitTelemetryNow();
  }

  startPreTrain(): void {
    this.workerClient.bumpSession();
    this.liveEpActive = false;
    this.aiLastError = null;
    this.aiMode = "pre_training";
    const mission = this.flightController.getTelemetry().missionMode;
    this.aiMetrics = { ...this.aiMetrics, stepsPerSec: 0 };
    this.aiStatusMessage = `Pre-training brain on ${this.currentPlanet.name} ${mission.toUpperCase()} guidance demos...`;
    this.emitTelemetryNow();
    this.workerClient.warmStart(
      this.currentPlanet.id,
      mission,
      this.aiRandomizeSpawn,
      this.aiLearningRate,
      this.faultConfig,
      12,
      14
    );
  }

  runWarmStartAndPPO(): void {
    this.startPreTrain();
  }

  resetAIWeights(): void {
    this.workerClient.bumpSession();
    this.aiLastError = null;
    this.liveEpActive = false;
    this.liveTrainer.resetWeights(42);
    this.bestCheckpoint = null;
    this.bestBrain = createUntrainedBestBrain();
    this.aiMetrics = { ...this.liveTrainer.getLastMetrics(), stepsPerSec: 0 };
    this.aiHistory = [];
    this.aiMode = "idle";
    this.aiStatusMessage = "AI brain wiped to random untrained weights.";
    this.workerClient.resetWeights(42);
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
    return this.bestCheckpoint ?? this.liveTrainer.exportCheckpoint();
  }

  importPolicyCheckpoint(json: string): void {
    try {
      const cp = this.liveTrainer.loadCheckpoint(json);
      const evalSummary = this.liveTrainer.evaluateBatch(5, true, 9001);
      const safePct = Math.min(100, evalSummary.successRatePct + evalSummary.hardLandingRatePct);
      const importedBrain: BestBrainSummary = {
        brainLevel: "ppo_trained",
        hasTrainedWeights: true,
        evalEpisodes: evalSummary.episodes,
        evalSuccessCount: Math.round((evalSummary.successRatePct / 100) * evalSummary.episodes),
        evalSafeCount: Math.round((safePct / 100) * evalSummary.episodes),
        evalSuccessRatePct: evalSummary.successRatePct,
        evalSafeRatePct: safePct,
        evalMeanReturn: evalSummary.meanReturn,
        evalMeanTouchdownVy: evalSummary.meanTouchdownVy,
      };
      this.bestCheckpoint = cp;
      this.bestBrain = importedBrain;
      this.liveTrainer.loadCheckpoint(cp, importedBrain);
      this.aiLastError = null;
      this.aiStatusMessage = `Loaded checkpoint (${importedBrain.evalSuccessRatePct.toFixed(0)}% nominal, ${importedBrain.evalSafeRatePct.toFixed(0)}% safe).`;
      this.aiMetrics = {
        ...this.liveTrainer.getLastMetrics(),
        totalSteps: cp.totalSteps,
        episodesCompleted: cp.episodesCompleted,
        stepsPerSec: 0,
      };
      this.workerClient.loadCheckpoint(cp);
      this.emitTelemetryNow();
    } catch (err) {
      this.aiLastError = err instanceof Error ? err.message : "Invalid checkpoint JSON";
      this.emitTelemetryNow();
    }
  }

  getAIStatus(): AIStatusSnapshot {
    const isActivelyTraining =
      this.aiMode === "turbo_train" || this.aiMode === "live_train";
    return {
      mode: this.aiMode,
      brainLevel: this.bestBrain.hasTrainedWeights
        ? this.bestBrain.brainLevel
        : this.liveTrainer.brainLevel,
      bestBrain: this.bestBrain,
      statusMessage: this.aiStatusMessage,
      learningRate: this.aiLearningRate,
      randomizeSpawn: this.aiRandomizeSpawn,
      metrics: {
        ...this.aiMetrics,
        stepsPerSec: isActivelyTraining ? this.aiMetrics.stepsPerSec : 0,
      },
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
    this.flightController.reset(
      this.currentPlanet.id,
      this.launchComplex.getPadDeckY(),
      mission,
      this.currentVehicle.id,
      this.currentSite.id
    );
    this.flightController.setControlMode("ai_ppo");
    this.flightController.setFaultConfig(this.faultConfig);
    applyRLSpawnToController(
      this.flightController,
      this.currentPlanet.id,
      mission,
      this.aiMode === "live_train" ? this.aiRandomizeSpawn : false,
      this.aiPrng
    );
    this.flightLog.length = 0;
    this.resetVehicleToFlightState();
    this.cameraDirector.reLockOnVehicle(
      this.buildCameraContext(this.flightController.getTelemetry())
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
    const maxSteps = nextTel.missionMode === "landing" ? 700 : 500;
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
    const camState = this.cameraDirector.getState();
    this.onTelemetry?.({
      fps: this.currentFps,
      rendererName: this.rendererName,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      canvasNonBlackPct: this.canvasNonBlackPct,
      canvasMeanRgb: this.canvasMeanRgb,
      quality: this.quality,
      autoQualityEnabled: this.autoQualityGuard.isEnabled(),
      launchSiteId: this.currentSite.id,
      vehicleId: this.currentVehicle.id,
      cameraPreset: camState.mode,
      trackTarget: camState.trackTarget,
      autoDirector: camState.autoDirector,
      padRangeHint: camState.padRangeHint,
      audioMuted: this.soundEngine.isMuted(),
      orbitPathEnabled: this.orbitVisualizer.isEnabled(),
      gibsTilesLoaded: this.earthTileOverlay.isLoaded(),
      orbitalObjects: this.orbitalObjects.getSnapshots(),
      selectedOrbitalId: this.orbitalObjects.getSelectedId(),
      inspectedOrbitalId: this.orbitalObjects.getInspectedId(),
      orbitalProvenance: this.orbitalObjects.getProvenance(),
      orbitalVisibility: this.orbitalObjects.getVisibilityOptions(),
      flight: this.flightController.getTelemetry(),
      ai: this.getAIStatus(),
    });
  }

  probeCanvasNonBlackNow(): { pct: number; meanRgb: [number, number, number] } {
    try {
      this.renderCurrentCameraFrameNow();
      const gl = this.renderer.getContext();
      const bufW = gl.drawingBufferWidth;
      const bufH = gl.drawingBufferHeight;
      if (bufW < 32 || bufH < 32) {
        return { pct: this.canvasNonBlackPct, meanRgb: this.canvasMeanRgb };
      }
      const patchSize = 16;
      const centers = [
        [0.5, 0.5],
        [0.3, 0.35],
        [0.7, 0.35],
        [0.3, 0.65],
        [0.7, 0.65],
      ];
      const pixels = new Uint8Array(patchSize * patchSize * 4);
      let nonBlack = 0;
      let total = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      for (const [fx, fy] of centers) {
        const x = Math.max(0, Math.min(bufW - patchSize, Math.floor(bufW * fx - patchSize / 2)));
        const y = Math.max(0, Math.min(bufH - patchSize, Math.floor(bufH * fy - patchSize / 2)));
        gl.readPixels(x, y, patchSize, patchSize, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          rSum += r;
          gSum += g;
          bSum += b;
          total += 1;
          if (r > 10 || g > 12 || b > 14) {
            nonBlack += 1;
          }
        }
      }
      return {
        pct: total > 0 ? Number(((nonBlack / total) * 100).toFixed(1)) : 0,
        meanRgb:
          total > 0
            ? [
              Number((rSum / total).toFixed(1)),
              Number((gSum / total).toFixed(1)),
              Number((bSum / total).toFixed(1)),
            ]
            : [0, 0, 0],
      };
    } catch {
      return { pct: this.canvasNonBlackPct, meanRgb: this.canvasMeanRgb };
    }
  }

  private renderCurrentCameraFrameNow(): void {
    const tel = this.flightController.getTelemetry();
    const camAltM = this.getCurrentCameraAltitudeM();
    const R = this.currentPlanet.scale.simRadiusM;
    const atmoTopM = this.currentPlanet.scale.atmosphereTopM;
    const origin = this.cameraDirector.getRenderOrigin();

    this.syncVisualsFromTelemetry(tel);
    this.syncFloatingOriginTransforms(tel, camAltM);
    this.atmosphereDome.update(0, this.camera.position, camAltM, atmoTopM);
    this.planetGlobe.update(0, camAltM);
    this.earthTileOverlay.update(camAltM);
    this.terrainSystem.setVisibilityForCameraAltitude(camAltM, R);
    this.coastalEnvironment.update(0, this.elapsedSec, camAltM, tel);
    this.orbitVisualizer.update(tel, this.camera, camAltM, origin);
    this.orbitalObjects.update(
      0,
      this.elapsedSec,
      tel.orbital.timeWarp,
      false,
      this.camera,
      camAltM,
      this.cameraDirector.getMode(),
      origin
    );
    this.camera.updateMatrixWorld();
    this.postProcessing.render(this.scene, this.camera);
  }

  private sampleRenderedPixelsOnce(): void {
    if (this.pixelProbeDone) {
      return;
    }
    try {
      const gl = this.renderer.getContext();
      const bufW = gl.drawingBufferWidth;
      const bufH = gl.drawingBufferHeight;
      if (bufW < 32 || bufH < 32) {
        return;
      }
      const patchSize = 32;
      const x = Math.max(0, Math.floor((bufW - patchSize) / 2));
      const y = Math.max(0, Math.floor((bufH - patchSize) / 2));
      const pixels = new Uint8Array(patchSize * patchSize * 4);
      gl.readPixels(x, y, patchSize, patchSize, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      const total = patchSize * patchSize;
      let nonBlack = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        rSum += r;
        gSum += g;
        bSum += b;
        if (r > 12 || g > 14 || b > 20) {
          nonBlack += 1;
        }
      }
      this.canvasNonBlackPct = Number(((nonBlack / total) * 100).toFixed(1));
      this.canvasMeanRgb = [
        Number((rSum / total).toFixed(1)),
        Number((gSum / total).toFixed(1)),
        Number((bSum / total).toFixed(1)),
      ];
      if (nonBlack > 0 || this.renderedFrames >= 45) {
        this.pixelProbeDone = true;
      }
      this.emitTelemetryNow();
    } catch {
      this.pixelProbeDone = true;
    }
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
    const postTel = this.flightController.getTelemetry();
    this.syncVisualsFromTelemetry(postTel);
    this.cameraDirector.reLockOnVehicle(this.buildCameraContext(postTel));
    this.syncFloatingOriginTransforms(postTel, this.getCurrentCameraAltitudeM());
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
      tel.missionMode,
      this.currentVehicle.id,
      this.currentSite.id
    );
    this.flightController.setFaultConfig(this.faultConfig);
    this.resetVehicleToFlightState();
    const postTel = this.flightController.getTelemetry();
    this.cameraDirector.reLockOnVehicle(this.buildCameraContext(postTel));
    this.syncFloatingOriginTransforms(postTel, this.getCurrentCameraAltitudeM());
  }

  private resetVehicleToFlightState(): void {
    const tel = this.flightController.getTelemetry();
    this.prevStageSeparated = false;
    this.prevSideSeparated = false;
    this.vehicleIntact = true;
    this.lastCrashId = -1;
    this.lastBoosterCrashId = -1;
    this.vehicle.setIntactVisible(true);
    this.vehicle.resetStack(tel.missionMode);
    this.propulsionEffects.reset();
    this.explosionSystem.reset();
    this.orbitVisualizer.resetTrail();
    this.syncVisualsFromTelemetry(tel);
  }

  setFocusMode(focus: CameraFocusMode): void {
    const tel = this.flightController.getTelemetry();
    this.syncVisualsFromTelemetry(tel);
    this.cameraDirector.setFocusMode(focus, this.buildCameraContext(tel));
    this.syncFloatingOriginTransforms(tel, this.getCurrentCameraAltitudeM());
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
    this.orbitalObjects.setInspectedId(null);
    const tel = this.flightController.getTelemetry();
    this.syncVisualsFromTelemetry(tel);
    this.cameraDirector.reLockOnVehicle(this.buildCameraContext(tel));
    this.syncFloatingOriginTransforms(tel, this.getCurrentCameraAltitudeM());
    this.emitTelemetryNow();
  }

  private readonly handleResize = (): void => {
    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    const pr = Math.min(window.devicePixelRatio || 1, this.getMaxPixelRatio(this.quality));
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

  private syncFloatingOriginTransforms(tel: FlightTelemetry, camAltM: number): void {
    const origin = this.cameraDirector.getRenderOrigin();
    this.planetGlobe.setRenderOrigin(origin);
    this.terrainSystem.group.position.set(-origin.x, -origin.y, -origin.z);
    this.coastalEnvironment.group.position.set(-origin.x, -origin.y, -origin.z);
    this.earthTileOverlay.group.position.set(-origin.x, -origin.y, -origin.z);
    this.launchComplex.group.position.set(-origin.x, -origin.y, -origin.z);
    this.launchComplex.setVisibilityForCameraAltitude(camAltM);
    this.propulsionEffects.worldGroup.position.set(-origin.x, -origin.y, -origin.z);
    this.explosionSystem.group.position.set(-origin.x, -origin.y, -origin.z);

    this.vehicle.root.position.set(
      tel.position.x - origin.x,
      tel.position.y - origin.y,
      tel.position.z - origin.z
    );
    if (tel.sideBoostersSeparated && tel.missionMode === "launch" && tel.sideBoosters.active) {
      this.vehicle.detachedLeftSideRoot.position.set(
        tel.sideBoosters.leftPos.x - origin.x,
        tel.sideBoosters.leftPos.y - origin.y,
        tel.sideBoosters.leftPos.z - origin.z
      );
      this.vehicle.detachedRightSideRoot.position.set(
        tel.sideBoosters.rightPos.x - origin.x,
        tel.sideBoosters.rightPos.y - origin.y,
        tel.sideBoosters.rightPos.z - origin.z
      );
    }
    if (tel.stageSeparated && tel.missionMode === "launch") {
      this.vehicle.detachedBoosterRoot.position.set(
        tel.booster.position.x - origin.x,
        tel.booster.position.y - origin.y,
        tel.booster.position.z - origin.z
      );
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

    this.cameraDirector.update(dt, this.buildCameraContext(tel));
    const origin = this.cameraDirector.getRenderOrigin();
    const camWorld = this.cameraDirector.getCameraWorldPosition();
    const R = this.currentPlanet.scale.simRadiusM;
    const atmoTopM = this.currentPlanet.scale.atmosphereTopM;
    const camAltM = Math.max(0, Math.hypot(camWorld.x, camWorld.y + R, camWorld.z) - R);

    this.syncFloatingOriginTransforms(tel, camAltM);

    const camDist = Math.hypot(
      camWorld.x - tel.position.x,
      camWorld.y - tel.position.y,
      camWorld.z - tel.position.z
    );
    this.soundEngine.update(
      tel,
      camDist,
      this.currentPlanet.physics.surfacePressureBar,
      this.vehicleIntact
    );

    // Attenuate atmospheric ground fog cleanly above 14 km into dark stratosphere
    if (this.scene.fog instanceof THREE.FogExp2) {
      const baseFog = this.currentPlanet.atmosphere.fogDensity;
      const fogT = atmoTopM > 0 ? 1 - smoothstep(2000, 14000, camAltM) : 0;
      this.scene.fog.density = baseFog * fogT * fogT;
    }

    this.sunLight.castShadow = camAltM < 4500;
    this.sunLight.target.position.set(
      tel.position.x - origin.x,
      tel.position.y - origin.y,
      tel.position.z - origin.z
    );
    this.sunLight.target.updateMatrixWorld();
    this.sunLight.position
      .copy(this.sunDirVec)
      .multiplyScalar(camAltM < 4500 ? 320 : R * 2)
      .add(this.sunLight.target.position);

    // Apply transient camera shake around CameraDirector position, then restore cleanly
    this.explosionSystem.getCameraShakeOffset(this.shakeOffset);
    this.camera.position.add(this.shakeOffset);
    this.camera.updateMatrixWorld();

    // Project active nozzle exit to screen UV for Schlieren heat distortion pass
    const activeThr = Math.max(tel.boosterThrottle, tel.shipThrottle);
    if (this.vehicleIntact && activeThr > 0.05) {
      this.projVec.copy(this.vehicle.root.position).project(this.camera);
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

    this.atmosphereDome.update(dt, this.camera.position, camAltM, atmoTopM);
    this.planetGlobe.update(dt, camAltM);
    this.earthTileOverlay.update(camAltM);
    this.terrainSystem.setVisibilityForCameraAltitude(camAltM, R);
    this.coastalEnvironment.update(dt, this.elapsedSec, camAltM, tel);
    this.orbitVisualizer.update(tel, this.camera, camAltM, origin);
    this.orbitalObjects.update(
      dt,
      this.elapsedSec,
      tel.orbital.timeWarp,
      tel.running && !tel.paused,
      this.camera,
      camAltM,
      this.cameraDirector.getMode(),
      origin
    );
    this.postProcessing.render(this.scene, this.camera);
    this.renderedFrames += 1;
    if (!this.pixelProbeDone && this.renderedFrames >= 8) {
      this.sampleRenderedPixelsOnce();
    }
    this.camera.position.sub(this.shakeOffset);

    this.fpsAccumTime += dt;
    this.fpsFrameCount += 1;
    if (this.fpsAccumTime >= 0.25) {
      const sampleDt = this.fpsAccumTime;
      this.currentFps = Math.round(this.fpsFrameCount / sampleDt);
      this.fpsAccumTime = 0;
      this.fpsFrameCount = 0;
      const nextQual = this.autoQualityGuard.sample(
        this.currentFps,
        sampleDt,
        this.quality
      );
      if (nextQual && nextQual !== this.quality) {
        const prevQual = this.quality;
        this.setQualityPreset(nextQual);
        this.onAutoQualityStepDown?.(prevQual, nextQual, this.currentFps);
      }
      this.emitTelemetryNow();
    }
  };

  dispose(): void {
    this.disposed = true;
    this.workerClient.dispose();
    this.soundEngine.dispose();
    window.cancelAnimationFrame(this.rafId);
    this.canvas.removeEventListener("pointerdown", this.handleCanvasPointerDown);
    this.canvas.removeEventListener("pointerup", this.handleCanvasPointerUp);
    window.removeEventListener("resize", this.handleResize);

    this.cameraDirector.dispose();
    this.atmosphereDome.dispose();
    this.planetGlobe.dispose();
    this.earthTileOverlay.dispose();
    this.orbitVisualizer.dispose();
    this.orbitalObjects.dispose();
    this.terrainSystem.dispose();
    this.coastalEnvironment.dispose();
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
