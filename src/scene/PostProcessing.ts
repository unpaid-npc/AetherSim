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
        // Elongated heat plume region below the projected nozzle exit
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

/** Manages UnrealBloom + Schlieren heat distortion post-processing scaled by quality preset. */
export class PostProcessingPipeline {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly schlierenPass: ShaderPass;
  private readonly outputPass: OutputPass;

  private quality: QualityPreset = "med";

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    width: number,
    height: number
  ) {
    this.renderer = renderer;
    this.composer = new EffectComposer(renderer);

    this.renderPass = new RenderPass(scene, camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(width, height),
      0.42,
      0.55,
      0.92
    );
    this.schlierenPass = new ShaderPass(SchlierenHeatShader);
    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.schlierenPass);
    this.composer.addPass(this.outputPass);
    this.setQuality("med");
  }

  setQuality(quality: QualityPreset): void {
    this.quality = quality;
    if (quality === "med") {
      this.bloomPass.strength = 0.42;
      this.bloomPass.radius = 0.55;
      this.bloomPass.threshold = 0.92;
      this.schlierenPass.enabled = true;
    } else if (quality === "high") {
      this.bloomPass.strength = 0.52;
      this.bloomPass.radius = 0.62;
      this.bloomPass.threshold = 0.88;
      this.schlierenPass.enabled = true;
    }
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.bloomPass.resolution.set(width, height);
  }

  setSchlierenState(elapsedSec: number, nozzleUvX: number, nozzleUvY: number, intensity: number): void {
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
  }
}
