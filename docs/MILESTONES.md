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

### Milestone 3 — Aerospace Research Workbench (`v0.5.0`) — **PLANNED**
- **Target Branch:** `milestone/m3-research-workbench`
- **Planned Scope:**
  - **Live Scientific Telemetry Plots:** Real-time altitude, velocity, dynamic pressure ($q$), attitude/AoA, propellant mass, and touchdown dispersion charts.
  - **Neural Network Activation Viewer:** Live layer activation & action-distribution visualizer synchronized with the active Milestone 2 PPO policy.
  - **Deterministic Fault Injection Panel:** Controlled injection of engine-out, TVC gimbal jam, RCS degradation, sensor bias, and wind-gust perturbations.
  - **Monte Carlo Batch Runner & Export:** Automated $N$-trial dispersion sweeps (`N >= 59 / 299`) with Wilks/Clopper-Pearson statistical summaries and **CSV / JSON** telemetry export.
  - **Cinematography & Procedural Audio:** GSAP camera cut presets (launch pad, booster sep, belly-flop, gear-cam) and procedural WebAudio Raptor rumble/sonic crack/RUD synthesis.
- **Exit Criteria:** Reproducible Monte Carlo CSV/JSON exports matching fixed seeds; zero main-thread frame drops during live plotting.

---

### Milestone 4 — Full Verification, Profiling & Windows `.exe` Packaging (`v1.0.0`) — **PLANNED**
- **Target Branch:** `milestone/m4-release-packaging`
- **Planned Scope:**
  - CPU/GPU frame-time & memory leak profiling across `LOW` / `MED` / `HIGH` presets and multi-planet switches (`dispose()` audits).
  - Automated end-to-end Electron verification (planet switching, launch, stage separation, manual RUD, autopilot landing, AI pilot).
  - Production Windows NSIS/portable `.exe` packaging via `electron-builder` with signed release artifacts and automated CI check pipeline.

---

### Phase B & Phase C — 14-Module Ecosystem Horizon (Post-`v1.0`) — **PLANNED ARCHITECTURE**
- **Phase B (Co-Simulation & Expanded Physics):** Spherical rotating-planet N-body orbital propagator, FMI 3.0 / FMU and OMG DDS interfaces, Mars-GRAM/US76 wind & thermal/TPS models, EKF navigation + convex powered-descent guidance, independent IIP corridor / AFSS monitor, and UQ-bounded PINN aerodynamic surrogates.
- **Phase C (HIL FlatSat & Research Benchmarks):** Deterministic RTOS/FPGA HIL FlatSat bridge with hardware bus emulation, closed-loop ECLSS models, and exploratory offline quantum/QAOA trajectory-optimization benchmarks compared against classical convex solvers.
