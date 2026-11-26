import * as THREE from "three";

const EXHAUST_VERTEX_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

uniform float uTime;
uniform float uThrottle;
uniform float uPressureBar;
uniform float uPlumeLength;

varying vec2 vUv;
varying float vAxial;

void main() {
  vUv = uv;
  // ConeGeometry height runs y = 0 (top nozzle exit) down to y = -1 (tail) after normalization
  float axial = clamp(-position.y, 0.0, 1.0);
  vAxial = axial;

  // Atmospheric pressure expansion:
  // Earth (~1 bar): tight supersonic column; Mars (0.006 bar): wide plume; Moon (0 bar): wide vacuum fan
  float vacExpand = 1.0 - smoothstep(0.0, 0.35, uPressureBar);
  float radialScale = mix(1.0 + axial * 0.6, 1.0 + pow(axial, 0.72) * 2.4, vacExpand);
  float flutter = sin(axial * 22.0 - uTime * 48.0) * 0.045 * axial * uThrottle;

  vec3 pos = position;
  pos.x = pos.x * radialScale + flutter;
  pos.z = pos.z * radialScale - flutter * 0.6;
  pos.y = pos.y * uPlumeLength * (0.4 + 0.6 * uThrottle);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const EXHAUST_FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform float uTime;
uniform float uThrottle;
uniform float uPressureBar;
uniform float uSeedOffset;
uniform float uPlumeStyle; // 0 = methalox (blue-violet), 1 = kerolox (golden amber), 2 = solid_hybrid (bright white-amber)

varying vec2 vUv;
varying float vAxial;

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.12);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

void main() {
  #include <logdepthbuf_fragment>

  if (uThrottle <= 0.01) {
    discard;
  }

  float t = vAxial;
  float turb = noise2(vec2(vUv.x * 8.0 + uSeedOffset, t * 14.0 - uTime * 36.0));
  float fine = noise2(vec2(vUv.x * 18.0 - uSeedOffset, t * 28.0 - uTime * 58.0));

  // Standing Mach shock diamonds present under atmospheric backpressure, absent in vacuum
  float atmPresence = smoothstep(0.0, 0.18, uPressureBar);
  float diamondFreq = mix(4.0, 9.5, smoothstep(0.0, 1.0, uPressureBar));
  float shockWave = pow(max(0.0, sin(t * 3.14159 * diamondFreq - uTime * 4.5)), 6.0);
  float diamonds = shockWave * atmPresence * (1.0 - smoothstep(0.15, 0.88, t));

  // Throat core + tail attenuation
  float coreMask = 1.0 - smoothstep(0.0, 0.42, t);
  float tailFade = (1.0 - smoothstep(0.32, 1.0, t)) * (0.72 + 0.28 * turb);
  float throatSoft = smoothstep(0.0, 0.04, t);

  vec3 coreColor = vec3(1.35, 1.85, 2.55); // Crisp blue-white methalox throat
  vec3 diamondColor = vec3(1.65, 2.0, 2.65);
  vec3 outerAtmColor = vec3(1.55, 0.82, 0.34);
  if (uPlumeStyle > 1.5) {
    // Solid propellant (LVM3 S200): dazzling bright white-gold exhaust
    coreColor = vec3(2.05, 1.92, 1.58);
    diamondColor = vec3(1.9, 1.65, 1.15);
    outerAtmColor = vec3(1.85, 1.15, 0.42);
  } else if (uPlumeStyle > 0.5) {
    // RP-1 Kerolox (Falcon 9 Merlin / Saturn V F-1): golden-amber luminous plume
    coreColor = vec3(1.85, 1.48, 0.88);
    diamondColor = vec3(1.95, 1.55, 0.95);
    outerAtmColor = vec3(1.75, 0.78, 0.22);
  }
  vec3 vacVioletColor = vec3(0.75, 0.82, 1.45); // Translucent vacuum expansion fan

  vec3 basePlume = mix(vacVioletColor, outerAtmColor, atmPresence * (0.35 + 0.65 * fine));
  vec3 col = mix(basePlume, coreColor, coreMask * 0.92);
  col += diamondColor * diamonds * 1.45;

  float vacAlphaAtten = mix(0.32, 0.82, atmPresence);
  float alpha = tailFade * throatSoft * vacAlphaAtten * (0.35 + 0.65 * uThrottle);
  alpha += diamonds * 0.45 * uThrottle;
  alpha = clamp(alpha, 0.0, 1.0);

  if (alpha < 0.008) {
    discard;
  }

  gl_FragColor = vec4(col * (0.45 + 0.75 * uThrottle), alpha);
}
`;

export function createExhaustPlumeGeometry(): THREE.BufferGeometry {
  // Unit open cone hanging from y=0 down to y=-1 with top radius=0.45 and bottom radius=0.95
  const geom = new THREE.CylinderGeometry(0.45, 0.95, 1.0, 16, 10, true);
  geom.translate(0, -0.5, 0);
  return geom;
}

export function createExhaustPlumeMaterial(seedOffset = 0): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: EXHAUST_VERTEX_SHADER,
    fragmentShader: EXHAUST_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uThrottle: { value: 0 },
      uPressureBar: { value: 0.00636 },
      uPlumeLength: { value: 18.0 },
      uSeedOffset: { value: seedOffset },
      uPlumeStyle: { value: 0 },
    },
  });
}

export function updateExhaustPlumeUniforms(
  mat: THREE.ShaderMaterial,
  elapsedSec: number,
  throttle: number,
  pressureBar: number,
  plumeLength: number,
  plumeStyle = 0
): void {
  mat.uniforms.uTime.value = elapsedSec;
  mat.uniforms.uThrottle.value = throttle;
  mat.uniforms.uPressureBar.value = pressureBar;
  mat.uniforms.uPlumeLength.value = plumeLength;
  mat.uniforms.uPlumeStyle.value = plumeStyle;
}
