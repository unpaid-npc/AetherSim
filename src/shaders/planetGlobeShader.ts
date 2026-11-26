import * as THREE from "three";

const SURFACE_VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vLocalDir;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vLocalDir = position;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
  #include <logdepthbuf_vertex>
}
`;

const SEAM_FREE_SAMPLER_GLSL = /* glsl */ `
const float AETHER_INV_TWO_PI = 0.15915494309189534;
const float AETHER_INV_PI     = 0.3183098861837907;

vec4 sampleEquirectSeamFree(sampler2D tex, vec3 dir) {
  vec3 n = normalize(dir);
  float uA = 0.5 + atan(-n.z, n.x) * AETHER_INV_TWO_PI;
  float uB = fract(uA + 0.5);
  float v  = clamp(0.5 + asin(clamp(n.y, -1.0, 1.0)) * AETHER_INV_PI, 0.0004, 0.9996);
  vec2 uvA = vec2(uA, v);
  vec2 uvB = vec2(uB, v);
  vec2 dUVdx = fwidth(uA) < fwidth(uB) ? dFdx(uvA) : dFdx(uvB);
  vec2 dUVdy = fwidth(uA) < fwidth(uB) ? dFdy(uvA) : dFdy(uvB);
  return texture2DGradEXT(tex, uvA, dUVdx, dUVdy);
}
`;

const SURFACE_FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform sampler2D uDayMap;
uniform sampler2D uSpecularMap;
uniform sampler2D uNightMap;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uHemiSkyColor;
uniform vec3 uHemiGroundColor;
uniform float uHemiIntensity;
uniform float uCameraAltitude;
uniform float uNightOpacity;
uniform float uIsEarth;
uniform float uIsMoon;
uniform float uMicroDetailStrength;
uniform float uLocalTerrainCutoutRadius;
uniform float uSimRadius;
uniform vec3 uPadRenderPos;

varying vec3 vLocalDir;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

${SEAM_FREE_SAMPLER_GLSL}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float valueNoise3D(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(hash31(i), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
      mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x),
      f.y
    ),
    mix(
      mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
      mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x),
      f.y
    ),
    f.z
  );
}

void main() {
  #include <logdepthbuf_fragment>

  // Close globe cutout strictly BEFORE local terrain starts fading out (zero hole, zero floating disc)
  float cutStart = uIsEarth > 0.5 ? 1800.0 : 3500.0;
  float cutEnd = uIsEarth > 0.5 ? 3600.0 : 7000.0;
  float cutoutFade = 1.0 - smoothstep(cutStart, cutEnd, uCameraAltitude);
  float activeCutoutR = uLocalTerrainCutoutRadius * cutoutFade;
  vec3 relPad = vWorldPos - uPadRenderPos;
  if (
    activeCutoutR > 1.0 &&
    relPad.y > -uSimRadius * 0.25 &&
    length(relPad.xz) < activeCutoutR
  ) {
    discard;
  }

  vec3 localDir = normalize(vLocalDir);
  vec3 N = normalize(vWorldNormal);
  vec3 L = normalize(uSunDirection);
  vec3 V = normalize(cameraPosition - vWorldPos);

  vec3 albedo = sampleEquirectSeamFree(uDayMap, localDir).rgb;

  // Camera-altitude-driven 3D procedural micro-detail grain (< 40 km) with zero polar pinch
  float microFade = 1.0 - smoothstep(4000.0, 40000.0, uCameraAltitude);
  if (microFade > 0.005 && uMicroDetailStrength > 0.001) {
    float n1 = valueNoise3D(localDir * 240.0);
    float n2 = valueNoise3D(localDir * 720.0);
    float grain = (n1 * 0.62 + n2 * 0.38) - 0.5;
    albedo *= 1.0 + grain * uMicroDetailStrength * microFade;
  }

  float NdotL = dot(N, L);
  float diffTerm = max(NdotL, 0.0);
  // Subtle wrap light only where thin/dense atmospheres scatter around terminator
  float wrapDiff = uIsMoon > 0.5 ? diffTerm : max(0.0, (NdotL + 0.06) / 1.06);

  vec3 directIrrad = uSunColor * (uSunIntensity * wrapDiff * 0.33);
  vec3 hemiIrrad = mix(uHemiGroundColor, uHemiSkyColor, clamp(N.y * 0.5 + 0.5, 0.0, 1.0)) *
                   (uHemiIntensity * (uIsMoon > 0.5 ? 0.14 : 0.34));

  vec3 color = albedo * (directIrrad + hemiIrrad);

  // Earth ocean specular highlight driven by 4K specular mask
  if (uIsEarth > 0.5 && NdotL > -0.05) {
    float waterMask = sampleEquirectSeamFree(uSpecularMap, localDir).r;
    vec3 H = normalize(L + V);
    float specPow = mix(10.0, 42.0, waterMask);
    float specAmp = mix(0.015, 0.44, waterMask);
    float spec = pow(max(dot(N, H), 0.0), specPow) * specAmp * smoothstep(-0.02, 0.18, NdotL);
    color += uSunColor * (uSunIntensity * spec * 0.30);
  }

  // Earth night-side city lights integrated seamlessly onto the main globe surface
  if (uIsEarth > 0.5 && uNightOpacity > 0.005) {
    float nightMask = smoothstep(0.08, -0.24, NdotL);
    if (nightMask > 0.002) {
      vec3 nightTex = sampleEquirectSeamFree(uNightMap, localDir).rgb;
      color += nightTex * (nightMask * uNightOpacity * 1.55);
    }
  }

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const CLOUD_FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform sampler2D uCloudMap;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uOpacity;

varying vec3 vLocalDir;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

${SEAM_FREE_SAMPLER_GLSL}

void main() {
  #include <logdepthbuf_fragment>

  if (uOpacity <= 0.005) {
    discard;
  }

  vec3 n = normalize(vWorldNormal);
  vec3 l = normalize(uSunDirection);
  vec3 cloudSample = sampleEquirectSeamFree(uCloudMap, vLocalDir).rgb;
  float cloudDensity = dot(cloudSample, vec3(0.3333));
  float alpha = smoothstep(0.06, 0.85, cloudDensity) * uOpacity;
  if (alpha < 0.004) {
    discard;
  }

  float dayShade = 0.06 + 0.94 * smoothstep(-0.18, 0.28, dot(n, l));
  vec3 col = uSunColor * (uSunIntensity * 0.34 * dayShade);

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createPlanetSurfaceMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SURFACE_VERTEX_SHADER,
    fragmentShader: SURFACE_FRAGMENT_SHADER,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: 4,
    polygonOffsetUnits: 4,
    uniforms: {
      uDayMap: { value: null },
      uSpecularMap: { value: null },
      uNightMap: { value: null },
      uSunDirection: { value: new THREE.Vector3(0.68, 0.56, 0.47).normalize() },
      uSunColor: { value: new THREE.Color("#fff5e4") },
      uSunIntensity: { value: 3.3 },
      uHemiSkyColor: { value: new THREE.Color("#9cd3ff") },
      uHemiGroundColor: { value: new THREE.Color("#b8aa8e") },
      uHemiIntensity: { value: 0.95 },
      uCameraAltitude: { value: 0 },
      uNightOpacity: { value: 0 },
      uIsEarth: { value: 0 },
      uIsMoon: { value: 0 },
      uMicroDetailStrength: { value: 0.09 },
      uLocalTerrainCutoutRadius: { value: 9500.0 },
      uSimRadius: { value: 6371000.0 },
      uPadRenderPos: { value: new THREE.Vector3(0, 0, 0) },
    },
  });
}

export function createPlanetCloudMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SURFACE_VERTEX_SHADER,
    fragmentShader: CLOUD_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: {
      uCloudMap: { value: null },
      uSunDirection: { value: new THREE.Vector3(0.58, 0.44, -0.68).normalize() },
      uSunColor: { value: new THREE.Color("#fff3df") },
      uSunIntensity: { value: 3.4 },
      uOpacity: { value: 0 },
    },
  });
}
