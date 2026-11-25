# Changelog

All notable changes to **AetherSim** are documented in this file following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

---

## [Unreleased]
- Future Phases B & C (14-Module Ecosystem Expansion): FMI 3.0 / OMG DDS co-simulation, spherical rotating-planet orbital propagator, offline CFD/FEA surrogates, independent AFSS monitor, and HIL FlatSat integration.

---

## [1.1.0] — 2026-11-25
### Added
- **Planet-Scale 3D Globes & Seamless Surface-to-Space Zoom (`PlanetGlobe.ts`, `PlanetGlobeTextures.ts`, `earthGeography.ts`, `planetLimbShader.ts`, `TerrainSystem.ts`, `CameraDirector.ts`)**:
  - Modeled complete `1:50`-scaled 3D globes for Moon (`34,748 m`), Mars (`67,790 m`), and Earth (`127,420 m`) rotated cleanly so each complex sits at zenith `(0, 0, 0)`, featuring curved local terrain, anti-aliased Earth continents/oceans/clouds/night-lights, Mars canyons/volcanoes/polar caps, Lunar maria/ray craters, atmospheric Fresnel limb shader, and Google-Earth-style `C5 ORBIT` zoom.
- **Spherical Central-Body Orbital Mechanics & Insertion Autopilot (`src/sim/OrbitalMechanics.ts`, `src/sim/FlightController.ts`)**:
  - Upgraded `launch` physics to Velocity-Verlet spherical gravity ($\mu = g_0 R_{\text{sim}}^2$), radial surface contact, vacuum density cutoff above `atmosphereTopM`, Keplerian `Ap`/`Pe`/`e`/period calculations, `1x | 2x | 5x | 10x` Time Warp (`[`/`]`), and closed-loop gravity-turn → `ORBIT_INSERTION` → `COAST_TO_AP` → `CIRCULARIZATION` → `ORBIT_ACHIEVED` guidance across Mars, Earth, and Moon.
- **3D Orbital Path Visualizer, `C6 MAP` Camera & Orbital HUD (`src/scene/OrbitVisualizer.ts`, `src/main.ts`, `src/style.css`)**:
  - Added toggleable dashed Target Parking Orbit Ring, dynamic predicted trajectory arc (amber/cyan/emerald), spacecraft flight trail, constant-screen-scale `SHIP`/`AP`/`PE`/`PAD` markers, `C6 MAP` (`F6`) orbital overview camera, orbital telemetry strip (`APOAPSIS`, `PERIAPSIS`, `ECCENTRICITY`, `TARGET ORBIT`), and `ORBIT ACHIEVED` status banner.
- **Orbital & Planet-Scale Test Suites (`src/__tests__/planetScale.test.ts`, `src/__tests__/orbitalMechanics.test.ts`)**:
  - Expanded Vitest suite to `7` files / `27` tests (`0` failures), verifying circular/elliptical/suborbital trajectories and full headless Mars/Earth/Moon launch-to-orbit circularization.

### Fixed & Improved
- **Stage 5A Visual Transition Seams (`PlanetGlobeTextures.ts`, `TerrainSystem.ts`, `PlanetGlobe.ts`, `atmosphereShader.ts`, `SceneManager.ts`)**:
  - Eliminated blocky coastlines via quadratic spline continent smoothing + bilinear shelf blending, added `6–20 km` local-terrain opacity cross-fade matching outer vertex colors to coastal globe tones, and shifted global clouds to `4–14 km` with fog cleared above `3.5 km`.
- **Desktop Dev-Mode Black-Screen Fix & Hardened Boot (`vite.config.ts`, `electron/main.cjs`, `src/main.ts`)**:
  - Ignored `venv/` and build artifacts in Vite's file watcher and disabled unnecessary PostCSS config probing, added transient `net::ERR_NETWORK_CHANGED` dev reload recovery, fail-safe DOM startup banner, interactive startup watchdog, and backbuffer `gl.readPixels` verification in `--smoke-test` (`bootMs: 261 ms` dev / `260 ms` prod, `SMOKE_OK`).

---

## [1.0.1] — 2026-11-25
### Fixed & Improved
- **PPO Policy Collapse & Actor/Critic Gradient Isolation (`src/ai/NeuralNetwork.ts`, `src/ai/PPOTrainer.ts`)**:
  - Split Behavioral Cloning updates into Actor-only (`stepAdamActor`) and Critic-only (`stepAdamCritic`) Adam passes with a 1-round DAgger aggregation pass so large Critic return gradients (`~100+` L2 norm) no longer starve Actor imitation learning.
  - Lowered post-warm-start policy noise (`logStd = -1.6`), cleared Adam momentum (`resetOptimizerState()`), and constrained fine-tuning LR (`<= 1.5e-4`), KL (`<= 0.012`), entropy coef (`<= 0.002`), and `logStd` ceiling (`<= -1.1`).
  - Added deterministic 5-seed `BestBrainSummary` validation + automatic **collapse recovery guard**, preventing noisy rollout updates from overwriting working weights and always loading `bestCheckpoint` on `3. FLY TRAINED AI (3D)`.
- **Session-Scoped Worker Sync & `padDeckY` Parity (`src/ai/ppoWorker.ts`, `src/ai/PPOWorkerClient.ts`, `src/sim/FlightController.ts`, `src/ai/RLEnvironment.ts`, `src/scene/SceneManager.ts`)**:
  - Tagged all inbound/outbound worker messages with incrementing `sessionId` counters so stale background rollouts queued before `RESET AI BRAIN`, planet switches, or mission switches are ignored instead of overwriting a fresh brain.
  - Fixed Earth/Mars/Moon `padDeckY` propagation in `FlightController.configureRLSpawn()` and `SceneManager.spawnLive3DRLEpisode()`, and aligned live 3D landing episode step budget (`700` steps) with `RLEnvironment.ts`.
- **Crystal-Clear AI Status Banner & Version Sync (`src/main.ts`, `src/style.css`, `package.json`)**:
  - Added live color-coded pulsing AI status banner, clear `Brain Status` scorecard (`Brain Level`, `Best Landing/Launch Success`, `Train Episodes`, live `Worker Speed`, `Live Rollout Ret`, `Best Eval Return`), explicit `WARM_START_COMPLETE` feedback, `PRE-TRAINING...` button lock, `STOP TRAINING` toggle, and one-click `3. FLY TRAINED AI (3D)`.
  - Synced top-left HUD version badge, Help modal, exports, and `window.__STARSHIP_SIM__` directly to `package.json` (`v1.0.1`).

---

## [1.0.0] — 2026-11-25
### Added
- **Multi-Planet Benchmark Harness (`src/research/benchmarkHarness.ts`, `scripts/run-benchmark.mjs`, `npm run benchmark`)**:
  - Evaluates `untrained_ppo`, `ppo_scratch` (`8,192` steps), `ppo_trained` (BC warm-start + `8,192` PPO steps), and `pid_baseline` across `20` paired deterministic seeds (`42..61`) on Mars, Earth, and Moon (nominal + `15%` thrust loss / `15 m/s` crosswind stress test).
  - Exports verifiable evidence to [`results/v1_benchmark.json`](results/v1_benchmark.json), [`results/v1_benchmark.csv`](results/v1_benchmark.csv), and [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).
- **Automated Desktop GPU & FPS Profiler (`scripts/profile-desktop.mjs`, `electron/main.cjs`, `npm run profile:desktop`)**:
  - Added `window.__AETHERSIM_PROFILER__` and `ELECTRON_PROFILE=1` instrumentation measuring live `requestAnimationFrame` FPS, `p50`/`p95` frame times, WebGL draw calls, triangles, and JS heap across all 9 `(Mars | Earth | Moon) × (LOW | MED | HIGH)` combinations.
  - Saves raw telemetry and hardware-scoped report to [`results/v1_performance_profile.json`](results/v1_performance_profile.json) and [`docs/PERFORMANCE_REPORT.md`](docs/PERFORMANCE_REPORT.md).
- **GitHub Actions CI (`.github/workflows/ci.yml`)**:
  - Added CI pipeline running `npm ci`, `npm run test`, and `npm run build` on `push` and `pull_request` (`main`, `develop`).
- **Windows Desktop Packaging & Generated App Icons (`scripts/generate-icon.mjs`, `package.json`, `npm run dist:win`)**:
  - Generated [`build/icon.png`](build/icon.png) (`512×512`) and multi-resolution [`build/icon.ico`](build/icon.ico) (`256, 64, 32, 16 px`).
  - Added `electron-builder` packaging scripts (`dist:win`, `dist:win:dir`) producing standalone Windows x64 portable executable (`release/AetherSim-1.0.0-win-x64-portable.exe`, `106.90 MB`, gitignored) with `SMOKE_OK` packaged verification.
- **Release `v1.0.0` Version Tags & Docs**: Updated `package.json`, HUD badge (`v1.0.0 · Research Workbench`), Help modal, JSON export metadata, [`README.md`](README.md), and [`docs/MILESTONES.md`](docs/MILESTONES.md).

### Fixed & Improved
- **Accurate Post-Processing Render Telemetry (`src/scene/PostProcessing.ts`)**: Configured `renderer.info.autoReset = false` with explicit `reset()` inside `PostProcessingPipeline.render()` so reported draw calls and triangles reflect full scene + composer passes (`108–168` draws, `61,692–68,243` tris) instead of only the final fullscreen quad (`1`).

---

## [0.5.0] — 2026-11-25
### Added
- **Aerospace Research Workbench (`src/research/`, `src/sim/FaultInjector.ts`)**:
  - `TelemetryCharts.ts`: 4 high-DPI HTML5 canvas streaming plots (`Altitude & Vy`, `Dynamic Pressure & G-Load`, `Tilt & Throttle`, `PPO Learning Curve`) throttled to `~16 Hz` when open.
  - `NeuralNetVisualizer.ts`: Live `14 -> 64 -> 64 -> 3` Actor MLP activation & Critic `V(s)` visualizer.
  - `FaultInjector.ts`: Programmable thrust loss (`0–50%`), altitude-triggered faults, density-scaled crosswind (`0–40 m/s`, zero in Moon vacuum), IMU bias/noise via `FlightController.getSensedTelemetry()`, and TVC lag toggle.
  - `MonteCarloRunner.ts`: Off-thread Web Worker `20 / 50 / 100`-run batch evaluator for `AI NEURAL` and `PID AUTO` with exact 95% Clopper-Pearson binomial confidence intervals.
  - `DataExporter.ts`: One-click Flight Telemetry `.csv`, RL Training History `.csv`, and full reproducible Experiment Bundle `.json` downloads.
- **GSAP Multi-Camera Cinematography & Procedural Web Audio (`CameraDirector.ts`, `SoundEngine.ts`)**:
  - Added `C1 PAD`, `C2 DRONE`, `C3 ENGINE`, `C4 STATION`, `C5 ORBIT` (`F1–F5`) camera presets and `AUTO` timeline director.
  - Added zero-asset procedural Web Audio synthesis (atmosphere-coupled Raptor roar, cryo hiss, RCS pulses, sub-bass RUD boom).
- **Milestone 3 Test Coverage (`src/__tests__/researchWorkbench.test.ts`, `ppoAI.test.ts`)**:
  - Verified `FaultInjector`, Clopper-Pearson CIs, Monte Carlo evaluation, CSV/JSON export schemas, and `LAUNCH` reward alignment (`18/18` Vitest tests passing).

### Fixed & Improved
- **Camera Re-Lock (`CameraDirector.reLockOnVehicle`)**: Eliminated camera drift after manual resets, planet/mission switches, and post-RUD `LIVE TRAIN` auto-resets.
- **`LAUNCH` PPO Reward Alignment (`RLEnvironment.ts`, `PPOTrainer.ts`)**: Added explicit `isLaunchSuccess()` (`alt >= 1200 m`, `vy > 35 m/s`, `tilt < 35°`), early-tilt/tower-drift penalties, and `tilt > 65°` failure termination; expanded landing `maxSteps` to `700` for soft final descent.
- **Intuitive SpaceX-Webcast UX (`src/main.ts`, `src/style.css`)**: Added compact top bar, collapsible Mission & Guided 3-step AI Deck with hover tooltips, two-click `RESET AI BRAIN` confirmation, `?` Help modal, and bottom webcast telemetry strip.
- **Visual FX Polish (`PropulsionEffects.ts`, `ExplosionSystem.ts`)**: Upgraded cryo/dust particles to `128×128` multi-puff feathered sprites and fireballs to subdivision-5 FBM-displaced spheres with view-normal radial edge fade.

---

## [0.4.0] — 2026-11-25
### Added
- **Pure TypeScript Continuous-Control PPO Engine (`src/ai/`)**:
  - `prng.ts`: Deterministic Mulberry32 PRNG with Box-Muller Gaussian sampling and Fisher-Yates shuffling.
  - `NeuralNetwork.ts`: `Float32Array` Actor-Critic MLP (`14 -> 64 -> 64 -> 3` actor mean + learnable `logStd`, `14 -> 64 -> 64 -> 1` critic) with orthogonal initialization, exact analytical backpropagation, Adam optimizer with global L2 gradient clipping (`0.5`), `forwardWithActivations()` snapshot hook, and versioned JSON checkpoint `serialize()` / `deserialize()`.
  - `RLEnvironment.ts`: Deterministic `20 Hz` (`dt = 0.05 s`) RL wrapper around `FlightController` for Mars, Earth, and Moon (`landing` & `launch`), 14D normalized observations, 3D continuous action mapping, optional domain randomization, and decomposed reward breakdown (`distance`, `velocity`, `attitude`, `fuel`, `terminal`).
  - `PPOTrainer.ts`: Flat `RolloutBuffer`, GAE ($\gamma = 0.99, \lambda = 0.95$), clipped surrogate loss ($\epsilon = 0.2$), value loss, entropy bonus, Schulman approx-KL early stopping, optional Behavioral Cloning `warmStartFromGuidance()`, and deterministic `evaluateBatch()`.
  - `ppoWorker.ts` & `PPOWorkerClient.ts`: Dedicated Vite Web Worker executing background turbo PPO training off the WebGL thread.
- **Live 3D Neural AI Integration & HUD (`FlightController.ts`, `SceneManager.ts`, `src/main.ts`, `src/style.css`)**:
  - Added `"ai_ppo"` control mode (`AI (PPO)`) alongside `PID AUTO` and `MANUAL`, with continuous `[throttle, pitchCmd, yawCmd]` control, live 3D "learn-from-crashes" episode loop (`LIVE TRAIN`), background `TURBO TRAIN`, deterministic `EVAL (DET)`, `WARM-START`, LR/domain-randomization controls, and `.json` checkpoint save/load.
  - Added `src/__tests__/ppoAI.test.ts` verifying deterministic forward passes, checkpoint round-trips, Adam gradient convergence, decomposed rewards, and headless Pure PPO learning (`-2346.13` $\rightarrow$ `-326.58` mean return at `41,164 steps/s`).
- **Line-Ending & Worker CSP Hygiene**:
  - Added `.gitattributes` (`* text=auto eol=lf`, binary media rules) and `worker-src 'self' blob:` CSP rules in `vite.config.ts` and `electron/main.cjs`.

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
