import * as THREE from "three";

const OCEAN_VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
#include <fog_pars_vertex>

attribute float aCoastDist;

varying vec3 vWorldPos;
varying vec2 vGroundXZ;
varying float vRadialDist;
varying float vCoastDist;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vGroundXZ = position.xz;
  vRadialDist = length(position.xz);
  vCoastDist = aCoastDist;
  vec4 mvPosition = viewMatrix * worldPos;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const OCEAN_FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
#include <fog_pars_fragment>

uniform float uTime;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uSkyHorizonColor;
uniform vec3 uSkyZenithColor;
uniform float uOpacity;
uniform float uFeatherInner;
uniform float uFeatherOuter;

varying vec3 vWorldPos;
varying vec2 vGroundXZ;
varying float vRadialDist;
varying float vCoastDist;

float waveHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float waveNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = waveHash(i);
  float b = waveHash(i + vec2(1.0, 0.0));
  float c = waveHash(i + vec2(0.0, 1.0));
  float d = waveHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  #include <logdepthbuf_fragment>

  float shoreMask = smoothstep(-8.0, 10.0, vCoastDist);
  float radialFade = 1.0 - smoothstep(uFeatherInner, uFeatherOuter, vRadialDist);
  float baseAlpha = shoreMask * radialFade * uOpacity;
  if (baseAlpha < 0.004) {
    discard;
  }

  vec2 p = vGroundXZ;
  float distCam = length(cameraPosition - vWorldPos);
  float rippleAtten = 1.0 - smoothstep(1400.0, 9500.0, distCam);

  // Multi-directional animated Gulf swells + gentle coastal chop
  float w1 = sin(p.x * 0.055 + p.y * 0.022 + uTime * 1.45);
  float w2 = cos(p.x * 0.032 - p.y * 0.048 - uTime * 1.12);
  float w3 = sin(p.x * 0.14 + p.y * 0.09 + uTime * 2.25);
  float rip = (waveNoise(p * 0.18 + vec2(-uTime * 0.45, uTime * 0.25)) - 0.5) * 2.0;

  float nx = (-w1 * 0.055 - w2 * 0.032 * 0.7 - w3 * 0.04 - rip * 0.065) * (0.35 + 0.65 * rippleAtten);
  float nz = (-w1 * 0.022 + w2 * 0.048 * 0.7 - w3 * 0.025 - rip * 0.05) * (0.35 + 0.65 * rippleAtten);

  vec3 N = normalize(vec3(nx, 1.0, nz));
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uSunDirection);
  vec3 H = normalize(L + V);

  // Depth-based Gulf of Mexico water palette: bright turquoise shallows -> deep Gulf sapphire
  vec3 shallowTeal = vec3(0.11, 0.56, 0.60);
  vec3 midCoastal  = vec3(0.04, 0.31, 0.48);
  vec3 deepGulf    = vec3(0.02, 0.14, 0.31);

  float depthT1 = smoothstep(0.0, 145.0, vCoastDist);
  float depthT2 = smoothstep(110.0, 760.0, vCoastDist);
  vec3 waterColor = mix(shallowTeal, midCoastal, depthT1);
  waterColor = mix(waterColor, deepGulf, depthT2);

  // Sky Fresnel reflection
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 4.2);
  vec3 skyReflect = mix(uSkyZenithColor, uSkyHorizonColor, 0.58 + 0.28 * fresnel);

  // Sun diffuse lift + bright Gulf sparkling specular highlight
  float sunDiff = max(dot(N, L), 0.0);
  vec3 litWater = waterColor * (0.38 + 0.62 * sunDiff);
  vec3 color = mix(litWater, skyReflect, clamp(fresnel * 0.78, 0.04, 0.85));

  float specCore = pow(max(dot(N, H), 0.0), 150.0) * 1.95;
  float specBroad = pow(max(dot(N, H), 0.0), 22.0) * 0.22;
  color += uSunColor * (specCore + specBroad) * smoothstep(-0.05, 0.25, L.y);

  // Animated rolling white shoreline surf foam bands breaking softly onto Boca Chica beach
  float surfZone = 1.0 - smoothstep(26.0, 96.0, vCoastDist);
  if (surfZone > 0.01) {
    float nFoam = waveNoise(vec2(p.x * 0.06, p.y * 0.045) + vec2(uTime * 0.2, 0.0));
    float surfWave = sin(vCoastDist * 0.22 + uTime * 1.95 + nFoam * 3.4);
    float band1 = smoothstep(0.52, 0.92, surfWave);
    float edgeLip = (1.0 - smoothstep(-2.0, 14.0, vCoastDist)) * (0.55 + 0.45 * nFoam);
    float foam = clamp((band1 * surfZone * 0.72 + edgeLip * 0.85) * smoothstep(-6.0, 5.0, vCoastDist), 0.0, 1.0);
    color = mix(color, vec3(0.95, 0.98, 1.0), foam * 0.82);
    baseAlpha = max(baseAlpha, foam * 0.78 * uOpacity);
  }

  // Water opacity: translucent over golden beach shallows, rich opaque offshore
  float waterOpacity = mix(0.68, 0.97, smoothstep(10.0, 110.0, vCoastDist));
  float finalAlpha = clamp(baseAlpha * waterOpacity, 0.0, 1.0);

  gl_FragColor = vec4(color, finalAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** Creates the animated Gulf of Mexico water ShaderMaterial with shoreline surf and Fresnel reflection. */
export function createGulfOceanMaterial(
  sunDirection: THREE.Vector3,
  sunColor: string,
  skyHorizonColor: string,
  skyZenithColor: string
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: OCEAN_VERTEX_SHADER,
    fragmentShader: OCEAN_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSunDirection: { value: sunDirection.clone().normalize() },
        uSunColor: { value: new THREE.Color(sunColor) },
        uSkyHorizonColor: { value: new THREE.Color(skyHorizonColor) },
        uSkyZenithColor: { value: new THREE.Color(skyZenithColor) },
        uOpacity: { value: 1.0 },
        uFeatherInner: { value: 10000.0 },
        uFeatherOuter: { value: 33500.0 },
      },
    ]),
  });
}
