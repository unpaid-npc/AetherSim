# Changelog

All notable changes to **AetherSim** are documented in this file following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

---

## [Unreleased]
- Future Phases B & C (14-Module Ecosystem Expansion): FMI 3.0 / OMG DDS co-simulation, full N-body / J2–Jn interplanetary orbital propagator, offline CFD/FEA surrogates, independent AFSS monitor, and HIL FlatSat integration.

---

## [2.0.0] — 2026-11-26
### Added
- **True `1:1` Real-Scale Planetary Physics & Float64 Floating-Origin Rendering (`src/config/planets.ts`, `src/sim/FlightController.ts`, `src/scene/SceneManager.ts`, `src/scene/PlanetGlobe.ts`)**:
  - Upgraded Earth (`6,371 km`, `120 km` atmosphere, `200 km` LEO @ `~7,780 m/s`), Mars (`3,389.5 km`, `200 km` orbit), and Moon (`1,737.4 km`, `100 km` orbit) from `1:50` scale to true `1:1` planetary geometry & astrodynamics with `1x | 2x | 5x | 10x | 25x | 50x` Time Warp and jitter-free camera-relative rendering.
- **6 Geographically Located Earth Launch Sites & Living Environments (`src/config/launchSites.ts`, `src/scene/CoastalEnvironment.ts`, `src/scene/LaunchComplex.ts`, `src/scene/EarthTileOverlay.ts`, `src/scene/PbrTextureLoader.ts`, `src/shaders/oceanShader.ts`)**:
  - Added **Starbase Boca Chica**, **Kennedy Space Center LC-39A**, **Satish Dhawan Space Centre SHAR (Sriharikota)**, **Guiana Space Centre (Kourou)**, **Tanegashima Space Center**, and **Baikonur Cosmodrome Site 1** (oceanless Kazakh steppe + articulated 4-arm tulip stand), each rotating the `1:1` globe ENU frame, progressive 10m EOX Sentinel-2 / NASA GIBS regional tiles, site landmarks, and bundled 4K Poly Haven CC0 PBR ground/pad textures.
- **4 Selectable 3D Rockets & Autonomous Booster RTLS (`src/config/vehicles.ts`, `src/scene/RocketFleetBuilder.ts`, `src/scene/StarshipVehicle.ts`, `src/shaders/exhaustShader.ts`, `src/effects/PropulsionEffects.ts`)**:
  - Added **Starship + Super Heavy** (`121 m`, methalox, 18% RTLS catch), **Falcon 9 Block 5** (`70 m`, kerolox, folding carbon legs & 16% RTLS landing), **ISRO LVM3** (`43.5 m`, twin S200 solid strap-on booster separation + L110 + C25), and **NASA Saturn V** (`110.6 m`, S-IC roll pattern, 5× F-1, 5× J-2, Apollo CSM/LES), all verified to reach real `1:1` Earth LEO.
- **Explorable Satellites, ISS, Ground Tracks & Live CelesTrak SGP4 Tracking (`src/orbital/SatelliteCatalog.ts`, `src/orbital/CelesTrakService.ts`, `src/scene/OrbitalObjectManager.ts`, `src/ui/OrbitalDrawer.ts`)**:
  - Added `satellite.js` (`7.2.0`) SGP4 propagation with respectful CelesTrak OMM/GP live fetching (2-hour `localStorage` cache, 5s timeout, 15s rate-limited manual refresh, seamless offline fallback) and honest `LIVE` / `CACHED` / `SIMULATED` provenance + UTC timestamps.
  - Populated Earth orbit with **ISS (ZARYA)** (detailed modular 3D mesh integrated directly with `F4 Station`), **Tiangong**, **Hubble**, **Sentinel-2A**, **NOAA-20**, **GPS III SV01**, **GOES-16**, and a 6-unit **Starlink Demo Train**, plus simulated **Moon** (`Lunar Gateway`, `LRO`) and **Mars** (`Mars Transfer Station`, `MRO`) orbiters with 3D orbital paths, ±1-orbit Earth surface ground tracks (`R + 1,800 m`), viewport click picking, and close-up 3D inspection (`CameraDirector.focusOrbitalObject`).
- **Studio Aerospace Design System, Accessibility & Auto-Quality Guard (`src/ui/`, `src/styles/`, `src/ui/uiGuards.ts`)**:
  - Modularized the HUD into `TopBar`, `MissionDrawer`, `OrbitalDrawer`, `AIPilotDrawer`, `ResearchDrawer`, `CameraDock`, `FlightHud`, `ToastSystem`, and `HelpModal` with Earth-first startup, responsive breakpoints (`1024px`, `1280px`, `max-height: 768px`), mutually exclusive drawer slots, layered `Escape` dismissal, full ARIA attributes, OS + manual `Reduced Motion` parity, and an optional **`Auto Quality Guard`** (`HIGH → MED → LOW` on sustained `< 32 FPS` for `4 s`).
- **Refreshed `v2.0.0` Benchmarks, Profiling, Showcase Media & Test Suites (`src/__tests__/`, `results/v2_*`, `docs/media/`, `docs/BENCHMARKS.md`, `docs/PERFORMANCE_REPORT.md`)**:
  - Expanded Vitest suite to **12 files / 52 tests (`0` failures)** (`uiArchitecture`, `earthCoastline`, `cameraDirector`, `launchSitesAndFleet`, `orbitalCatalog`, plus zero-roll `0°..315°` camera, closed `200 km` orbit & far-epoch SGP4 ring continuity, `Max-Q < 35 km`, and Earth `LAUNCH` PPO warm-start regression suites), curated 14 `1600px` progressive JPEGs + 3 looping showcase GIFs (`< 10 MB` total), and regenerated `v2.0.0` benchmarks and `56.8–59.8 FPS` desktop GPU profiles.

### Fixed & Improved
- **Authoritative `F1–F8` Camera Director Overhaul & Zero-Roll OrbitControls (`src/scene/CameraDirector.ts`, `src/ui/CameraDock.ts`, `electron/main.cjs`)**:
  - Replaced laggy tween transitions with synchronous zero-lag state transitions, live Three.js world-matrix framing across pad/gravity-turn/orbit/boostback, capture-phase `F1–F8` hotkeys, synchronized `Ship | Booster` indicators, and near-plane protection (`near = 0.5 m`).
  - Eliminated horizontal-drag sinusoidal "figure-8" horizon roll in `F5 Free`, `F6 Map`, and orbital inspection by keeping `camera.up` strictly aligned with `(0, 1, 0)`, raised Mars prelaunch `F5 Free` camera by `+18 m` over foreground crater hills, and scaled `focusOrbitalObject()` distance proportionally to spacecraft radius (`ISS ~95 m`, `Hubble/Tiangong ~31–34 m`, `Sentinel-2A/GPS/GOES/Starlink ~15–24 m`).
- **Spaceport Pins, Orbital Ring Continuity, Terrain Blending, Pad Bloom & Satellite Lighting (`PlanetGlobe.ts`, `SatelliteCatalog.ts`, `OrbitalMechanics.ts`, `OrbitVisualizer.ts`, `OrbitalObjectManager.ts`, `TerrainSystem.ts`, `ProceduralTextures.ts`, `planetGlobeShader.ts`, `CoastalEnvironment.ts`, `LaunchComplex.ts`)**:
  - Replaced oversized fixed-radius spaceport spheres with crisp screen-space `THREE.Sprite` markers strictly hidden below `450 km` and capped `<= 0.014 * dist * tan(fov/2)`.
  - Fixed the far-epoch SGP4 `gstime()` modulo-wrap V-spike on 3D orbital rings, hardened `sampleOrbitPoints()` basis orthogonalization/loop closure, and enforced explicit `setDrawRange()` guards on all dynamic orbital lines.
  - Added dual-scale `37°`-rotated UV anti-tiling + FBM breakup, synchronized radial skirt feathering (`0.42–0.95 R`) completing fade-out strictly below `10 km` (Earth) and `18 km` (Moon/Mars) with globe cutout closure beforehand, eliminated the Moon center-pole normal vortex, applied planar world-space XZ UVs (`u = x/18, v = z/18`) to all pad aprons/decks, capped Moon/Mars pad albedo luminance `< 0.68` to prevent bloom halos, and added planetary Earthshine rim fill lighting on inspected satellites.
- **Aligned `LAUNCH` PPO Warm-Start & Accurate `Max-Q` Timing (`PPOTrainer.ts`, `RLEnvironment.ts`, `FlightController.ts`, `SceneManager.ts`)**:
  - Wired `isLaunchSuccess()` into `PPOTrainer.evaluateBatch()`, aligned classical launch guidance throttle with true `1:1` vehicle TWR (`getVehicleLaunchProfile()`), and extended launch `maxSteps` to `700` so Earth `LAUNCH` warm-start achieves `100% (5/5)` deterministic success while preserving `LANDING` anti-collapse.
  - Fixed `Max-Q` detection (`maxQPa > 8 kPa`, `200 m < altM < 35 km`, `dynamicPressurePa < 0.94 * maxQPa`) so `Max-Q` triggers accurately in the atmosphere rather than at `117 km` vacuum.
- **Packaging Metadata (`package.json`, `vite.config.ts`)**:
  - Added package `author` metadata and Vite 8 `satellite.js` pure-JS SGP4 resolution alongside `https://celestrak.org` CSP allow-listing for dev & prod Electron builds.

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
