# AetherSim — Milestones & Git Branching Convention

This document defines the repository's Git workflow and tracks progress across **Milestones 0–4** (Phase A Desktop Simulator) and **Phases B/C** (14-Module Ecosystem Expansion).

---

## 1. Git Branching & Release Convention

| Branch / Tag | Purpose | Policy |
| :--- | :--- | :--- |
| `main` | Stable, verified release branch | Fast-forward or squash/merge only from verified milestone/release states; tagged `vX.Y.Z` |
| `develop` | Integration branch for active milestone work | Receives completed milestone or feature branches after `npm run test` & `npm run build` pass |
| `milestone/m<N>-<slug>` | Milestone integration branch (e.g., `milestone/m1-aethersim-3d-core`) | Groups cohesive stage deliverables before merging into `develop` and `main` |
| `feat/<scope>` / `fix/<scope>` | Short-lived task branches off `develop` or active `milestone/*` | Keep focused; rebase/merge cleanly; delete after merge |
| `vX.Y.Z` (annotated tags) | Immutable release markers on `main` | Created only after Vitest, TypeScript/Vite build, and Electron smoke test pass |

**Commit Style:** [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`).

---

## 2. Milestone Tracker

### Milestone 0 — Legacy 2D Python RL Baseline (`v0.1.0`) — **COMPLETE (Archived)**
- **Location:** [`archive/legacy-rl-2d/`](../archive/legacy-rl-2d/)
- **Scope:**
  - Stable-Baselines3 PPO training on Farama Gymnasium `LunarLander-v3` (Box2D) with custom reward shaping (`reward_wrapper.py`).
  - Deterministic `100`-seed evaluation suite (`benchmark.py`), multi-planet gravity/wind configuration (`planets.py`), and `pytest` unit tests (`archive/legacy-rl-2d/tests/`).
- **Verified Outcome:**
  - Standard environment (`benchmark_summary.json`): Random baseline `-193.03` mean reward (`0%` solved) $\rightarrow$ `ppo_1m_shaped` `+118.82` mean reward (`31%` solved $\ge 200$, `25%` between flags).
  - Cross-planet transfer (`planet_benchmark_summary.json`): Demonstrated policy degradation under Moon (`1.62 m/s²`), Mars (`3.73 m/s²`), and Earth (`9.81 m/s²`) gravity/wind shifts.

---

### Milestone 1 — 3D Desktop Foundation, Vehicles, FX & RUD Physics (`v0.2.0` → `v0.3.0`) — **COMPLETE & VERIFIED**
- **Branch:** `milestone/m1-aethersim-3d-core`
- **Stage 1 (Foundation):**
  - Electron + Vite + TypeScript + Three.js desktop shell with hardened `sandbox: true`, `contextIsolation: true`, and strict CSP.
  - Mars, Earth, and Moon environments with NASA physical constants (`src/config/planets.ts`), deterministic radial-LOD PBR terrain (`TerrainSystem.ts`, `noise.ts`), and custom GLSL Rayleigh/Mie sky + starfield + clouds (`atmosphereShader.ts`).
- **Stage 2 (Vehicles, Complexes & Flight Engine):**
  - 1:1 scale Starship (`50 m`) + Super Heavy (`71 m`) stack (`StarshipVehicle.ts`) with `33 + 6` Raptor bells, hot-staging interstage, grid fins, flaps, landing legs, and dynamic cryogenic frost.
  - Planet-specific launch pads, surface habitats/ISRU outposts, and orbiting space stations (`LaunchComplex.ts`).
  - Headless 60 Hz 6-DOF-inspired `FlightController.ts` supporting Launch, Stage Separation, and Propulsive Landing with Autopilot across all 3 worlds.
- **Stage 3 (FX, Manual Flight, RUD Physics, Rebrand & Docs):**
  - Universal RUD crash detection (`SURFACE_IMPACT`, `TIP_OVER`, `LAUNCH_TOWER_COLLISION`, `AERO_OVERSTRESS`) and 3D `ExplosionSystem.ts` (GLSL fireballs, shockwave, `160` debris, `240` smoke, flash, camera shake).
  - Manual TVC (`±15°`) / cold-gas RCS + toggleable SAS damping (`T`).
  - Pressure-reactive GLSL Raptor Mach-diamond plumes (`exhaustShader.ts`), cryo venting, ground dust/steam blast (`PropulsionEffects.ts`), `UnrealBloomPass` + Schlieren heat distortion (`PostProcessing.ts`), and `LOW`/`MED`/`HIGH` quality presets.
  - Clean rebrand to **AetherSim (`v0.3.0`)** and complete 5-file engineering documentation suite.
- **Verification Gate Results:**
  - `npm run test`: **3 test files, 10 tests passed (`0` failures)**.
  - `npm run build`: **`tsc --noEmit && vite build` passed (`0` errors)**.
  - `node scripts/launch-desktop.mjs --prod --smoke-test`: **`SMOKE_OK`**, `0` console/main errors, `0` warnings, title `"AetherSim — 3D Aerospace Launch & Landing Simulator"`, `1426×779` canvas, `22 FPS` at 4s hidden-window startup on `ANGLE (AMD Radeon(TM) Graphics Direct3D11)`.

---

### Milestone 2 — Live PPO Neural Network AI Engine & Learning-from-Crashes Sandbox (`v0.4.0`) — **COMPLETE & VERIFIED**
- **Branch:** `milestone/m2-ppo-neural-ai`
- **Implemented Scope:**
  - **Pure TypeScript Continuous PPO Core (`src/ai/`):**
    - `prng.ts`: Deterministic Mulberry32 PRNG + Box-Muller Gaussian sampling + Fisher-Yates shuffling.
    - `NeuralNetwork.ts`: Allocation-light `Float32Array` Actor-Critic MLP (`14 -> 64 tanh -> 64 tanh -> 3` + learnable `logStd`, `14 -> 64 tanh -> 64 tanh -> 1` critic) with orthogonal QR initialization, analytical backpropagation, Adam + global L2 gradient norm clipping (`maxGradNorm = 0.5`), `forwardWithActivations(obs)` snapshot hook, and versioned JSON checkpoint `serialize()` / `deserialize()`.
    - `RLEnvironment.ts`: Deterministic `20 Hz` (`dt = 0.05 s`, `3 × 1/60 s` physics sub-steps) RL environment wrapping `FlightController` across Mars, Earth, and Moon (`landing` & `launch`), 14D normalized observations, 3D continuous action mapping, optional domain randomization, and decomposed `{ distance, velocity, attitude, fuel, terminal }` rewards.
    - `PPOTrainer.ts`: Flat `RolloutBuffer`, GAE ($\gamma = 0.99, \lambda = 0.95$), clipped surrogate loss ($\epsilon = 0.2$), value loss, entropy bonus, Schulman approx-KL early stopping, optional opt-in Behavioral Cloning `warmStartFromGuidance()`, and `evaluateBatch()`.
    - `ppoWorker.ts` & `PPOWorkerClient.ts`: Dedicated Vite module Web Worker executing background turbo PPO updates off the WebGL thread (`worker-src 'self' blob:` CSP-enabled).
  - **Live 3D Integration & Neural AI HUD (`FlightController.ts`, `SceneManager.ts`, `main.ts`, `style.css`):**
    - Extended control modes to `AI (PPO) | PID AUTO | MANUAL`.
    - Added collapsible **NEURAL AI (PPO)** drawer with `LIVE TRAIN (3D)` (watch crashes/RUDs and weight updates live episode-by-episode), `TURBO TRAIN`, `PAUSE AI`, `EVAL (DET)`, `WARM-START`, `RESET WTS`, LR selector, `RAND: ON/OFF` domain randomization, `SAVE .JSON` / `LOAD .JSON` checkpoints, live actor outputs, and RL metrics.
    - Added `getLastAIActivations()` and `getTrainingHistory()` hooks on `SceneManager` for Milestone 3.
- **Verification Gate Results (`v0.4.0`):**
  - `npm run test`: **4 test files, 14 tests passed (`0` failures)** (`planets.test.ts`, `noise.test.ts`, `flightController.test.ts`, `ppoAI.test.ts`).
  - Headless Pure PPO Convergence (`ppoAI.test.ts`, Moon landing, seed `42`, `9,216` steps / `45` episodes): `preMeanReturn = -2346.13` $\rightarrow$ `postMeanReturn = -326.58` (`+2,019.55` improvement) at **`41,164 steps/s`**.
  - `npm run build`: **`tsc --noEmit && vite build` passed (`0` errors)** with clean Web Worker chunk (`dist/assets/ppoWorker-CXdYjvc7.js`, `51.71 kB`).
  - `node scripts/launch-desktop.mjs --prod --smoke-test`: **`SMOKE_OK`**, `0` warnings, `0` console/worker errors, `23 FPS`, `1426×779` canvas, `aiState: "idle"`.

---

### Milestone 3 — Aerospace Research Workbench, UX Overhaul, Cinematography & Audio (`v0.5.0`) — **COMPLETE & VERIFIED**
- **Branch:** `milestone/m3-research-workbench-and-ux`
- **Implemented Scope:**
  - **Milestone 2 Bug Fixes (`video_1.mp4`):**
    - `CameraDirector.reLockOnVehicle()` kills stale GSAP tweens and snaps/tracks Starship on every reset, planet/mission switch, and post-RUD `LIVE TRAIN` auto-reset.
    - Aligned `LAUNCH` PPO reward (`isLaunchSuccess` at `alt >= 1200 m`, `vy > 35 m/s`, `tilt < 35°`; early-tilt/tower-drift penalties; termination at `tilt > 65°`) preventing sideways reward hacking.
    - Redesigned SpaceX-webcast HUD with plain-English guided 3-step AI deck (`1. WATCH AI LEARN (3D)`, `2. FAST TRAIN (WORKER)`, `3. FLY TRAINED AI`), hover tooltips, two-click `RESET AI BRAIN` confirmation, and `?` Help modal.
    - Upgraded cryo/dust sprites to `128×128` multi-puff feathered textures and RUD fireballs to subdivision-5 FBM-displaced spheres with view-normal edge alpha feathering.
  - **Aerospace Research Lab (`src/research/`, `src/sim/FaultInjector.ts`):**
    - `TelemetryCharts.ts`: 4 high-DPI HTML5 canvas streaming charts (`Alt & Vy`, `q & G-Load`, `Tilt & Throttle`, `PPO Learning Curve`) throttled to `~16 Hz`.
    - `NeuralNetVisualizer.ts`: Live `14 → 64 → 64 → 3` Actor activation + `V(s)` canvas visualizer.
    - `FaultInjector.ts`: Programmable thrust loss (`0–50%` at configurable altitude), density-scaled crosswind (`0–40 m/s`, strictly `0` on Moon vacuum), IMU pitch/roll bias & noise (`getSensedTelemetry()` isolated from physics truth), and TVC lag toggle.
    - `MonteCarloRunner.ts`: Off-thread Worker `20 / 50 / 100`-trial dispersion runner for `AI NEURAL` and `PID AUTO` with exact 95% Clopper-Pearson binomial confidence intervals.
    - `DataExporter.ts`: One-click Flight Telemetry `.csv`, RL Training History `.csv`, and full reproducible Experiment Bundle `.json` export.
  - **GSAP Cinematography & Procedural Web Audio (`CameraDirector.ts`, `SoundEngine.ts`):**
    - Multi-camera presets (`C1 PAD`, `C2 DRONE`, `C3 ENGINE`, `C4 STATION`, `C5 ORBIT`, `F1–F5`) + `AUTO` director timeline mode.
    - Zero-asset procedural Web Audio synthesis (atmosphere-coupled Raptor roar, cryo vent hiss, cold-gas RCS pulses, sub-bass RUD boom).
- **Verification Gate Results (`v0.5.0`):**
  - `npm run test`: **5 test files, 18 tests passed (`0` failures)** (`planets.test.ts`, `noise.test.ts`, `flightController.test.ts`, `ppoAI.test.ts`, `researchWorkbench.test.ts`), PPO throughput **`43,639 steps/s`**.
  - `npm run build`: **`tsc --noEmit && vite build` passed (`0` errors)**, `46` modules bundled including `dist/assets/ppoWorker-Bf-YmtTa.js` (`58.10 kB`).
  - `node scripts/launch-desktop.mjs --prod --smoke-test`: **`SMOKE_OK`**, `0` warnings, `0` console/worker/audio errors, `24 FPS`, `1426×779` canvas, `cameraPreset: "orbit"`, `audioMuted: true`.

---

### Milestone 4 — Final Verification, Measured Profiling, CI & Windows Packaging (`v1.0.0`) — **COMPLETE & VERIFIED**
- **Branch:** `milestone/m4-verification-profiling-and-release`
- **Implemented Scope:**
  - **Multi-Planet Benchmark Harness (`src/research/benchmarkHarness.ts`, `scripts/run-benchmark.mjs`):**
    - Added `npm run benchmark` running `20` paired deterministic domain-randomized `landing` trials (`seeds 42..61`) across Mars, Earth, and Moon (nominal + fault stress tests) comparing `untrained_ppo`, `ppo_scratch`, `ppo_trained` (BC warm-start + `8,192` PPO steps), and `pid_baseline`.
    - Saved reproducible raw results and report to [`results/v1_benchmark.json`](../results/v1_benchmark.json), [`results/v1_benchmark.csv`](../results/v1_benchmark.csv), and [`docs/BENCHMARKS.md`](BENCHMARKS.md).
  - **Automated Desktop GPU & FPS Profiler (`scripts/profile-desktop.mjs`, `electron/main.cjs`, `PostProcessing.ts`):**
    - Fixed `PostProcessingPipeline` (`renderer.info.autoReset = false` + explicit `reset()`) so draw calls and triangle counts reflect full scene + composer passes rather than the final fullscreen quad (`1`).
    - Added `window.__AETHERSIM_PROFILER__` (`src/main.ts`, `src/types/global.d.ts`) and `ELECTRON_PROFILE=1` runner sampling all 9 `(Mars | Earth | Moon) × (LOW | MED | HIGH)` configurations over `3,000 ms` rAF windows, saving [`results/v1_performance_profile.json`](../results/v1_performance_profile.json) and [`docs/PERFORMANCE_REPORT.md`](PERFORMANCE_REPORT.md).
  - **GitHub Actions CI (`.github/workflows/ci.yml`):**
    - Added automated workflow running `npm ci`, `npm run test`, and `npm run build` on `push` and `pull_request` (`main`, `develop`).
  - **Windows Desktop Packaging & App Icons (`scripts/generate-icon.mjs`, `package.json`):**
    - Generated [`build/icon.png`](../build/icon.png) (`512×512`) and multi-size [`build/icon.ico`](../build/icon.ico) (`256, 64, 32, 16 px`).
    - Configured `electron-builder` (`npm run dist:win`, `npm run dist:win:dir`) producing standalone Windows x64 portable executable `release/AetherSim-1.0.0-win-x64-portable.exe` (strictly gitignored under `release/`).
  - **Release Finalization:** Bumped `package.json` and in-app UI/export tags to `v1.0.0` and updated [`README.md`](../README.md), [`docs/MILESTONES.md`](MILESTONES.md), and [`CHANGELOG.md`](../CHANGELOG.md).
- **Verification Gate Results (`v1.0.0`):**
  - `npm run test`: **5 test files, 18 tests passed (`0` failures)** in `4.24 s` (`ppoAI.test.ts` throughput **`39,128 steps/s`**, `preMeanReturn = -2293.23` $\rightarrow$ `postMeanReturn = -601.77`).
  - `npm run build`: **`tsc --noEmit && vite build` passed (`0` errors)** across `46` modules in `468 ms`.
  - `npm run benchmark`: Completed in `25,388 ms` (`pid_baseline` `100.0%` nominal landing on Mars/Earth/Moon; measurable return progression from `untrained_ppo` $\rightarrow$ `ppo_scratch` $\rightarrow$ `ppo_trained`).
  - `npm run profile:desktop`: **`PROFILE_OK`**, `0` errors, `0` warnings; `57.1–60.3 FPS` (`108–168` draw calls, `61,692–68,243` triangles, `20.7 MB` JS heap) at `1426×779` on `AMD Ryzen 5 5600H / Radeon Graphics Direct3D11`.
  - `npm run dist:win`: Built `release/AetherSim-1.0.0-win-x64-portable.exe` (`112,092,430 bytes` / **`106.90 MB`**) and `release/win-unpacked/AetherSim.exe`; packaged smoke verification (`ELECTRON_SMOKE_TEST=1`) returned **`SMOKE_OK`**, exit code `0`, `0` errors/warnings, `123` draw calls, `62,759` triangles.

---

### Hotfix `v1.0.1` — AI Policy Stability, Session Worker Sync, HUD Clarity & Visual Showcase (`v1.0.1`) — **COMPLETE & VERIFIED**
- **Branches:** `hotfix/v1.0.1-ai-stability-and-clarity` & `docs/v1.0.1-media-and-readme-sync`
- **Implemented Scope:**
  - **PPO Policy Collapse & Gradient Isolation (`NeuralNetwork.ts`, `PPOTrainer.ts`):** Decoupled Actor (`stepAdamActor`) and Critic (`stepAdamCritic`) BC updates with 1-round DAgger pass, lowered post-warm-start exploration (`logStd = -1.6`), cleared Adam momentum (`resetOptimizerState()`), constrained fine-tuning LR/KL/entropy, and added deterministic 5-seed `BestBrainSummary` + collapse recovery guard.
  - **Session Worker Sync & `padDeckY` Parity (`ppoWorker.ts`, `PPOWorkerClient.ts`, `FlightController.ts`, `RLEnvironment.ts`, `SceneManager.ts`):** Added incrementing `sessionId` staleness filtering across all worker messages, propagated exact planet `padDeckY` in `configureRLSpawn()`, and aligned live 3D landing max steps (`700`).
  - **Crystal-Clear AI HUD & Visual Showcase (`src/main.ts`, `src/style.css`, `docs/media/`, `README.md`):** Added color-coded pulsing AI status banner, `Brain Status` scorecard, version sync to `package.json` (`1.0.1`), 6 web-optimized `1600×825` screenshots, and `4.98 MB` Moon propulsive landing GIF under [`docs/media/`](media/).
- **Verification Gate Results (`v1.0.1`):**
  - `npm run test`: **5 test files, 19 tests passed (`0` failures)** (`ppoAI.test.ts`: Earth landing warm-start **`100%` safe / `60%` nominal (`257.1` return)** preserved after `4,096` PPO steps).
  - `npm run build`: **`tsc --noEmit && vite build` passed (`0` errors)** across `47` modules in `429 ms`.
  - `node scripts/launch-desktop.mjs --prod --smoke-test`: **`SMOKE_OK`**, `version: "1.0.1"`, `0` errors, `0` warnings.

---

### Milestone 5 — Planet-Scale Worlds, Seamless Surface-to-Orbit Transition & 3D Orbital Insertion (`v1.1.0`) — **COMPLETE & VERIFIED**
- **Branch:** `milestone/m5-planet-scale-and-orbit`
- **Implemented Scope:**
  - **Stage 5A (Planet-Scale Globes & Google-Earth Zoom):**
    - Added `1:50` planetary scale configs (`src/config/planets.ts`: Moon `34,748 m`, Mars `67,790 m`, Earth `127,420 m`), radial curvature offset (`computeCurvedSurfaceDrop`), zenith-aligned 3D `PlanetGlobe.ts` + offline procedural PBR textures (`PlanetGlobeTextures.ts`, `earthGeography.ts`), Fresnel `planetLimbShader.ts`, and adaptive `CameraDirector` surface-to-globe zoom.
  - **Desktop Dev-Mode Black-Screen Hotfix (`vite.config.ts`, `electron/main.cjs`, `src/main.ts`, `SceneManager.ts`):**
    - Ignored `venv/` (`29,927` files) and heavy artifacts in Vite's Chokidar watcher + bypassed PostCSS probing (cutting CSS transform from `8,746 ms` to `92 ms`), added Chromium `webRequest.onErrorOccurred` + transient loopback reload recovery, fail-safe DOM startup error overlay, and upgraded `--smoke-test` with backbuffer pixel luminance verification (`gl.readPixels`), `#hud-root` checks, and `bootMs` timing.
  - **Stage 5B (Visual Seam Fixes, 3D Spherical Orbit Insertion, Path Visualizer & `C6 MAP`):**
    - Replaced jagged coastal rasterization with anti-aliased quadratic coastline smoothing + bilinear coastal shelf sampling, `6–20 km` `TerrainSystem` opacity cross-fade, and `4–14 km` Earth cloud-shell ramp with fog attenuation above `3.5 km`.
    - Built pure Keplerian astrodynamics (`src/sim/OrbitalMechanics.ts`) and upgraded `FlightController.ts` `launch` mode to spherical Velocity-Verlet gravity ($\mu = g_0 R_{\text{sim}}^2$), `1x | 2x | 5x | 10x` Time Warp, and closed-loop gravity-turn → stage-sep → `ORBIT_INSERTION` → `COAST_TO_AP` → `CIRCULARIZATION` → `ORBIT_ACHIEVED` guidance.
    - Created `OrbitVisualizer.ts` (dashed Target Parking Orbit Ring, color-coded Keplerian arc, adaptive trail ribbon, constant-screen-scale `SHIP`/`AP`/`PE`/`PAD` markers), `C6 MAP` (`F6`) camera view, `PATH: ON/OFF` toggle, Time Warp buttons (`[`/`]`), orbital HUD strip (`Ap`/`Pe`/`Ecc`/target), and `v1.1.0` version sync.
- **Verification Gate Results (`v1.1.0`):**
  - `npm run test`: **7 test files, 27 tests passed (`0` failures)** (including Mars `Ap=22.35km, Pe=19.00km, e=0.0189`, Earth `Ap=41.80km, Pe=35.61km, e=0.0186`, Moon `Ap=22.14km, Pe=13.57km, e=0.0815` headless Launch-to-Orbit insertion proofs + all 23 prior tests intact).
  - `npm run build`: **`tsc --noEmit && vite build` passed (`0` errors)** across `53` modules in `560 ms`.
  - `node scripts/launch-desktop.mjs --smoke-test` (Dev): **`SMOKE_OK`**, `bootMs: 261 ms`, `hudChildren: 4`, `24 FPS`, `124` draw calls, `70,551` triangles, `canvasNonBlackPct: 100%`, `errors: []`.
  - `node scripts/launch-desktop.mjs --prod --smoke-test` (Prod): **`SMOKE_OK`**, `bootMs: 260 ms`, `hudChildren: 4`, `24 FPS`, `124` draw calls, `70,551` triangles, `canvasNonBlackPct: 100%`, `errors: []`.

---

### Phase B & Phase C — 14-Module Ecosystem Horizon (Post-`v1.0`) — **PLANNED ARCHITECTURE**
- **Phase B (Co-Simulation & Expanded Physics):** Spherical rotating-planet N-body orbital propagator, FMI 3.0 / FMU and OMG DDS interfaces, Mars-GRAM/US76 wind & thermal/TPS models, EKF navigation + convex powered-descent guidance, independent IIP corridor / AFSS monitor, and UQ-bounded PINN aerodynamic surrogates.
- **Phase C (HIL FlatSat & Research Benchmarks):** Deterministic RTOS/FPGA HIL FlatSat bridge with hardware bus emulation, closed-loop ECLSS models, and exploratory offline quantum/QAOA trajectory-optimization benchmarks compared against classical convex solvers.
