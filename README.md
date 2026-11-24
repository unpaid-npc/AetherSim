# AetherSim

**AetherSim (`v0.3.0`)** is a real-time 3D aerospace launch, propulsive landing, and planetary flight simulator built with **Electron**, **Three.js**, **TypeScript**, and custom **GLSL** shaders.

> [!NOTE]
> **Phase A Runnable Core vs. Phase B/C Ecosystem Architecture:** What runs today (`npm run desktop` / `npm run dev`) is the verified **Phase A Desktop Simulator** (`AetherSim v0.3.0`, Stages 1–3). The repository also specifies a broader **14-Module Aerospace Simulation Ecosystem Reference Architecture** (`docs/ARCHITECTURE.md`) guiding Milestones 2–4 and future Phases B/C. Every section below explicitly separates **implemented & verified** capabilities from **planned** work.

---

## Implemented & Verified Capabilities (Phase A — `v0.3.0`)

### 1. Multi-Planet Physics & Environments (`src/config/planets.ts`)
Three selectable worlds parameterized with NASA Planetary Fact Sheet reference constants:

| World | Site / Complex | Surface Gravity | Surface Pressure | Near-Surface Density | Scale Height | Atmosphere / Sky |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Mars** | Jezero / Arcadia Launch Complex | `3.721 m/s²` | `0.00636 bar` | `0.020 kg/m³` | `11.1 km` | Thin CO₂ (`0.6%` Earth), ochre horizon, zenith stars |
| **Earth** | Starbase Boca Chica Coastal Pad | `9.807 m/s²` | `1.01325 bar` | `1.225 kg/m³` | `8.5 km` | Dense N₂/O₂ (`1.01 bar`), Rayleigh sky + cloud layer |
| **Moon** | Shackleton Crater South Pole | `1.625 m/s²` | `0.00000 bar` | `0.000 kg/m³` | `0.0 km` | Hard vacuum, pitch-black starfield, harsh solar glare |

### 2. Procedural 3D Terrain, Sky Shaders & Orbital Lighting
- **Radial-LOD PBR Terrain (`src/scene/TerrainSystem.ts`, `src/utils/noise.ts`)**: Deterministic seeded 2D simplex/FBM/ridged/crater heightfield spanning concentric rings from `0 m` to `5,000 m` plus a `38,000 m` curved horizon skirt, keeping a `65 m` flat launch apron around the pad and scattering `220` instanced surface boulders.
- **Procedural PBR Maps (`src/scene/ProceduralTextures.ts`)**: Offscreen canvas-generated albedo, normal, and roughness maps for planetary soils, pad concrete, brushed stainless steel, hexagonal TPS heat-shield tiles, and cryogenic frost.
- **Custom Atmospheric Sky & IBL (`src/shaders/atmosphereShader.ts`, `src/scene/SceneManager.ts`)**: Rayleigh-inspired wavelength gradient, Henyey-Greenstein Mie forward scattering, procedural dual-layer starfield, animated Earth cloud dome, and live PMREM environment maps for metallic stainless reflections.

### 3. 1:1 Scale SpaceX Starship + Super Heavy Stack & Launch Complexes
- **Vehicle Assembly (`src/scene/StarshipVehicle.ts`)**:
  - **Super Heavy Booster (`71 m` tall, `4.5 m` radius)**: Brushed stainless hull, vented hot-staging interstage with `24` instanced vent struts, `4` actuated waffle grid fins, `33`-Raptor engine cluster (`30` instanced outer/middle + `3` gimbaling center engines), and dynamic LOX/CH₄ cryogenic frost sleeve.
  - **Starship Upper Stage (`50 m` tall)**: Split hexagonal TPS windward heat shield and brushed stainless leeward hull, tangent-ogive nosecone, `2` forward + `2` aft actuated flaps, `6`-Raptor aft bay (`3` vacuum + `3` gimbaling sea-level engines), and `4` deployable landing legs.
- **Planet-Specific Launch Complexes, Surface Outposts & Orbital Stations (`src/scene/LaunchComplex.ts`)**:
  - **Earth**: `18 m` elevated Orbital Launch Mount (OLM) with `20` hold-down clamps, flame trench, `145 m` Mechazilla tower with animated chopstick catch arms and retracting QD umbilical arm, cryo tank farm, stadium floodlights, and an orbiting ISS-inspired LEO station.
  - **Mars**: Sintered-regolith octagonal blast deck, servicing gantry, `~180 m` distant geodesic habitat & ISRU Sabatier propellant plant with `12` instanced solar panels, and a centrifugal-ring Mars Orbital Transfer Station.
  - **Moon**: Sintered landing pad surrounded by a `360°` regolith ejecta blast berm, low-profile servicing gantry, Artemis-style pressurized surface outpost with vertical polar solar towers, and an orbiting Lunar Gateway-inspired station.

### 4. Headless 60 Hz 6-DOF-Inspired Flight Engine (`src/sim/FlightController.ts`)
- Strictly decoupled from Three.js and the DOM for deterministic fixed-timestep (`dt = 1/60 s`) headless execution in Vitest and future Worker pipelines.
- **Dual Mission Modes**: `launch` (T-10s countdown, umbilical retraction, liftoff, ascent, Max-Q, manual/auto hot-stage separation with detached booster ballistic tracking) and `landing` (atmospheric belly-flop/aerodynamic descent or lunar vacuum flip-burn, landing leg deployment, propulsive touchdown).
- **Autopilot & Manual Flight (`TVC` + `RCS` + `SAS`)**: Responsive `±15°` (`0.2618 rad`) physical TVC nozzle gimbal authority under throttle, cold-gas RCS thrusters in vacuum/low-throttle regimes, and toggleable SAS angular-rate damping (`T`).
- **Universal RUD & Verdict Logic**: Detects `LAUNCH_TOWER_COLLISION`, `AERO_OVERSTRESS` (`q > 45 kPa` at `AoA > 34°`), `SURFACE_IMPACT`, and `TIP_OVER`; classifies outcomes as `NOMINAL LANDING`, `HARD LANDING`, or `CRASH_RUD`.

### 5. Real-Time Propulsion FX, RUD Explosions & Post-Processing
- **Pressure-Reactive GLSL Raptor Plumes (`src/shaders/exhaustShader.ts`, `src/effects/PropulsionEffects.ts`)**: Exhaust geometry and fragment shading dynamically adapt to ambient barometric pressure—producing tight Mach shock-diamond columns at `1.01 bar` on Earth, wider low-pressure plumes on Mars, and broad translucent vacuum expansion fans on the Moon—paired with cryo LOX venting, cold-gas RCS cones, and ground dust/steam blast clouds.
- **3D RUD Crash Explosions (`src/effects/ExplosionSystem.ts`)**: Multi-layered animated GLSL fireballs, expanding shockwave ring, `160` instanced tumbling burning debris fragments, `240` rising smoke particles, transient point-light flash, and distance-attenuated camera shake.
- **Post-Processing & Quality Scaling (`src/scene/PostProcessing.ts`)**: `EffectComposer` with `UnrealBloomPass` + custom screen-space **Schlieren heat-shimmer `ShaderPass`** projected to active nozzle coordinates, toggleable across `LOW` (direct render, `1024` shadow map), `MED` (bloom + Schlieren, `2048` shadows), and `HIGH` presets.

---

## Verified Runtime & Test Benchmarks

Measured directly on this repository after the `AetherSim v0.3.0` rebrand:

| Check | Command | Measured Result |
| :--- | :--- | :--- |
| **Unit & Physics Tests** | `npm run test` | **Passed (`3` files, `10` tests, `0` failures)** in `430 ms` (`planets.test.ts`, `noise.test.ts`, `flightController.test.ts`) |
| **TypeCheck & Bundle Build** | `npm run build` | **Passed (`0` TypeScript / Vite errors)**; `34` modules transformed in `422 ms` (`dist/index.html`, `793.38 kB` JS, `5.30 kB` CSS) |
| **Electron Desktop Smoke Test** | `node scripts/launch-desktop.mjs --prod --smoke-test` | **`SMOKE_OK`**, `0` warnings, `0` console/main errors, title `"AetherSim — 3D Aerospace Launch & Landing Simulator"`, `1426×779` canvas, `22 FPS` at 4s hidden-window boot on `ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11)` |

---

## Quick Start & Commands

### Prerequisites
- **Node.js** `>= 20` and **npm**
- Windows/macOS/Linux desktop with WebGL-capable GPU drivers (for Electron desktop mode)

### Local Setup & Run
```powershell
npm install
```

| Command | Purpose |
| :--- | :--- |
| `npm run desktop` | Launch Vite dev server (`127.0.0.1:5173`) + Electron desktop window |
| `npm run desktop:prod` | Run `tsc --noEmit && vite build` and launch Electron from `dist/` |
| `npm run dev` | Run browser-only Vite dev server |
| `npm run test` | Execute Vitest headless unit & flight-physics suite (`vitest run`) |
| `npm run build` | Type-check (`tsc --noEmit`) and build production bundle (`vite build`) |
| `node scripts/launch-desktop.mjs --prod --smoke-test` | Headless Electron production smoke check returning JSON diagnostics |

### Flight & Camera Controls

| Key / Control | Action |
| :--- | :--- |
| `1` / `2` / `3` | Switch planet (`Mars` / `Earth` / `Moon`) |
| `Space` | Start mission / trigger Stage Separation during Launch ascent |
| `R` | Reset mission on current planet & mode |
| `G` | Toggle Starship landing legs (`DEPLOYED` / `STOWED`) |
| `T` | Toggle SAS angular damping (`ON` / `OFF`) |
| `W` / `Shift` & `S` / `Ctrl` | Manual throttle up / down |
| `Z` / `X` | Manual instant `100%` / `0%` throttle |
| `Arrows` or `I / J / K / L` | Manual Pitch & Roll/Tilt TVC + RCS commands |
| `Q` / `E` | Manual Yaw RCS |
| Mouse Drag / Wheel | Orbit / pan / zoom `OrbitControls` around Rocket or Pad & Base focus |

---

## Preserved Legacy 2D Python RL Baseline (`archive/legacy-rl-2d/`)

Milestone 0 (`v0.1.0`) is preserved intact under [`archive/legacy-rl-2d/`](archive/legacy-rl-2d/) using Python, Farama Gymnasium (`LunarLander-v3`, Box2D), and Stable-Baselines3 PPO. Deterministic `100`-episode unshaped evaluations (seeds `42–141`, recorded in [`benchmark_summary.json`](archive/legacy-rl-2d/results/benchmark_summary.json) and [`planet_benchmark_summary.json`](archive/legacy-rl-2d/results/planet_benchmark_summary.json)) measured:
- **Standard LunarLander-v3**: Random baseline achieved `-193.03` mean reward (`0%` solved) vs. `ppo_1m_shaped` achieving `+118.82` mean reward (`31%` solved `>= 200`, `25%` safe between-flags, `40%` safe outside-flags, `26%` crash).
- **Multi-Planet 2D Gravity/Wind Transfer**: `ppo_1m_shaped` dropped to `-2.47` mean reward on Moon (`1.62 m/s²`, high out-of-bounds rate), `+49.82` on Mars (`3.73 m/s²`, wind `5.0`), and `+24.99` on Earth (`9.81 m/s²`, wind `15.0`)—motivating the multi-planet curriculum planned for Milestone 2.

> **Important:** Live 3D PPO training/inference inside the Electron app is **not implemented yet** (scheduled for Milestone 2).

---

## Limitations & Simulation Fidelity Disclaimer

AetherSim `v0.3.0` is a **real-time interactive engineering & visualization simulator (Phase A)**, **not a flight-qualified verification tool**:
- **Simplified Flight Dynamics**: Uses a local-tangent-plane rigid-body 6-DOF-inspired integrator with exponential atmospheres and parameterized drag/lift (`FlightController.ts`) rather than full spherical rotating-planet astrodynamics, full 3-axis inertia tensors, propellant slosh, or structural flex modes.
- **Real-Time Shader Approximations**: GLSL Mach-diamond plumes, Schlieren heat shimmer, and Rayleigh/Mie sky domes are visually physically inspired approximations—not Navier-Stokes CFD, DSMC rarefied gas dynamics, or finite-element thermal/structural solvers.
- **No Hardware-in-the-Loop or Flight Qualification**: The software has **not** undergone DO-178C, NPR 7150.2, NASA-STD-7009 formal VVUQ, or independent range-safety (AFSS) certification and **must never be used for operational launch/landing decisions**.

---

## Documentation & Phased Roadmap

| Document | Contents |
| :--- | :--- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 3 execution regimes, 14-module aerospace ecosystem specification, ASCII dependency map, DDS/FMI/HLA interfaces, and Phase A code mapping |
| [`docs/MILESTONES.md`](docs/MILESTONES.md) | Git branching strategy and Milestone 0–4 + Phase B/C tracker |
| [`docs/VALIDATION_AND_SAFETY.md`](docs/VALIDATION_AND_SAFETY.md) | VVUQ framework, PINN/RL OOD uncertainty bounds, Clopper-Pearson & Wilks Monte Carlo criteria, defensive security & evidence gates |
| [`CHANGELOG.md`](CHANGELOG.md) | Versioned release history (`v0.1.0` → `v0.3.0`) |

### High-Level Roadmap

| Phase / Milestone | Version | Status | Scope Summary |
| :--- | :--- | :--- | :--- |
| **Milestone 0** | `v0.1.0` | **Complete (Archived)** | 2D Python PPO Rocket Lander (`archive/legacy-rl-2d/`) |
| **Milestone 1 (Phase A Core)** | `v0.3.0` | **Complete & Verified** | 3D Electron/Three.js Mars/Earth/Moon worlds, Starship stack, pads/stations, 6-DOF launch/landing, TVC/RCS/SAS, RUD explosions, GLSL plumes, bloom/Schlieren, docs suite |
| **Milestone 2** | `v0.4.0` | **Next** | Web Worker headless RL engine, live in-app PPO neural network training & inference, multi-planet curriculum, ghost trajectories & crash-replay learning |
| **Milestone 3** | `v0.5.0` | **Planned** | Aerospace Research Workbench: live telemetry plots, NN activation visualizer, deterministic fault injection, Monte Carlo batch runner & CSV/JSON export, WebAudio & GSAP cinematography |
| **Milestone 4** | `v1.0.0` | **Planned** | GPU/CPU profiling, E2E desktop verification, Windows `.exe` packaging (`electron-builder`) |
| **Phases B & C** | Post-`v1.0` | **Planned Ecosystem** | FMI/FMU & DDS co-simulation, spherical orbital astrodynamics, offline CFD/FEA surrogates, AFSS, ECLSS, deterministic RTOS/HIL FlatSat, exploratory quantum optimization benchmarks |
