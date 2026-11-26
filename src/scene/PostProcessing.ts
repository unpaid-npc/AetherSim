import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type { QualityPreset } from "../effects/PropulsionEffects";

const SchlierenHeatShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uNozzleUv: { value: new THREE.Vector2(0.5, 0.5) },
    uIntensity: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uNozzleUv;
    uniform float uIntensity;
    varying vec2 vUv;

    void main() {
      vec2 uv = vUv;
      if (uIntensity > 0.005) {
        vec2 delta = uv - uNozzleUv;
        float belowMask = smoothstep(0.03, -0.26, delta.y);
        float coneWidth = 0.035 + max(0.0, -delta.y) * 0.28;
        float horizMask = 1.0 - smoothstep(coneWidth * 0.35, coneWidth, abs(delta.x));
        float distFade = 1.0 - smoothstep(0.04, 0.36, length(delta));
        float mask = belowMask * horizMask * distFade * uIntensity;

        float waveX = sin(uv.y * 140.0 + uTime * 34.0) * cos(uv.x * 80.0 - uTime * 21.0);
        float waveY = cos(uv.y * 110.0 + uTime * 28.0);
        uv += vec2(waveX, waveY * 0.6) * (0.0042 * mask);
      }
      gl_FragColor = texture2D(tDiffuse, clamp(uv, 0.001, 0.999));
    }
  `,
};

/** Manages UnrealBloom + Schlieren heat distortion with quality-scaled WebGL2 RT & half-res MED bloom. */
export class PostProcessingPipeline {
  private readonly renderer: THREE.WebGLRenderer;
  private renderTarget: THREE.WebGLRenderTarget;
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly schlierenPass: ShaderPass;
  private readonly outputPass: OutputPass;

  private quality: QualityPreset = "med";
  private width: number;
  private height: number;
  private pixelRatio = 1;
  private currentSamples = 0;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number
  ) {
    this.renderer = renderer;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderTarget = new THREE.WebGLRenderTarget(
      this.width,
      this.height,
      {
        type: THREE.HalfFloatType,
        samples: 0,
      }
    );
    this.composer = new EffectComposer(renderer, this.renderTarget);

    this.renderPass = new RenderPass(scene, camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(
        Math.max(1, Math.floor(this.width * 0.5)),
        Math.max(1, Math.floor(this.height * 0.5))
      ),
      0.34,
      0.45,
      1.2
    );
    this.schlierenPass = new ShaderPass(SchlierenHeatShader);
    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.schlierenPass);
    this.composer.addPass(this.outputPass);
    this.setQuality("med");
  }

  private ensureTargetSamples(samples: number): void {
    if (this.currentSamples === samples) {
      return;
    }
    this.currentSamples = samples;
    const rtW = Math.max(1, Math.floor(this.width * this.pixelRatio));
    const rtH = Math.max(1, Math.floor(this.height * this.pixelRatio));
    const nextTarget = new THREE.WebGLRenderTarget(rtW, rtH, {
      type: THREE.HalfFloatType,
      samples,
    });
    this.renderTarget = nextTarget;
    // EffectComposer.reset() disposes previous renderTarget1/renderTarget2 internally
    this.composer.reset(nextTarget);
  }

  private applyBloomResolution(): void {
    const scale = this.quality === "high" ? 1.0 : 0.5;
    this.bloomPass.resolution.set(
      Math.max(1, Math.floor(this.width * scale)),
      Math.max(1, Math.floor(this.height * scale))
    );
  }

  setQuality(quality: QualityPreset): void {
    this.quality = quality;
    if (quality === "med") {
      this.ensureTargetSamples(0);
      this.bloomPass.strength = 0.34;
      this.bloomPass.radius = 0.45;
      this.bloomPass.threshold = 1.2;
      this.schlierenPass.enabled = true;
      this.applyBloomResolution();
    } else if (quality === "high") {
      this.ensureTargetSamples(4);
      this.bloomPass.strength = 0.44;
      this.bloomPass.radius = 0.55;
      this.bloomPass.threshold = 1.15;
      this.schlierenPass.enabled = true;
      this.applyBloomResolution();
    }
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = pixelRatio;
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(this.width, this.height);
    this.applyBloomResolution();
  }

  setSchlierenState(elapsedSec: number, nozzleUvX: number, nozzleUvY: number, intensity: number): void {
    const active = this.quality !== "low" && intensity > 0.005;
    this.schlierenPass.enabled = active;
    if (!active) {
      return;
    }
    this.schlierenPass.uniforms.uTime.value = elapsedSec;
    (this.schlierenPass.uniforms.uNozzleUv.value as THREE.Vector2).set(nozzleUvX, nozzleUvY);
    this.schlierenPass.uniforms.uIntensity.value = intensity;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    if (this.quality === "low") {
      this.renderer.render(scene, camera);
      return;
    }
    this.composer.render();
  }

  dispose(): void {
    this.bloomPass.dispose();
    this.schlierenPass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
    this.renderTarget.dispose();
  }
}
