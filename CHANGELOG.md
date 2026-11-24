# Changelog

All notable changes to **AetherSim** are documented in this file following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

---

## [Unreleased]
- Milestone 2 (`v0.4.0`): Live Web Worker PPO neural network engine, crash-learning sandbox, ghost trajectories, and model checkpoints.
- Milestone 3 (`v0.5.0`): Aerospace Research Workbench (live plots, NN activation viewer, deterministic fault injection, Monte Carlo batch runner & CSV/JSON export, GSAP camera cuts, WebAudio).

---

## [0.3.0] — 2026-11-25
### Added
- **Universal RUD Crash & Explosion Engine (`src/effects/ExplosionSystem.ts`, `src/sim/FlightController.ts`)**:
  - Added hazard & failure detection for `SURFACE_IMPACT`, `TIP_OVER`, `LAUNCH_TOWER_COLLISION`, and `AERO_OVERSTRESS` (`q > 45 kPa` at `AoA > 34°`).
  - Added 3D volumetric GLSL fireballs, expanding blast shockwave ring, `160` instanced tumbling debris pieces, `240` rising smoke particles, transient point light, and distance-attenuated camera shake.
- **Manual TVC / RCS Flight & SAS Stability (`src/sim/FlightController.ts`, `src/main.ts`)**:
  - Added `MANUAL` / `AUTOPILOT` flight toggle, `±15°` TVC gimbal authority, cold-gas RCS thrusters, and toggleable `SAS` angular damping (`T`).
  - Added detached Super Heavy booster ballistic coasting and ground impact tracking after stage separation.
- **Pressure-Reactive GLSL Raptor Plumes & Post-Processing (`src/shaders/exhaustShader.ts`, `src/effects/PropulsionEffects.ts`, `src/scene/PostProcessing.ts`)**:
  - Implemented ambient-pressure-reactive GLSL exhaust plumes with standing Mach shock diamonds on Earth (`1.01 bar`), intermediate plumes on Mars (`0.00636 bar`), and wide vacuum fans on Moon (`0 bar`), plus cryo LOX vents, cold-gas RCS cones, and ground dust/steam blast particles.
  - Added `EffectComposer` post-processing with `UnrealBloomPass` and custom screen-space Schlieren heat-distortion `ShaderPass`, scaled by `LOW` / `MED` / `HIGH` presets.
- **Complete Engineering Documentation Suite**:
  - Authored portfolio-grade [`README.md`](README.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/MILESTONES.md`](docs/MILESTONES.md), [`docs/VALIDATION_AND_SAFETY.md`](docs/VALIDATION_AND_SAFETY.md), and `CHANGELOG.md`.

### Changed
- **Rebrand to AetherSim**: Updated package metadata (`"name": "aethersim"`, `"version": "0.3.0"`), window/document titles (`"AetherSim — 3D Aerospace Launch & Landing Simulator"`), and HUD brand title (`AETHERSIM`) across `package.json`, `index.html`, `electron/main.cjs`, and `src/main.ts`.
- Expanded Vitest coverage in `src/__tests__/flightController.test.ts` to `6` flight-physics tests (`10` total tests across `3` files).

---

## [0.2.0] — 2026-11-24
### Added
- **3D Electron + Three.js + TypeScript Desktop Foundation (`electron/`, `src/`)**:
  - Built sandboxed Electron wrapper (`contextIsolation: true`, `sandbox: true`, CSP headers) and `scripts/launch-desktop.mjs` (`--prod`, `--smoke-test`).
  - Implemented NASA-grounded Mars, Earth, and Moon planetary configs (`src/config/planets.ts`), deterministic radial-LOD PBR terrain (`TerrainSystem.ts`, `noise.ts`), procedural PBR material maps (`ProceduralTextures.ts`), and custom GLSL Rayleigh/Mie sky dome + starfield + Earth clouds (`atmosphereShader.ts`).
- **SpaceX Starship + Super Heavy Stack & Planet-Specific Complexes (`StarshipVehicle.ts`, `LaunchComplex.ts`)**:
  - Modeled 1:1 scale `71 m` Super Heavy Booster (`33` Raptors, `24` hot-staging struts, `4` waffle grid fins) and `50 m` Starship Upper Stage (split TPS/stainless hull, `4` flaps, `6` Raptors, `4` deployable landing legs, dynamic cryogenic frost).
  - Built Earth Starbase OLM & `145 m` Mechazilla tower, Mars Spaceport & geodesic ISRU habitat, Moon Shackleton pad with `360°` regolith berm & Artemis outpost, and orbiting stations on all 3 worlds.
  - Implemented initial headless `FlightController.ts` Launch and Propulsive Landing autopilot modes.

### Changed
- Archived Milestone 0 Python 2D PPO project cleanly under [`archive/legacy-rl-2d/`](archive/legacy-rl-2d/).

---

## [0.1.0] — 2026-10-30
### Added
- **Milestone 0 — 2D Python RL Rocket Lander (`archive/legacy-rl-2d/`)**:
  - Trained Stable-Baselines3 PPO policies (`100k` unshaped, `500k` shaped, `1M` shaped) on Farama Gymnasium `LunarLander-v3` (Box2D) with custom reward shaping (`reward_wrapper.py`).
  - Added deterministic `100`-seed evaluation benchmarks (`benchmark.py`), multi-planet gravity/wind sweeps (`planets.py`), and `pytest` verification suite.
