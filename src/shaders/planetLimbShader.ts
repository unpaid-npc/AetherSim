import * as THREE from "three";

const LIMB_VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * worldPos;
  #include <logdepthbuf_vertex>
}
`;

const LIMB_FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uSunDirection;
uniform vec3 uAtmosphereColor;
uniform vec3 uHorizonColor;
uniform float uStrength;
uniform float uCameraAltitude;

varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  #include <logdepthbuf_fragment>

  if (uStrength <= 0.005) {
    discard;
  }

  vec3 n = normalize(vWorldNormal);
  vec3 v = normalize(cameraPosition - vWorldPos);
  vec3 s = normalize(uSunDirection);

  // BackSide outer shell grazing intensity: peaks cleanly along planetary silhouette horizon
  float ndotv = abs(dot(n, v));
  float rim = pow(smoothstep(0.0, 0.30, ndotv), 1.65);

  // Day/night solar terminator factor across globe limb
  float sunDot = dot(n, s);
  float dayTerm = smoothstep(-0.26, 0.38, sunDot);
  float sunsetBand = exp(-pow((sunDot + 0.02) / 0.22, 2.0));

  // Fade in cleanly above 1.8 km so low-altitude SkyDome isn't double-brightened
  float altFade = smoothstep(1800.0, 14000.0, uCameraAltitude);

  vec3 col = mix(uAtmosphereColor, uHorizonColor, 0.45 + 0.4 * sunsetBand);
  float alpha = rim * (0.12 + 0.88 * dayTerm) * uStrength * altFade * 0.92;
  if (alpha < 0.005) {
    discard;
  }

  gl_FragColor = vec4(col * (0.85 + 0.65 * dayTerm), clamp(alpha, 0.0, 0.92));
}
`;

export function createPlanetLimbMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: LIMB_VERTEX_SHADER,
    fragmentShader: LIMB_FRAGMENT_SHADER,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    uniforms: {
      uSunDirection: { value: new THREE.Vector3(0.58, 0.44, -0.68).normalize() },
      uAtmosphereColor: { value: new THREE.Color("#4ca8ff") },
      uHorizonColor: { value: new THREE.Color("#9ed8ff") },
      uStrength: { value: 1.0 },
      uCameraAltitude: { value: 0 },
    },
  });
}
