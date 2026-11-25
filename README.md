# AetherSim

**AetherSim (`v1.1.0`)** is a real-time 3D aerospace launch, propulsive landing, spherical orbital-insertion, live neural-network RL, and flight-research desktop simulator built with **Electron**, **Three.js**, **TypeScript**, **GLSL**, **GSAP**, and **Web Audio**.

> [!NOTE]
> **Phase A Runnable Desktop Simulator (`v1.1.0`) vs. Phase B/C Ecosystem Architecture:** What runs today (`npm run desktop`, `npm run dist:win`) is the complete, verified **Phase A Desktop Simulator** covering **Milestones 1–5** (`v0.2.0` → `v1.1.0`). The repository also documents a **14-Module Aerospace Simulation Ecosystem Reference Architecture** ([`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)) guiding future Phases B & C. Every section below explicitly separates **implemented & verified** features from **planned** ecosystem work.

---

## Visual Showcase

<p align="center">
  <img src="docs/media/moon-landing-demo.gif" alt="AetherSim Moon Shackleton Crater multi-camera propulsive landing demo" width="720" />
</p>
<p align="center">
  <em>Moon Shackleton Crater propulsive landing showcase at 60 FPS: <code>C3 ENGINE</code> aft nozzle view &rarr; <code>C5 ORBIT</code> final descent, lunar regolith blast cloud, landing leg deployment, and <code>NOMINAL LANDING</code> touchdown.</em>
</p>

<!-- Optional: paste a GitHub drag-and-drop HD MP4 user-attachments URL below for native inline 1080p video playback -->

| Mars Prelaunch Complex (`3.72 m/s²`) | Earth Starbase Orbital Launch Mount (`9.81 m/s²`) |
| :---: | :---: |
| ![Mars Prelaunch](docs/media/mars-prelaunch.jpg) | ![Earth Prelaunch](docs/media/earth-prelaunch.jpg) |
| *Jezero / Arcadia octagonal blast deck, servicing tower, cryogenic venting, and geodesic ISRU outpost at 60 FPS.* | *Boca Chica `18 m` OLM, `145 m` Mechazilla tower with chopstick catch arms, umbilical, and cryo tank farm at 60 FPS.* |

| Moon Shackleton South Pole (`1.63 m/s²`) | Earth Full-Stack Liftoff (`T+00:04.5`) |
| :---: | :---: |
| ![Moon Prelaunch](docs/media/moon-prelaunch.jpg) | ![Earth Liftoff](docs/media/earth-liftoff.jpg) |
| *Sintered lunar pad with `360°` ejecta blast berm, Artemis solar outpost on crater rim, and hard-vacuum starfield.* | *33-Raptor Mach-diamond plume, ground steam/dust cloud, retracted umbilical (`86.9 m`, `1.86 g`), and `PRE-TRAINED` AI status.* |

| Earth Hot-Stage Separation (`T+00:27.4`) | Moon Propulsive Flip-Burn (`ALT 66.5 m`) |
| :---: | :---: |
| ![Earth Stage Separation](docs/media/earth-stage-sep.jpg) | ![Moon Landing](docs/media/moon-landing.jpg) |
| *Ship vacuum burn into `ORBIT_INSERTION` (`2.86 km`, `225.9 m/s`, `2.12 g`) above detached Super Heavy booster.* | *Shackleton final approach (`FLIP_BURN`, `-10.8 m/s`, `0.24 g`) with lunar vacuum expansion plume and `PRE-TRAINED` scorecard.* |

---

## Implemented & Verified Capabilities (`AetherSim v1.1.0`)

### 1. Multi-Planet Physics, 1:50 Planet-Scale Globes & Surface-to-Space Transition (`src/config/planets.ts`, `src/scene/`)
Three planetary launch & landing complexes parameterized with NASA Planetary Fact Sheet surface constants and `1:50` interactive planetary radii (`Moon: 34,748 m`, `Mars: 67,790 m`, `Earth: 127,420 m`) so surface-to-orbit ascents play smoothly in ~`175–275 s` real-time (or `18–28 s` at `10x` Time Warp):

| World | Site / Complex | Surface Gravity | Surface Pressure | Near-Surface Density | Scale Height | `1:50` Radius / Target Orbit | Atmosphere / Global Geography |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Mars** | Jezero / Arcadia (`18.38° N, 77.58° E`) | `3.721 m/s²` | `0.00636 bar` | `0.020 kg/m³` | `11.1 km` | `67,790 m` / `22 km` | Thin CO₂ (`0.6%` Earth), Valles Marineris, Olympus Mons, polar ice caps |
| **Earth** | Starbase Boca Chica (`25.997° N, 97.156° W`) | `9.807 m/s²` | `1.01325 bar` | `1.225 kg/m³` | `8.5 km` | `127,420 m` / `42 km` | Dense N₂/O₂ (`1.01 bar`), anti-aliased continents, oceans, cloud shell & night lights |
| **Moon** | Shackleton South Pole (`89.5° S, 0.0° E`) | `1.625 m/s²` | `0.00000 bar` | `0.000 kg/m³` | `0.0 km` | `34,748 m` / `14 km` | Hard vacuum, lunar maria, Tycho/Copernicus ray craters, zenith stars |

- **Seamless Local-to-Globe Curvature & Real 4K Satellite Globes (`TerrainSystem.ts`, `PlanetGlobe.ts`, `PlanetGlobeTextures.ts`, `shaders/planetGlobeShader.ts`)**: Spherically curved radial-LOD terrain (`0–28 km` local horizon, `65 m` flat launch apron, `220` instanced boulders) tinted to the launch site's real RGB and radially feathered into zero-pinch icosahedral `4096×2048` NASA-derived satellite globes (Earth Blue Marble + Ocean Specular + City Lights + animated global clouds; Mars Viking/MOLA; Moon LROC WAC) with atmospheric Fresnel limb glow (`planetLimbShader.ts`) and Google-Earth-style `C5 ORBIT` zoom (`F5`). *(4K texture attribution: Solar System Scope CC-BY 4.0 NASA Visible Earth / Viking-MOLA / LROC datasets; see [`public/textures/planets/ATTRIBUTION.md`](public/textures/planets/ATTRIBUTION.md).)*
- **Custom Sky Shaders & IBL (`shaders/atmosphereShader.ts`, `SceneManager.ts`)**: Rayleigh wavelength gradient, Henyey-Greenstein Mie forward scattering, dual-layer starfield, and live PMREM reflections for brushed stainless steel.

### 2. 1:1 Scale SpaceX Starship + Super Heavy Stack & Launch Complexes
- **Vehicle Assembly (`StarshipVehicle.ts`)**:
  - **Super Heavy Booster (`71 m` tall, `4.5 m` radius)**: Brushed stainless hull, vented hot-staging interstage (`24` instanced struts), `4` actuated grid fins, `33`-Raptor cluster (`30` outer/middle + `3` gimbaling centers), and dynamic LOX/CH₄ cryogenic frost sleeve.
  - **Starship Upper Stage (`50 m` tall)**: Split hexagonal TPS windward heat shield + brushed stainless leeward hull, `2` forward + `2` aft flaps, `6`-Raptor aft bay (`3` vacuum + `3` sea-level gimbaling), and `4` deployable landing legs.
- **Planet-Specific Complexes & Orbital Stations (`LaunchComplex.ts`)**:
  - **Earth**: `18 m` OLM with `20` hold-down clamps, flame trench, `145 m` Mechazilla tower + chopstick catch arms + retracting QD arm, cryo tank farm, and LEO ISS-inspired station.
  - **Mars**: Octagonal sintered-regolith blast deck, servicing gantry, geodesic habitat & ISRU Sabatier propellant plant (`12` instanced solar panels), and centrifugal Mars Orbital Transfer Station.
  - **Moon**: Sintered landing pad with `360°` regolith blast berm, servicing gantry, Artemis-style pressurized surface outpost with vertical polar solar towers, and Lunar Gateway-inspired station.

### 3. Spherical Central-Body Orbital Launch, Propulsive Landing, Explosions & Post-Processing
- **Orbital Astrodynamics & 60 Hz Flight Engine (`src/sim/OrbitalMechanics.ts`, `src/sim/FlightController.ts`)**:
  - **Spherical Central-Body Launch (`launch` mode):** Velocity-Verlet 2-body gravity ($\mu = g_0 R_{\text{sim}}^2$) around planet center `(0, -simRadiusM, 0)`, vacuum density cutoff above `atmosphereTopM`, `1x | 2x | 5x | 10x` Time Warp (`[` / `]`), live Keplerian elements (`Ap`, `Pe`, `e`, orbital velocity & period), and an end-to-end **`PID AUTO` Orbit Insertion Autopilot** (`COUNTDOWN` → `LIFTOFF` → `ASCENT` gravity turn → `STAGE_SEP` → `ORBIT_INSERTION` → `COAST_TO_AP` → `CIRCULARIZATION` → `ORBIT_ACHIEVED`).
  - **3D Orbital Path Visualizer (`src/scene/OrbitVisualizer.ts`):** Toggleable (`PATH: ON/OFF`) dashed cyan Target Parking Orbit Ring, color-coded live Keplerian trajectory arc (amber suborbital / cyan transfer / emerald `ORBIT ACHIEVED`), adaptive spacecraft flight trail, constant-screen-size `SHIP`, `AP`, `PE`, and `PAD` markers, and dedicated **`C6 MAP` (`F6`)** orbital overview camera.
  - **Propulsive Landing & Controls:** Deterministic `60 Hz` (`dt = 1/60 s`) landing dynamics and `AI NEURAL | PID AUTO | MANUAL` (`±15°` TVC gimbal, cold-gas RCS, `T` SAS angular damping) across all 3 worlds.
- **Universal RUD & Verdict Classification**: Detects `LAUNCH_TOWER_COLLISION`, `AERO_OVERSTRESS` (`q > 45 kPa` at `AoA > 34°`), `SURFACE_IMPACT`, and `TIP_OVER`; classifies touchdowns as `NOMINAL LANDING`, `HARD LANDING`, or `CRASH_RUD`.
- **GLSL Propulsive Plumes & Explosions (`shaders/exhaustShader.ts`, `PropulsionEffects.ts`, `ExplosionSystem.ts`, `PostProcessing.ts`)**:
  - Ambient-pressure-reactive Mach-diamond exhaust plumes, `128×128` multi-puff cryo/dust blast sprites, and cold-gas RCS cones.
  - Subdivision-5 FBM-displaced RUD fireballs with radial edge feathering, expanding shockwave ring, `160` tumbling burning debris fragments, `240` smoke particles, point-light flash, and distance-attenuated shake.
  - `EffectComposer` with `UnrealBloomPass` + custom screen-space **Schlieren heat-shimmer** pass scaled by `LOW` (direct render, `1024` shadows), `MED`, and `HIGH` presets.

### 4. Pure-TypeScript Continuous PPO Neural Network Engine (`src/ai/`)
- Zero external ML dependencies: deterministic `Float32Array` Actor-Critic MLP (`14 -> 64 tanh -> 64 tanh -> 3` + learnable `logStd`, plus `14 -> 64 tanh -> 64 tanh -> 1` critic) using orthogonal QR initialization, analytical backpropagation, Adam + global L2 gradient clipping (`0.5`), and Mulberry32/Box-Muller seeded PRNG (`prng.ts`).
- **Two Training Modes in the App**:
  1. **Watch AI Learn (3D):** Visualizes live rollouts episode-by-episode in 3D, crashing/exploding with RUDs and updating policy weights after every crash/reset while automatically re-locking the camera.
  2. **Fast Train (Worker):** Runs `PPOTrainer` inside a dedicated Vite module Web Worker (`ppoWorker.ts`) off the WebGL thread, plus optional Behavioral Cloning `WARM-START`, domain randomization toggle, two-click `RESET AI BRAIN` safety confirmation, and `.json` checkpoint save/load.

### 5. Aerospace Research Workbench, GSAP Cinematography & Procedural Web Audio
- **Research Workbench Drawer (`src/research/`, `src/sim/FaultInjector.ts`)**:
  1. **Telemetry Plots (`TelemetryCharts.ts`)**: 4 high-DPI HTML5 canvas streaming charts (`Alt & Vy`, `q & G-Load`, `Tilt & Throttle`, `PPO Learning Curve`) throttled to `~16 Hz`.
  2. **Neural Net Visualizer (`NeuralNetVisualizer.ts`)**: Live `14 → 64 → 64 → 3` Actor activations and Critic `V(s)` readout.
  3. **Fault Injection (`FaultInjector.ts`)**: Programmable thrust loss (`0–50%` at configurable altitude), density-scaled crosswind (`0–40 m/s`, strictly zero in Moon vacuum), IMU pitch/roll bias & noise via `getSensedTelemetry()`, and TVC lag toggle.
  4. **Monte Carlo Evaluator (`MonteCarloRunner.ts`)**: Off-thread `20 / 50 / 100`-run batch evaluator comparing `AI NEURAL` and `PID AUTO` with exact 95% Clopper-Pearson binomial confidence intervals.
  5. **Data Export (`DataExporter.ts`)**: One-click Flight Telemetry `.csv`, RL Training History `.csv`, and full reproducible Experiment Bundle `.json` export.
- **Cinematography & Sound (`CameraDirector.ts`, `SoundEngine.ts`)**: GSAP camera presets (`C1 PAD`, `C2 DRONE`, `C3 ENGINE`, `C4 STATION`, `C5 ORBIT`, `C6 MAP` / `F1–F6`) + `AUTO` director timeline, paired with zero-asset Web Audio synthesis (atmosphere-coupled Raptor roar, cryo hiss, RCS pulses, sub-bass RUD boom).

---

## Verified Build, Test & Packaging Checks (`v1.1.0`)

Measured directly on this repository for `v1.1.0`:

| Check | Command | Verified Result |
| :--- | :--- | :--- |
| **Vitest Unit, Orbital & RL Suite** | `npm run test` | **Passed (`7` files, `27` tests, `0` failures)** (`planets`, `noise`, `planetScale`, `orbitalMechanics`, `flightController`, `researchWorkbench`, `ppoAI`: 3-planet launch-to-orbit circularization `Mars Ap=22.35km/Pe=19.00km/e=0.0189`, `Earth Ap=41.80km/Pe=35.61km/e=0.0186`, `Moon Ap=22.14km/Pe=13.57km/e=0.0815`; Earth landing warm-start `100%` safe / `60%` nominal) |
| **TypeCheck & Vite Production Build** | `npm run build` | **Passed (`0` errors)**; `53` modules transformed in `560 ms` (`dist/index.html`, `ppoWorker-BLuphEl-.js` `73.21 kB`, `index-DgpBH_pl.js` `952.13 kB`, `index-DMBfzP0s.css` `10.00 kB`) |
| **GitHub Actions CI** | `.github/workflows/ci.yml` | Runs `npm ci`, `npm run test`, and `npm run build` on `push` / `pull_request` (`main`, `develop`) |
| **Electron Dev Desktop Smoke Check** | `node scripts/launch-desktop.mjs --smoke-test` | **`SMOKE_OK`**, `bootMs: 261 ms`, `hudChildren: 4`, `1426×779`, `24 FPS`, `124` draw calls, `70,551` triangles, `canvasNonBlackPct: 100%`, **`version: "1.1.0"`**, `0` errors |
| **Electron Prod Desktop Smoke Check** | `node scripts/launch-desktop.mjs --prod --smoke-test` | **`SMOKE_OK`**, `bootMs: 260 ms`, `hudChildren: 4`, `1426×779`, `24 FPS`, `124` draw calls, `70,551` triangles, `canvasNonBlackPct: 100%`, **`version: "1.1.0"`**, `0` errors |
| **Windows Portable Desktop Build** | `npm run dist:win` | Packaged & smoke-verified `AetherSim-1.0.0-win-x64-portable.exe` (`106.90 MB`) in `v1.0.0`; rebuild `v1.1.0` portable `.exe` anytime via `npm run dist:win` |

---

## Multi-Planet AI (PPO) vs. PID Benchmark Summary

Measured directly by `npm run benchmark` ([`scripts/run-benchmark.mjs`](scripts/run-benchmark.mjs), total wall time `25,388 ms`) across `20` paired deterministic domain-randomized `landing` trials per condition (seeds `42..61`), with full data in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md), [`results/v1_benchmark.json`](results/v1_benchmark.json), and [`results/v1_benchmark.csv`](results/v1_benchmark.csv):

| Planet | Condition | Policy | Success % (95% CI) | Crash % | Mean ± Std Return | Mean TD \|vy\| | Mean Offset |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Mars** | Nominal | `untrained_ppo` | `0.0%` (`0.0–16.8%`) | `0.0%` | `-2336.7 ± 100.5` | N/A | N/A |
| **Mars** | Nominal | `ppo_scratch` (`8,192` steps) | `0.0%` (`0.0–16.8%`) | `0.0%` | `-1011.8 ± 530.8` | N/A | N/A |
| **Mars** | Nominal | `ppo_trained` (BC + `8,192` PPO) | `0.0%` (`0.0–16.8%`) | `100.0%` | `-117.4 ± 22.0` | `27.05 m/s` | `39.1 m` |
| **Mars** | Nominal | `pid_baseline` | **`100.0%`** (`83.2–100.0%`) | `0.0%` | **`+348.6 ± 11.9`** | `1.40 m/s` | `0.1 m` |
| **Earth** | Nominal | `untrained_ppo` | `0.0%` (`0.0–16.8%`) | `0.0%` | `-1511.5 ± 605.8` | N/A | N/A |
| **Earth** | Nominal | `ppo_scratch` (`8,192` steps) | `0.0%` (`0.0–16.8%`) | `100.0%` | `-276.1 ± 64.7` | `18.36 m/s` | `170.8 m` |
| **Earth** | Nominal | `ppo_trained` (BC + `8,192` PPO) | `0.0%` (`0.0–16.8%`) | `95.0%` | `-111.4 ± 36.0` | `9.21 m/s` | `32.6 m` |
| **Earth** | Nominal | `pid_baseline` | **`100.0%`** (`83.2–100.0%`) | `0.0%` | **`+356.8 ± 10.5`** | `1.40 m/s` | `0.0 m` |
| **Moon** | Nominal | `untrained_ppo` | `0.0%` (`0.0–16.8%`) | `0.0%` | `-2355.2 ± 134.2` | N/A | N/A |
| **Moon** | Nominal | `ppo_scratch` (`8,192` steps) | `0.0%` (`0.0–16.8%`) | `0.0%` | `-1969.5 ± 399.6` | N/A | N/A |
| **Moon** | Nominal | `ppo_trained` (BC + `8,192` PPO) | `0.0%` (`0.0–16.8%`) | `100.0%` | `-108.2 ± 19.1` | `31.22 m/s` | `30.7 m` |
| **Moon** | Nominal | `pid_baseline` | **`100.0%`** (`83.2–100.0%`) | `0.0%` | **`+330.5 ± 13.5`** | `1.40 m/s` | `3.0 m` |

> Under the **Fault Stress Test** (`15%` thrust loss + `15 m/s` crosswind on Mars/Earth; `15%` thrust loss in Moon vacuum), `pid_baseline` maintained `100.0%` nominal landing on Mars (`+341.2 ± 10.2`, `1.61 m/s` tdVy, `0.2 m` offset) and Moon (`+322.0 ± 16.5`, `1.49 m/s`, `4.9 m` offset), while achieving `0.0%` crash / `+146.5 ± 6.6` return (`1.93 m/s`, `11.2 m` lateral offset) on Earth due to the crosswind pushing touchdowns outside the strict pad margin. Short-budget (`8,192`-step) `ppo_trained` demonstrates rapid return improvement over random initialization (`-2355 → -108`) while still trailing precision analytical PID terminal flare—use `TURBO TRAIN` (`25,000–100,000+` steps) for extended policy refinement.

---

## Measured Desktop GPU & FPS Profile (`npm run profile:desktop`)

Measured directly inside the Electron app across `3,000 ms` rAF sampling windows per `(Planet × Quality)` configuration ([`docs/PERFORMANCE_REPORT.md`](docs/PERFORMANCE_REPORT.md), [`results/v1_performance_profile.json`](results/v1_performance_profile.json)):

- **Test Hardware Scope:** `Windows_NT 10.0.26300 (x64)` · `AMD Ryzen 5 5600H` (`12` logical cores) · `7.3 GB` RAM · `ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)` · `1426×779` viewport. *(Measured on integrated GPU hardware; not claimed as universal across all systems.)*

| Planet | `LOW` FPS (p50 / p95 ms) | `MED` FPS (p50 / p95 ms) | `HIGH` FPS (p50 / p95 ms) | Draw Calls (`LOW` → `MED/HIGH`) | Triangles (`LOW` → `MED/HIGH`) | JS Heap |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Mars** | **60.3** (`16.70 / 17.10`) | **60.0** (`16.70 / 17.10`) | **60.1** (`16.70 / 17.10`) | `108` → `123` | `62,744` → `62,759` | `20.7 MB` |
| **Earth** | **60.2** (`16.70 / 17.20`) | **60.3** (`16.70 / 17.00`) | **60.1** (`16.70 / 16.90`) | `153` → `168` | `68,228` → `68,243` | `20.7 MB` |
| **Moon** | **60.2** (`16.70 / 17.10`) | **57.1** (`16.70 / 32.40`) | **60.2** (`16.70 / 17.00`) | `124` → `139` | `61,692` → `61,707` | `20.7 MB` |

---

## Quick Start & Commands

### Prerequisites
- **Node.js** `>= 20` and **npm**
- Windows/macOS/Linux desktop with WebGL-capable GPU drivers (Electron packaging command `dist:win` targets Windows x64)

### Commands
```powershell
npm install
```

| Command | Purpose |
| :--- | :--- |
| `npm run desktop` | Launch Vite dev server (`127.0.0.1:5173`) + Electron desktop window |
| `npm run desktop:prod` | Build `dist/` and launch production Electron desktop app |
| `npm run dev` | Run browser-only Vite dev server |
| `npm run test` | Run headless Vitest suite (physics, terrain noise, PPO RL convergence, workbench) |
| `npm run build` | TypeScript strict check (`tsc --noEmit`) + Vite production bundle |
| `npm run benchmark` | Run deterministic 3-planet PPO vs. PID benchmark harness (`results/` & `docs/BENCHMARKS.md`) |
| `npm run profile:desktop` | Profile real Electron GPU/FPS frame times across 9 configs (`docs/PERFORMANCE_REPORT.md`) |
| `npm run generate:icon` | Regenerate `build/icon.png` (`512×512`) and multi-size `build/icon.ico` |
| `npm run dist:win` | Build standalone Windows x64 portable `.exe` in `release/` (`electron-builder`) |
| `npm run dist:win:dir` | Build unpacked Windows x64 Electron directory in `release/win-unpacked/` |

### Flight, Camera & Workbench Controls

| Key / Control | Action |
| :--- | :--- |
| `1` / `2` / `3` | Switch planet (`Mars` / `Earth` / `Moon`) |
| `Space` | Launch / start mission, or trigger Hot-Stage Separation during Launch ascent |
| `R` | Reset mission & re-lock camera onto vehicle |
| `G` | Toggle Starship landing legs (`DEPLOYED` / `STOWED`) |
| `T` | Toggle SAS angular damping (`ON` / `OFF`) |
| `W` / `Shift` & `S` / `Ctrl` | Manual throttle up / down (`Z` / `X` for instant `100%` / `0%`) |
| `Arrows` or `I / J / K / L`, `Q / E` | Manual Pitch/Tilt TVC & Roll/Yaw RCS commands |
| `F1–F6` / `V` | Switch cameras (`C1 PAD`, `C2 DRONE`, `C3 ENGINE`, `C4 STATION`, `C5 ORBIT`, `C6 MAP`) / toggle `AUTO` director |
| `[` / `]` | Step Physics Time Warp (`1x` / `2x` / `5x` / `10x`) |
| `M` | Toggle Web Audio mute (`UNMUTED` / `MUTED`) |

---

## Preserved Legacy 2D Python RL Baseline (`archive/legacy-rl-2d/`)

Milestone 0 (`v0.1.0`) remains preserved under [`archive/legacy-rl-2d/`](archive/legacy-rl-2d/) using Python, Farama Gymnasium (`LunarLander-v3`, Box2D), and Stable-Baselines3 PPO. Deterministic `100`-episode unshaped evaluations (seeds `42–141`, [`benchmark_summary.json`](archive/legacy-rl-2d/results/benchmark_summary.json), [`planet_benchmark_summary.json`](archive/legacy-rl-2d/results/planet_benchmark_summary.json)) measured `-193.03` (random) → `+118.82` (`ppo_1m_shaped`, `31%` solved) on standard `LunarLander-v3`, and documented policy degradation under Moon/Mars/Earth gravity & wind shifts—motivating AetherSim's native multi-planet 3D PPO trainer.

---

## Limitations & Simulation Fidelity Disclaimer

AetherSim `v1.1.0` is a **real-time interactive engineering, visualization, and RL research simulator (Phase A)**, **not a flight-qualified verification tool**:
- **Interactive 1:50 Planetary Scale & 2-Body Orbital Mechanics**: `launch` mode integrates spherical non-rotating 2-body central-body gravity ($\mu = g_0 R_{\text{sim}}^2$) around `1:50`-scaled planets (`Earth 127.4 km`, `Mars 67.8 km`, `Moon 34.7 km`) alongside NASA surface gravity and atmospheric constants so surface-to-orbit ascents play interactively in real time; `landing` mode retains local-tangent dynamics around the pad. Coupled propellant slosh, flexible-body structural modes, and J2/N-body perturbations are deferred to Phase B.
- **Real-Time Shader Approximations**: GLSL Mach-diamond plumes, Schlieren shimmer, and Rayleigh/Mie skies are visually physically inspired approximations—not Navier-Stokes CFD, DSMC rarefied gas dynamics, or thermal FEA.
- **No Flight Certification**: The software has **not** undergone DO-178C, NPR 7150.2, NASA-STD-7009 formal VVUQ, HIL qualification, or AFSS range-safety certification and **must never be used for operational flight decisions**.

---

## Documentation & Ecosystem Roadmap

| Document | Contents |
| :--- | :--- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 3 execution regimes, 14-module aerospace ecosystem architecture, ASCII dependency map, DDS/FMI/HLA interfaces |
| [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) | Reproducible multi-planet PPO vs. PID & fault stress-test benchmark report (`results/v1_benchmark.json`) |
| [`docs/PERFORMANCE_REPORT.md`](docs/PERFORMANCE_REPORT.md) | Measured Electron GPU/FPS profiling report across Mars/Earth/Moon × `LOW/MED/HIGH` (`results/v1_performance_profile.json`) |
| [`docs/MILESTONES.md`](docs/MILESTONES.md) | Git branching strategy and complete Milestones 0–4 + Phase B/C tracker |
| [`docs/VALIDATION_AND_SAFETY.md`](docs/VALIDATION_AND_SAFETY.md) | VVUQ framework, PINN/RL OOD bounds, Clopper-Pearson & Wilks Monte Carlo criteria, safety gates |
| [`CHANGELOG.md`](CHANGELOG.md) | Versioned release history (`v0.1.0` → `v1.0.1`) |

### Roadmap Overview

| Phase / Milestone | Version | Status | Scope Summary |
| :--- | :--- | :--- | :--- |
| **Milestone 0** | `v0.1.0` | **Complete (Archived)** | 2D Python PPO Rocket Lander (`archive/legacy-rl-2d/`) |
| **Milestone 1** | `v0.3.0` | **Complete & Verified** | 3D Electron/Three.js Mars/Earth/Moon worlds, Starship stack, pads/stations, 6-DOF flight, RUD FX, GLSL plumes, docs |
| **Milestone 2** | `v0.4.0` | **Complete & Verified** | Pure-TS `Float32Array` Continuous PPO Neural Network, live 3D learning-from-crashes & Web Worker trainer |
| **Milestone 3** | `v0.5.0` | **Complete & Verified** | Research Workbench (live plots, NN visualizer, fault injection, Monte Carlo, CSV/JSON), GSAP cameras, Web Audio |
| **Milestone 4** | `v1.0.0` | **Complete & Verified** | Multi-planet benchmark harness, Electron GPU/FPS profiler, GitHub Actions CI, Windows `.exe` packaging (`electron-builder`) |
| **Hotfix / Docs** | `v1.0.1` | **Complete & Verified** | PPO anti-collapse best-checkpoint guard, session worker sync, `padDeckY` parity, AI status HUD & visual showcase |
| **Phases B & C** | Post-`v1.0` | **Planned Ecosystem** | FMI/FMU & DDS co-simulation, spherical astrodynamics, offline CFD/FEA surrogates, AFSS, ECLSS, RTOS/HIL FlatSat |
