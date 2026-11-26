import * as THREE from "three";
import type { QualityPreset } from "../effects/PropulsionEffects";

export interface ShadowCascadeSpec {
  readonly radiusM: number;
  readonly mapSize: number;
  readonly pullBackM: number;
  readonly nearM: number;
  readonly farM: number;
  readonly bias: number;
  readonly normalBias: number;
}

export interface ShadowQualityConfig {
  readonly quality: QualityPreset;
  readonly cascadeCount: number;
  readonly maxShadowAltitudeM: number;
  readonly cascades: readonly ShadowCascadeSpec[];
}

export const SHADOW_DISABLE_ALTITUDE_M = 15_000;

const QUALITY_CASCADE_SPECS: Record<QualityPreset, readonly ShadowCascadeSpec[]> = {
  low: [
    {
      radiusM: 260,
      mapSize: 1024,
      pullBackM: 750,
      nearM: 10,
      farM: 1800,
      bias: -0.00045,
      normalBias: 0.14,
    },
  ],
  med: [
    {
      radiusM: 180,
      mapSize: 2048,
      pullBackM: 650,
      nearM: 10,
      farM: 1500,
      bias: -0.0003,
      normalBias: 0.08,
    },
    {
      radiusM: 1400,
      mapSize: 1024,
      pullBackM: 2400,
      nearM: 20,
      farM: 5400,
      bias: -0.00065,
      normalBias: 0.55,
    },
  ],
  high: [
    {
      radiusM: 180,
      mapSize: 2048,
      pullBackM: 650,
      nearM: 10,
      farM: 1500,
      bias: -0.0003,
      normalBias: 0.08,
    },
    {
      radiusM: 1400,
      mapSize: 2048,
      pullBackM: 2400,
      nearM: 20,
      farM: 5400,
      bias: -0.00055,
      normalBias: 0.42,
    },
    {
      radiusM: 6000,
      mapSize: 1024,
      pullBackM: 8000,
      nearM: 50,
      farM: 18000,
      bias: -0.0012,
      normalBias: 1.65,
    },
  ],
};

export function getShadowQualityConfig(quality: QualityPreset): ShadowQualityConfig {
  const cascades = QUALITY_CASCADE_SPECS[quality];
  return {
    quality,
    cascadeCount: cascades.length,
    maxShadowAltitudeM: SHADOW_DISABLE_ALTITUDE_M,
    cascades,
  };
}

let csmChunkPatched = false;

const DIR_LIGHT_BLOCK_REGEX =
  /#if\s*\(\s*NUM_DIR_LIGHTS\s*>\s*0\s*\)\s*&&\s*defined\(\s*RE_Direct\s*\)[\s\S]*?#pragma\s+unroll_loop_end\s*#endif/;

const PATCHED_DIR_LIGHT_CSM = `#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif

	#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS >= 2 )
		// AetherSim multi-cascade directional sun shadows (log-depth & custom onBeforeCompile safe)
		directionalLight = directionalLights[ 0 ];
		getDirectionalLightInfo( directionalLight, directLight );

		if ( directLight.visible && receiveShadow ) {
			float csmShadowAccum = 0.0;
			float csmCoverage = 0.0;

			#pragma unroll_loop_start
			for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
				if ( csmCoverage < 0.999 ) {
					vec4 csmCoord = vDirectionalShadowCoord[ i ];
					vec3 csmUv = csmCoord.xyz / csmCoord.w;
					float edgeX = min( csmUv.x, 1.0 - csmUv.x );
					float edgeY = min( csmUv.y, 1.0 - csmUv.y );
					float edgeZ = min( csmUv.z, 1.0 - csmUv.z );
					float inBox = step( 0.002, edgeZ ) * smoothstep( 0.015, 0.085, min( edgeX, edgeY ) );
					if ( inBox > 0.001 ) {
						directionalLightShadow = directionalLightShadows[ i ];
						float sVal = getShadow(
							directionalShadowMap[ i ],
							directionalLightShadow.shadowMapSize,
							directionalLightShadow.shadowIntensity,
							directionalLightShadow.shadowBias,
							directionalLightShadow.shadowRadius,
							csmCoord
						);
						float w = inBox * ( 1.0 - csmCoverage );
						csmShadowAccum += sVal * w;
						csmCoverage += w;
					}
				}
			}
			#pragma unroll_loop_end

			directLight.color *= ( csmShadowAccum + ( 1.0 - csmCoverage ) );
		}

		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	#else
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

			directionalLight = directionalLights[ i ];

			getDirectionalLightInfo( directionalLight, directLight );

			#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
			directionalLightShadow = directionalLightShadows[ i ];
			directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
			#endif

			RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

		}
		#pragma unroll_loop_end
	#endif

#endif`;

/**
 * Installs an idempotent, zero-override multi-cascade directional shadow patch on
 * `THREE.ShaderChunk.lights_fragment_begin`. Works seamlessly with `logarithmicDepthBuffer: true`
 * and preserves every custom `material.onBeforeCompile` hook (such as `TerrainSystem`).
 */
export function ensureCascadedShadowShaderChunk(): boolean {
  if (csmChunkPatched) {
    return true;
  }
  const current = THREE.ShaderChunk.lights_fragment_begin;
  if (current.includes("AetherSim multi-cascade directional sun shadows")) {
    csmChunkPatched = true;
    return true;
  }
  if (DIR_LIGHT_BLOCK_REGEX.test(current)) {
    THREE.ShaderChunk.lights_fragment_begin = current.replace(
      DIR_LIGHT_BLOCK_REGEX,
      PATCHED_DIR_LIGHT_CSM
    );
    csmChunkPatched = true;
    return true;
  }
  return false;
}

/**
 * World-space texel-snapped Cascaded Shadow Map (CSM) directional sun rig.
 * - `LOW`: 1 texel-snapped 1024x1024 directional shadow map (260 m radius).
 * - `MED`: 2 cascades (0–180 m @ 2048px pad/rocket detail, 180–1,400 m @ 1024px facilities).
 * - `HIGH`: 3 cascades (0–180 m @ 2048px, 180–1,400 m @ 2048px, 1,400–6,000 m @ 1024px relief).
 * - Auto-disables all shadow casting cleanly above 15 km camera altitude for zero orbital cost.
 */
export class ShadowSystem {
  public readonly lights: readonly THREE.DirectionalLight[];

  private readonly scene: THREE.Scene;
  private quality: QualityPreset;
  private shadowsEnabled = true;
  private sunIntensity = 3.0;
  private readonly sunDir = new THREE.Vector3(0.6, 0.4, -0.7).normalize();
  private readonly lightRight = new THREE.Vector3(1, 0, 0);
  private readonly lightUp = new THREE.Vector3(0, 1, 0);
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly fallbackUp = new THREE.Vector3(0, 0, 1);
  private readonly snappedWorldScratch = new THREE.Vector3();

  constructor(scene: THREE.Scene, initialQuality: QualityPreset = "med") {
    this.scene = scene;
    this.quality = initialQuality;
    ensureCascadedShadowShaderChunk();

    // Always create 3 cascade DirectionalLights; cascades 1 & 2 carry intensity = 0 so
    // non-CSM materials or high-altitude states can NEVER receive duplicate sunlight.
    const created: THREE.DirectionalLight[] = [];
    for (let i = 0; i < 3; i++) {
      const light = new THREE.DirectionalLight("#ffffff", i === 0 ? this.sunIntensity : 0);
      light.name = `AetherSunCascade_${i}`;
      light.castShadow = false;
      this.scene.add(light, light.target);
      created.push(light);
    }
    this.lights = created;
    this.recomputeLightBasis();
    this.applyQualitySpecs(initialQuality);
  }

  private recomputeLightBasis(): void {
    const refUp =
      Math.abs(this.sunDir.dot(this.worldUp)) > 0.96 ? this.fallbackUp : this.worldUp;
    this.lightRight.crossVectors(refUp, this.sunDir).normalize();
    this.lightUp.crossVectors(this.sunDir, this.lightRight).normalize();
  }

  private applyQualitySpecs(preset: QualityPreset): void {
    const specs = QUALITY_CASCADE_SPECS[preset];
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      const spec = specs[i];
      if (spec) {
        light.visible = i === 0 ? true : this.shadowsEnabled;
        light.intensity = i === 0 ? this.sunIntensity : 0;
        light.castShadow = this.shadowsEnabled;

        const cam = light.shadow.camera;
        cam.left = -spec.radiusM;
        cam.right = spec.radiusM;
        cam.top = spec.radiusM;
        cam.bottom = -spec.radiusM;
        cam.near = spec.nearM;
        cam.far = spec.farM;
        cam.updateProjectionMatrix();

        light.shadow.bias = spec.bias;
        light.shadow.normalBias = spec.normalBias;
        light.shadow.radius = i === 0 ? 1.5 : 1.0;

        if (light.shadow.mapSize.x !== spec.mapSize || light.shadow.mapSize.y !== spec.mapSize) {
          light.shadow.mapSize.set(spec.mapSize, spec.mapSize);
          if (light.shadow.map) {
            light.shadow.map.dispose();
            light.shadow.map = null;
          }
        }
      } else {
        light.visible = false;
        light.intensity = 0;
        light.castShadow = false;
        if (light.shadow.map) {
          light.shadow.map.dispose();
          light.shadow.map = null;
        }
      }
    }
  }

  setPlanetLighting(
    sunDirection: readonly [number, number, number] | THREE.Vector3,
    sunColor: string | number | THREE.Color,
    sunIntensity: number
  ): void {
    if (sunDirection instanceof THREE.Vector3) {
      this.sunDir.copy(sunDirection).normalize();
    } else {
      this.sunDir.set(sunDirection[0], sunDirection[1], sunDirection[2]).normalize();
    }
    this.recomputeLightBasis();
    this.sunIntensity = sunIntensity;

    const primary = this.lights[0];
    primary.color.set(sunColor);
    primary.intensity = sunIntensity;
    for (let i = 1; i < this.lights.length; i++) {
      this.lights[i].color.set(sunColor);
      this.lights[i].intensity = 0;
    }
  }

  setQuality(preset: QualityPreset): void {
    this.quality = preset;
    this.applyQualitySpecs(preset);
  }

  getQuality(): QualityPreset {
    return this.quality;
  }

  getConfig(): ShadowQualityConfig {
    return getShadowQualityConfig(this.quality);
  }

  isShadowsEnabled(): boolean {
    return this.shadowsEnabled;
  }

  getActiveCascadeCount(): number {
    if (!this.shadowsEnabled) {
      return 0;
    }
    return QUALITY_CASCADE_SPECS[this.quality].length;
  }

  /**
   * Updates world-space texel-snapped shadow frustums around `anchorWorldPos` and transforms
   * into floating-origin render space (`world - renderOrigin`) so camera motion never causes
   * shadow edge shimmer. Auto-disables all cascades above `SHADOW_DISABLE_ALTITUDE_M` (15 km).
   */
  update(
    anchorWorldPos: { x: number; y: number; z: number },
    renderOrigin: { x: number; y: number; z: number },
    camAltM: number,
    planetRadiusM = 6_371_000
  ): void {
    const shouldCast = camAltM <= SHADOW_DISABLE_ALTITUDE_M;
    const specs = QUALITY_CASCADE_SPECS[this.quality];

    if (shouldCast !== this.shadowsEnabled) {
      this.shadowsEnabled = shouldCast;
      for (let i = 0; i < this.lights.length; i++) {
        const activeInTier = i < specs.length;
        const light = this.lights[i];
        light.castShadow = shouldCast && activeInTier;
        // Keep primary sun visible everywhere for orbital planet lighting; hide aux cascades in space
        light.visible = i === 0 ? true : shouldCast && activeInTier;
        light.intensity = i === 0 ? this.sunIntensity : 0;
      }
    }

    if (!shouldCast) {
      // Orbital lighting: keep primary directional light pointed at vehicle from distant sun direction
      const primary = this.lights[0];
      const tx = anchorWorldPos.x - renderOrigin.x;
      const ty = anchorWorldPos.y - renderOrigin.y;
      const tz = anchorWorldPos.z - renderOrigin.z;
      primary.target.position.set(tx, ty, tz);
      primary.target.updateMatrixWorld();
      primary.position
        .copy(this.sunDir)
        .multiplyScalar(Math.max(100_000, planetRadiusM * 2))
        .add(primary.target.position);
      return;
    }

    // World-space texel snapping: subtracting renderOrigin afterwards cancels floating-origin drift
    const dotR =
      anchorWorldPos.x * this.lightRight.x +
      anchorWorldPos.y * this.lightRight.y +
      anchorWorldPos.z * this.lightRight.z;
    const dotU =
      anchorWorldPos.x * this.lightUp.x +
      anchorWorldPos.y * this.lightUp.y +
      anchorWorldPos.z * this.lightUp.z;
    const dotF =
      anchorWorldPos.x * this.sunDir.x +
      anchorWorldPos.y * this.sunDir.y +
      anchorWorldPos.z * this.sunDir.z;

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const light = this.lights[i];
      const texelWorldSize = (spec.radiusM * 2) / spec.mapSize;
      const snappedR = Math.round(dotR / texelWorldSize) * texelWorldSize;
      const snappedU = Math.round(dotU / texelWorldSize) * texelWorldSize;

      this.snappedWorldScratch
        .set(0, 0, 0)
        .addScaledVector(this.lightRight, snappedR)
        .addScaledVector(this.lightUp, snappedU)
        .addScaledVector(this.sunDir, dotF);

      light.target.position.set(
        this.snappedWorldScratch.x - renderOrigin.x,
        this.snappedWorldScratch.y - renderOrigin.y,
        this.snappedWorldScratch.z - renderOrigin.z
      );
      light.target.updateMatrixWorld();

      light.position
        .copy(this.sunDir)
        .multiplyScalar(spec.pullBackM)
        .add(light.target.position);
    }
  }

  dispose(): void {
    for (const light of this.lights) {
      if (light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null;
      }
      this.scene.remove(light, light.target);
    }
  }
}
