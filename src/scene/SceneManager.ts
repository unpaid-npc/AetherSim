import gsap from "gsap";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { type PlanetConfig, type PlanetId, getPlanetConfig } from "../config/planets";
import { ExplosionSystem } from "../effects/ExplosionSystem";
import { PropulsionEffects, type QualityPreset } from "../effects/PropulsionEffects";
import { AtmosphereDome } from "../shaders/atmosphereShader";
import {
  type ControlMode,
  FlightController,
  type FlightTelemetry,
  type ManualInputState,
  type MissionMode,
} from "../sim/FlightController";
import { LaunchComplex } from "./LaunchComplex";
import { PostProcessingPipeline } from "./PostProcessing";
import { disposeVehicleTextureCache } from "./ProceduralTextures";
import { StarshipVehicle } from "./StarshipVehicle";
import { TerrainSystem } from "./TerrainSystem";

export type CameraFocusMode = "rocket" | "base";

export interface SceneTelemetry {
  fps: number;
  rendererName: string;
  drawCalls: number;
  triangles: number;
  quality: QualityPreset;
  flight: FlightTelemetry;
}

/**
 * Coordinates WebGL rendering, planet switching, lighting, PMREM reflections,
 * LaunchComplex, StarshipVehicle, PropulsionEffects, ExplosionSystem, and PostProcessing.
 */
export class SceneManager {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;

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
  private focusMode: CameraFocusMode = "rocket";
  private lastTrackedRocketPos = new THREE.Vector3();
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
    onTelemetry?: (telemetry: SceneTelemetry) => void
  ) {
    this.canvas = canvas;
    this.onTelemetry = onTelemetry;
    this.currentPlanet = getPlanetConfig(initialPlanetId);

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

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 18;
    this.controls.maxDistance = 2400;
    this.controls.maxPolarAngle = Math.PI * 0.495;

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
    this.snapCameraToCurrentSubject();

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

  private snapCameraToCurrentSubject(): void {
    gsap.killTweensOf(this.camera.position);
    gsap.killTweensOf(this.controls.target);

    const tel = this.flightController.getTelemetry();
    const target = this.getTargetAnchor(tel);
    const offset =
      this.focusMode === "base"
        ? new THREE.Vector3(110, 52, 125)
        : tel.missionMode === "launch"
          ? new THREE.Vector3(118, 46, 138)
          : new THREE.Vector3(62, 24, 72);

    this.controls.target.copy(target);
    this.camera.position.copy(target).add(offset);
    this.controls.update();
    this.lastTrackedRocketPos.set(tel.position.x, tel.position.y, tel.position.z);
  }

  private getTargetAnchor(tel: FlightTelemetry): THREE.Vector3 {
    if (this.focusMode === "base") {
      return this.launchComplex.getBaseFocusTarget();
    }
    const yOffset = tel.missionMode === "launch" && !tel.stageSeparated ? 58 : 22;
    return new THREE.Vector3(tel.position.x, tel.position.y + yOffset, tel.position.z);
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

    this.resetMission();
    return next;
  }

  setMissionMode(mode: MissionMode): void {
    this.flightController.setMissionMode(mode);
    this.resetVehicleToFlightState();
    this.snapCameraToCurrentSubject();
  }

  setControlMode(mode: ControlMode): void {
    this.flightController.setControlMode(mode);
  }

  toggleSas(): boolean {
    return this.flightController.toggleSas();
  }

  startMission(): void {
    this.flightController.startMission();
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
    const mode = this.flightController.getTelemetry().missionMode;
    this.flightController.reset(this.currentPlanet.id, this.launchComplex.getPadDeckY(), mode);
    this.resetVehicleToFlightState();
    this.snapCameraToCurrentSubject();
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
    this.focusMode = focus;
    this.resetCamera();
  }

  getFocusMode(): CameraFocusMode {
    return this.focusMode;
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
    gsap.killTweensOf(this.camera.position);
    gsap.killTweensOf(this.controls.target);

    const tel = this.flightController.getTelemetry();
    const target = this.getTargetAnchor(tel);
    const offset =
      this.focusMode === "base"
        ? new THREE.Vector3(110, 52, 125)
        : tel.missionMode === "launch"
          ? new THREE.Vector3(118, 46, 138)
          : new THREE.Vector3(62, 24, 72);
    const camPos = target.clone().add(offset);

    gsap.to(this.camera.position, {
      x: camPos.x,
      y: camPos.y,
      z: camPos.z,
      duration: 0.85,
      ease: "power2.out",
    });
    gsap.to(this.controls.target, {
      x: target.x,
      y: target.y,
      z: target.z,
      duration: 0.85,
      ease: "power2.out",
      onUpdate: () => this.controls.update(),
    });
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

  private readonly animate = (): void => {
    if (this.disposed) {
      return;
    }
    this.rafId = window.requestAnimationFrame(this.animate);

    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.0001, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;
    this.elapsedSec += dt;

    const tel = this.flightController.update(dt, this.manualInput);
    this.manualInput.throttleSet = null;

    this.syncVisualsFromTelemetry(tel);
    this.propulsionEffects.update(dt, tel, this.vehicleIntact);
    this.explosionSystem.update(dt);
    this.launchComplex.update(this.elapsedSec);

    if (this.focusMode === "rocket") {
      const dx = tel.position.x - this.lastTrackedRocketPos.x;
      const dy = tel.position.y - this.lastTrackedRocketPos.y;
      const dz = tel.position.z - this.lastTrackedRocketPos.z;
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        this.camera.position.x += dx;
        this.camera.position.y += dy;
        this.camera.position.z += dz;
        this.controls.target.x += dx;
        this.controls.target.y += dy;
        this.controls.target.z += dz;
      }
      this.lastTrackedRocketPos.set(tel.position.x, tel.position.y, tel.position.z);
    }

    this.controls.update();

    // Attenuate atmospheric ground fog gracefully as vehicle climbs toward space
    if (this.scene.fog instanceof THREE.FogExp2) {
      const baseFog = this.currentPlanet.atmosphere.fogDensity;
      const altFade = Math.exp(-Math.max(0, this.camera.position.y) / 9500);
      this.scene.fog.density = baseFog * altFade;
    }

    // Apply transient camera shake around controls position, then restore cleanly
    this.explosionSystem.getCameraShakeOffset(this.shakeOffset);
    this.camera.position.add(this.shakeOffset);
    this.camera.updateMatrixWorld();

    // Project active nozzle exit to screen UV for Schlieren heat distortion pass
    const activeThr = Math.max(tel.boosterThrottle, tel.shipThrottle);
    if (this.vehicleIntact && activeThr > 0.05) {
      this.projVec.set(tel.position.x, tel.position.y, tel.position.z).project(this.camera);
      const uvX = this.projVec.x * 0.5 + 0.5;
      const uvY = this.projVec.y * 0.5 + 0.5;
      const camDist = this.camera.position.distanceTo(
        new THREE.Vector3(tel.position.x, tel.position.y, tel.position.z)
      );
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
      this.onTelemetry?.({
        fps: this.currentFps,
        rendererName: this.rendererName,
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        quality: this.quality,
        flight: tel,
      });
    }
  };

  dispose(): void {
    this.disposed = true;
    window.cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.handleResize);
    gsap.killTweensOf(this.camera.position);
    gsap.killTweensOf(this.controls.target);

    this.controls.dispose();
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
