# AetherSim — System & Aerospace Simulation Ecosystem Architecture

> [!IMPORTANT]
> **Implementation Boundary:** AetherSim `v0.3.0` implements **Phase A** (the real-time 3D Electron/Three.js interactive simulator and headless TypeScript flight physics core). The full **14-Module Aerospace Simulation Ecosystem** described in this specification defines the target multi-regime reference architecture guiding Milestones 2–4 and Phases B/C. Modules marked **Planned** do not exist in the runnable application yet.

---

## 1. Execution Regimes & Architectural Trade-Offs

Complex aerospace systems cannot be simulated accurately by a single monolithic solver at one timestep. AetherSim's reference architecture partitions workloads across **three execution regimes**:

| Dimension | Regime 1: Offline High-Fidelity Engineering | Regime 2: Real-Time Interactive & High-Throughput Batch (**Phase A Live Core / Phase B**) | Regime 3: Deterministic Hard Real-Time HIL / FlatSat (**Phase C Target**) |
| :--- | :--- | :--- | :--- |
| **Primary Purpose** | Design-margin discovery, CFD/FEA calibration, aero-heating & slosh database generation | Interactive 3D visualization, GNC prototyping, RL training, statistical Monte Carlo sweeps | Closed-loop Flight Software (FSW) & avionics hardware qualification on physical buses |
| **Timestep / Latency** | Microseconds to milliseconds (non-real-time; hours–days per run) | Fixed `16.67 ms` (`60 Hz` live) to `1 ms` (`1000 Hz` batch worker); decoupled render loop | Strict `1–10 ms` (`100–1000 Hz`) bounded loop with `< 50 µs` jitter |
| **Determinism** | Bitwise-reproducible floating-point reductions | Deterministic fixed-timestep PRNG & physics (`FlightController.ts`) | Hardware-clock deterministic RTOS scheduling, zero dynamic heap allocation |
| **Physics Fidelity** | RANS/LES CFD, DSMC, nonlinear FEA, multi-phase cryogenics | Parameterized 6-DOF rigid body, analytical/table aerodynamics, GPU GLSL approximations | Calibrated reduced-order models (ROMs), FMUs, and real avionics sensors/actuators |
| **Compute Target** | Multi-node CPU/GPU HPC clusters | Desktop CPU + Web Workers + WebGL2/Three.js GPU (`Electron`) | Real-time Linux (`PREEMPT_RT`) / VxWorks / FPGA I/O targets |

**Design Rule:** High-fidelity Regime 1 tools never run inside the interactive loop; instead, they generate verified lookup tables, aerodynamic databases, or UQ-bounded surrogate models consumed by Regimes 2 and 3.

---

## 2. The 14 Aerospace Simulation Domains

### Module 1 — Orbital Mechanics, Astrodynamics & Mission Design
- **Purpose:** Propagate trajectories across launch, orbital insertion, rendezvous, cislunar/interplanetary transfer, and entry interface.
- **Core Models:** Cowell / Encke 3D N-body propagation, J2–Jn spherical harmonics, third-body perturbations, solar radiation pressure (SRP), Lambert targeting, patched conics.
- **Inputs / Outputs:** Gravitational ephemerides & burn $\Delta v$ vectors $\rightarrow$ ECI/ECEF/planetary-fixed state vectors $(r, v)$, Keplerian elements, ground tracks.
- **Fidelity Tiers:** L1 (Keplerian / flat-Earth local tangent) $\rightarrow$ L2 (J2 + SRP + third-body) $\rightarrow$ L3 (high-order gravity + relativistic corrections).
- **Compute:** Low–Medium (RK4/DOPRI853).
- **Integration:** Drives Module 2 (atmosphere/albedo) and Module 5 (orbital frame handoff).
- **Verification:** Conservation of vis-viva energy & angular momentum; GMAT/STK reference trajectory cross-checks.
- **Assumptions:** Point-mass central body at L1; no relativistic effects below orbital velocities.
- **AetherSim Status:** **Partially Implemented (Phase A)** — Orbital stations animate along elliptical sky paths (`LaunchComplex.ts`); vehicle dynamics use constant-gravity local-tangent frame (`FlightController.ts`). Full spherical N-body orbital propagator is **Planned (Phase B)**.

### Module 2 — Atmospheric, Planetary & Space Environment
- **Purpose:** Provide physically grounded planetary gravity, barometric profiles, winds, terrain elevation, and radiation/space weather.
- **Core Models:** Exponential/US76/Mars-GRAM atmospheres, Dryden/von Kármán turbulence, deterministic procedural terrain heightfields, solar irradiance.
- **Inputs / Outputs:** Vehicle `(x, y, z)` & mission epoch $\rightarrow$ local $g$, pressure $P$, density $\rho$, speed of sound $a$, wind vector, terrain height $h(x, z)$.
- **Fidelity Tiers:** L1 (exponential scale-height + static gravity) $\rightarrow$ L2 (tabulated Mars-GRAM / NRLMSISE-00 + 3D wind shear) $\rightarrow$ L3 (coupled mesoscale + space-weather Kp/F10.7).
- **Compute:** Low (analytical/table lookup) to Medium (3D grid interpolation).
- **Integration:** Consumed by Modules 3, 4, 5, 10, 12, 14.
- **Verification:** NASA Planetary Fact Sheet constant checks (`planets.test.ts`), deterministic terrain seed invariants (`noise.test.ts`).
- **Assumptions:** Static exponential atmosphere and zero-wind local frame in Phase A (`FlightController.ts`).
- **AetherSim Status:** **Implemented (L1, Phase A)** — Mars/Earth/Moon NASA reference constants (`src/config/planets.ts`), exponential $\rho(h)$ (`FlightController.ts`), deterministic terrain & flat apron (`src/utils/noise.ts`).

### Module 3 — Aerodynamics, Aerothermodynamics & Re-entry Physics
- **Purpose:** Compute aerodynamic forces/moments $(C_L, C_D, C_m)$ across subsonic, transonic, supersonic, and hypersonic regimes plus convective/radiative heating.
- **Core Models:** Mach/AoA-indexed aerodynamic coefficient tables, flap/grid-fin control effectiveness, Sutton-Graves convective heating, TPS ablation.
- **Inputs / Outputs:** Dynamic pressure $q$, Mach, $\alpha$, $\beta$, flap/grid-fin deflections $\rightarrow$ body forces/moments, Max-Q flags, thermal heat flux.
- **Fidelity Tiers:** L1 (parametric drag/lift & flap torque + Max-Q structural threshold) $\rightarrow$ L2 (multi-dimensional CFD lookup tables + Sutton-Graves) $\rightarrow$ L3 (offline coupled CFD/DSMC + TPS charring).
- **Compute:** Low (L1/L2) to Extreme Offline (L3).
- **Integration:** Feeds Module 5 (forces), Module 6 (aero loads), Module 11 (TPS heat load), Module 14 (Schlieren/plasma FX).
- **Verification:** Earth > Mars >> Moon Max-Q ordering (`flightController.test.ts`); wind-tunnel/CFD benchmark tables at L2.
- **Assumptions:** Rigid non-ablating hull and simplified parametric aero in Phase A.
- **AetherSim Status:** **Implemented (L1, Phase A)** — Dynamic pressure $q$, Mach, `MAX-Q` detection, aerodynamic drag/lift/flap torques, and `AERO_OVERSTRESS` RUD at $q > 45\text{ kPa}$ & $\text{AoA} > 34^\circ$ (`FlightController.ts`).

### Module 4 — Propulsion, Cryogenics & Fluid Dynamics
- **Purpose:** Model main engine thrust, specific impulse ($I_{sp}$) variation with backpressure, TVC gimbal dynamics, cold-gas RCS, cryogenic boil-off, and tank slosh.
- **Core Models:** Rocket thrust equation $F = \dot{m} v_e + (P_e - P_a) A_e$, nozzle pressure expansion, propellant mass depletion, pendulum/equivalent-mechanical slosh.
- **Inputs / Outputs:** Throttle command, gimbal angle, RCS demand, ambient $P_a$ $\rightarrow$ thrust vector, mass flow $\dot{m}$, remaining propellant, plume expansion state.
- **Fidelity Tiers:** L1 (throttle/mass-fraction model + TVC/RCS authority) $\rightarrow$ L2 (backpressure-compensated $I_{sp}$ + transient spool + slosh modes) $\rightarrow$ L3 (offline multi-phase cryogenic CFD).
- **Compute:** Low (L1/L2) to High Offline (L3).
- **Integration:** Feeds Module 5 (thrust/inertia), Module 10 (pad QD/deluge), Module 14 (GLSL Mach-diamond plumes & cryo frost).
- **Verification:** Fuel depletion conservation, TVC/RCS torque response (`flightController.test.ts`).
- **Assumptions:** Instantaneous combustion response above spool phase; no active propellant slosh dynamics in Phase A.
- **AetherSim Status:** **Implemented (L1, Phase A)** — Booster & Ship throttle, fuel burn, `±15°` TVC gimbal, cold-gas RCS, cryo frost fade, and pressure-reactive GLSL Mach-diamond shader (`FlightController.ts`, `exhaustShader.ts`).

### Module 5 — Vehicle 6-DOF Rigid-Body & Multibody Flight Dynamics
- **Purpose:** Integrate translational and rotational equations of motion for stacked, separating, and multi-body vehicles plus ground/tower contact.
- **Core Models:** Newton-Euler 6-DOF integration, quaternion/Euler kinematics, stage-separation impulse & multibody tracking, contact/collision detection.
- **Inputs / Outputs:** Gravity, aero, thrust, RCS/TVC torques $\rightarrow$ position, velocity, attitude, angular rates, contact/RUD events.
- **Fidelity Tiers:** L1 (fixed-step 60 Hz rigid-body Euler-angle integrator + detached booster body) $\rightarrow$ L2 (quaternion 6-DOF + time-varying inertia tensor + multi-body catcher/legs) $\rightarrow$ L3 (coupled flexible multibody).
- **Compute:** Low–Medium (`60–1000 Hz`).
- **Integration:** Central hub connecting Modules 1–4, 6, 7, 9, 14.
- **Verification:** Launch-to-stage-separation progression, nominal landing envelope, RUD impact/overstress triggers (`flightController.test.ts`).
- **Assumptions:** Small-angle gimbal clamp; local-tangent flat contact plane outside pad radius (`getSurfaceHeightAt`).
- **AetherSim Status:** **Implemented (L1, Phase A)** — `FlightController.ts` fixed `1/60 s` step, detached booster coasting & impact tracking, universal RUD & landing verdict logic.

### Module 6 — Structures, Aeroelasticity & Vibroacoustics
- **Purpose:** Assess structural loads, bending modes, POGO coupling, acoustic launch loads, and landing gear shock absorption.
- **Core Models:** Modal structural dynamics, gust/Max-Q load exceedance, oleo-pneumatic gear damper models.
- **Inputs / Outputs:** Dynamic pressure, thrust transients, touchdown velocity $\rightarrow$ structural margin, bending states, failure flags.
- **Fidelity Tiers:** L1 (load/impact speed thresholds) $\rightarrow$ L2 (reduced-order modal flex + leg stroke physics) $\rightarrow$ L3 (offline NASTRAN/ANSYS FEA + vibroacoustic BEM).
- **Compute:** Low (L1/L2) to Very High Offline (L3).
- **Integration:** Consumes Modules 3, 4, 5; feeds Module 9 (AFSS / RUD structural break-up).
- **AetherSim Status:** **Partially Implemented (L1 thresholds, Phase A)** — Touchdown vertical/horizontal/tilt thresholds and `AERO_OVERSTRESS` trigger (`FlightController.ts`) + visual `ExplosionSystem.ts` debris breakup. Modal flex & FEA are **Planned (Phase B/C)**.

### Module 7 — Guidance, Navigation & Control (GNC) & Autonomy
- **Purpose:** Generate ascent gravity-turn, flip-burn, and precision propulsive landing trajectories alongside attitude stabilization and autonomous RL policies.
- **Core Models:** PID/LQR attitude control, convex optimization powered-descent guidance (G-FOLD style), Extended/Unscented Kalman Filters (EKF/UKF), PPO neural policies.
- **Inputs / Outputs:** Estimated state $(r, v, q, \omega)$, target pad $\rightarrow$ throttle, TVC gimbal, RCS, flap, grid-fin, and leg commands.
- **Fidelity Tiers:** L1 (classical state-machine autopilot + SAS rate damping + manual stick) $\rightarrow$ L2 (EKF + convex descent + live Web Worker PPO inference/training) $\rightarrow$ L3 (fault-tolerant adaptive GNC + verified safety envelope).
- **Compute:** Low–Medium (live control) to High (parallel RL training rollouts).
- **Integration:** Reads Modules 5, 8, 13; drives Modules 4, 5.
- **Verification:** Autonomous nominal landings on Mars, Earth, and Moon (`flightController.test.ts`); Legacy 2D PPO 100-seed benchmarks.
- **AetherSim Status:** **Implemented (L1 Autopilot + Manual + SAS, Phase A)**; **Planned (M2 Live 3D PPO & EKF)**.

### Module 8 — Avionics, Flight Software (FSW), SIL & HIL FlatSat
- **Purpose:** Execute flight software against simulated sensors (IMU, star tracker, radar altimeter, GPS/GNSS) and interface with physical avionics on a FlatSat testbed.
- **Core Models:** Sensor bias/noise/latency injection, MIL-STD-1553 / SpaceWire / CAN / Ethernet-TSN bus emulation, watchdog timers, triple-modular redundancy (TMR) voting.
- **Inputs / Outputs:** Truth states $\rightarrow$ noisy sensor packets $\rightarrow$ FSW commands $\rightarrow$ actuator responses.
- **Fidelity Tiers:** L1 (ideal state feedback) $\rightarrow$ L2 (Software-in-the-Loop FSW binary + sensor noise/fault injection) $\rightarrow$ L3 (Hardware-in-the-Loop FlatSat on RTOS/FPGA).
- **Compute:** Strict real-time (`100–1000 Hz`).
- **Integration:** Wraps Module 7; feeds Modules 9, 12.
- **AetherSim Status:** **Planned (M3 Fault Injection SIL $\rightarrow$ Phase C HIL FlatSat)**.

### Module 9 — Range Safety, Autonomous Flight Safety System (AFSS) & Abort
- **Purpose:** Enforce flight termination corridors, debris footprint prediction, launch pad collision avoidance, and crew/vehicle abort triggers.
- **Core Models:** Instantaneous Impact Point (IIP) propagation, green/yellow/red corridor gates, independent Flight Termination System (FTS) voting logic.
- **Inputs / Outputs:** Redundant inertial/GNSS nav, structural health $\rightarrow$ corridor violation flags, FTS arm/destruct signals, debris dispersion cones.
- **Fidelity Tiers:** L1 (pad/tower hazard & RUD detection) $\rightarrow$ L2 (real-time IIP corridor & range safety monitor) $\rightarrow$ L3 (independent dual-channel AFSS hardware emulator).
- **Compute:** Low–Medium (deterministic safety loop).
- **Integration:** Monitors Modules 5, 6, 8; triggers RUD/abort in Modules 5, 14.
- **AetherSim Status:** **Partially Implemented (L1 hazard & RUD detection, Phase A)** — Tower collision, overstress, and impact RUD (`FlightController.ts`). Independent AFSS & IIP corridors are **Planned (Phase B/C)**.

### Module 10 — Ground Systems, Launch Complex & Spaceport Operations
- **Purpose:** Model launch mount hold-down clamps, Quick-Disconnect (QD) umbilicals, Mechazilla catch arms, propellant tank farms, water deluge, and surface base infrastructure.
- **Core Models:** Countdown sequencer, clamp/QD/catch-arm kinematics, cryogenic ground loading & pad thermal/blast interaction.
- **Inputs / Outputs:** T-clock & vehicle position $\rightarrow$ clamp release, QD retraction, catch-arm state, pad contact geometry.
- **Fidelity Tiers:** L1 (animated OLM/gantry/QD/catch arms + planet-specific pad decks & bases) $\rightarrow$ L2 (ground GSE fluid/deluge states + active tower catch dynamics) $\rightarrow$ L3 (full spaceport turnaround & ISRU operations).
- **Compute:** Low.
- **Integration:** Coupled to Modules 4, 5, 14.
- **AetherSim Status:** **Implemented (L1, Phase A)** — Earth Starbase OLM/Mechazilla, Mars Spaceport & ISRU Hab, Moon Shackleton Outpost (`src/scene/LaunchComplex.ts`).

### Module 11 — Thermal Control & Environmental Control / Life Support (ECLSS)
- **Purpose:** Track vehicle/habitat thermal nodes, radiative heat rejection, and closed-loop cabin O₂/CO₂/H₂O/pressure balance for crewed missions.
- **Core Models:** Multi-node lumped thermal network, Stefan-Boltzmann radiator rejection, Sabatier/electrolysis/CO₂-scrubber mass-balance ODEs.
- **Inputs / Outputs:** Solar/albedo flux, aero heating, crew metabolic load $\rightarrow$ node temperatures, cabin $pO_2 / pCO_2$, consumable reserves.
- **Fidelity Tiers:** L1 (absent / ambient planet display) $\rightarrow$ L2 (`1 Hz` lumped thermal & ECLSS mass balance) $\rightarrow$ L3 (coupled Thermal Desktop / full regenerative ECLSS).
- **Compute:** Low (`0.1–1 Hz`).
- **Integration:** Consumes Modules 2, 3, 10; feeds Modules 8, 14.
- **AetherSim Status:** **Planned (Phase B/C)** (visual ISRU/habitat domes exist in `LaunchComplex.ts`, without thermodynamic simulation yet).

### Module 12 — Communications, Telemetry, Tracking & Deep Space Network (TT&C)
- **Purpose:** Simulate RF/optical link budgets, atmospheric/plasma blackout, propagation delay, and CCSDS telemetry packet framing.
- **Core Models:** Friis link equation, free-space path loss, rain/dust attenuation, plasma sheath ionization blackout, light-time delay ($c$-latency).
- **Inputs / Outputs:** Range, elevation, plasma density, antenna pointing $\rightarrow$ SNR, bit error rate, link lock/dropout, packet stream.
- **Fidelity Tiers:** L1 (zero-latency local UI telemetry) $\rightarrow$ L2 (CCSDS packet stream + link-margin & blackout gating) $\rightarrow$ L3 (DSN/relay constellation scheduling & hardware RF attenuation).
- **Compute:** Low.
- **Integration:** Links Modules 8, 10, 14.
- **AetherSim Status:** **Implemented at L0/L1 UI Telemetry** (`SceneTelemetry` / `FlightTelemetry` in `src/main.ts`); RF link budget & blackout simulation are **Planned (Phase B/C)**.

### Module 13 — AI/ML Surrogates, Physics-Informed Neural Networks (PINNs) & Digital Twins
- **Purpose:** Accelerate aerodynamic/thermal approximations via PINNs, train autonomous landing policies (PPO), and synchronize live Digital Twins with uncertainty bounds.
- **Core Models:** PPO Actor-Critic networks, physics-constrained residual neural surrogates, ensemble OOD detectors, Bayesian/EKF state assimilation.
- **Inputs / Outputs:** Normalized state observations $\rightarrow$ control actions, surrogate forces/fluxes, epistemic uncertainty $\sigma$, live activation telemetry.
- **Fidelity Tiers:** L1 (archived 2D PPO baseline) $\rightarrow$ L2 (Web Worker live 3D PPO training/inference + activation visualizer) $\rightarrow$ L3 (OOD-guarded PINN surrogates + calibrated Digital Twin with classical fallback).
- **Compute:** Medium–High (Web Worker / GPU training).
- **Integration:** Interfaces with Modules 3, 5, 7, 14; governed by `docs/VALIDATION_AND_SAFETY.md`.
- **AetherSim Status:** **Archived Baseline Only (`archive/legacy-rl-2d/`)**; **Live 3D PPO Engine Planned (Milestone 2)**.

### Module 14 — Visualization, Synthetic Sensor Rendering & HITL Telemetry
- **Purpose:** Render physically grounded 3D scenes, custom atmospheric/propulsion/explosion shaders, scientific telemetry plots, and synthetic camera/LiDAR feeds.
- **Core Models:** WebGL2 PBR pipeline, custom GLSL sky/plume/fireball/Schlieren shaders, `UnrealBloomPass`, GSAP camera choreography, scientific time-series plots.
- **Inputs / Outputs:** `FlightTelemetry`, `PlanetConfig`, quality preset $\rightarrow$ 3D viewport, HUD readouts, plots, synthetic vision tensors.
- **Fidelity Tiers:** L1 (3D PBR + GLSL FX + HUD telemetry) $\rightarrow$ L2 (scientific workbench plots, NN viewer, ghost trajectories, audio synthesis) $\rightarrow$ L3 (calibrated synthetic optical/LiDAR sensor rendering for vision-based GNC).
- **Compute:** High GPU (decoupled from physics timestep).
- **Integration:** Consumes all active modules; isolated behind `SceneManager.ts`.
- **AetherSim Status:** **Implemented (L1, Phase A)** — `SceneManager.ts`, `StarshipVehicle.ts`, `LaunchComplex.ts`, `TerrainSystem.ts`, `PropulsionEffects.ts`, `ExplosionSystem.ts`, `PostProcessing.ts`. Workbench plots & audio are **Planned (Milestone 3)**.

---

## 3. ASCII Module Dependency Map

```text
+-----------------------------------------------------------------------------------+
|                        MODULE 14: 3D VISUALIZATION & HITL HUD                     |
|    (Three.js PBR, GLSL Sky/Plume/Explosion, Bloom+Schlieren, Future Plots/Audio)  |
+---------^-------------------------^------------------------------^----------------+
          | state/FX                | telemetry/events             | GSE/sky/terrain
+---------+---------+     +---------+---------+          +---------+----------------+
| MODULE 5: 6-DOF   |     | MODULE 12: TT&C   |          | MODULE 10: GROUND & PAD  |
| FLIGHT DYNAMICS   |<--->| & TELEMETRY BUS   |          | (OLM, Mechazilla, Bases) |
+---^-----------^---+     +---------^---------+          +---------^----------------+
    |           |                   |                              |
    | forces    | state             | commands/packets             | T-clock / clamps
+---+----+  +---+--------+    +-----+-----------+          +-------+----------------+
| MOD 3  |  |   MOD 4    |    | MODULE 8:       |          | MODULE 9: RANGE SAFETY |
| AERO & |  | PROPULSION |<---+ AVIONICS / FSW  |<-------->| (RUD / AFSS / Abort)   |
| HEATING|  | & CRYO     |    | (SIL / HIL)     |          +------------------------+
+---^----+  +-----^------+    +-----^-----------+
    |             |                 |
+---+-------------+-----------------+-----------------------------------------------+
|               MODULE 2: PLANETARY, ATMOSPHERIC & SPACE ENVIRONMENT                |
|        & MODULE 1: ORBITAL ASTRODYNAMICS  |  MODULE 6: STRUCTURES / LOADS         |
+-------------------------------------------+---------------------------------------+
    ^                                       ^
    | env/ephemeris                         | surrogate / policy / UQ
+---+---------------------------------------+---+     +-----------------------------+
| MODULE 7: GNC, AUTOPILOT & AUTONOMY           |<--->| MODULE 13: AI/ML, PPO,      |
| (Classical PID/Convex + PPO Policy + SAS)     |     | PINNs & DIGITAL TWINS       |
+-----------------------------------------------+     +-----------------------------+
    ^
    | thermal / life-support health (Phase B/C)
+---+-------------------------------------------+
| MODULE 11: THERMAL CONTROL & ECLSS (Planned)  |
+-----------------------------------------------+
```

---

## 4. Co-Simulation Data, Bus & Timing Interfaces

### Standard Bus & Co-Simulation Protocols (Phase B/C Target)
- **OMG DDS (Data Distribution Service):** Pub/sub real-time state & telemetry topics (`vehicle/state`, `gnc/cmd`, `env/local`, `safety/status`) with QoS deadline contracts.
- **FMI 3.0 / FMU (Functional Mock-up Interface):** Standardized Co-Simulation FMU packaging for external thermal, ECLSS, slosh, or propulsion sub-models.
- **IEEE 1516 HLA (High Level Architecture):** Federated multi-vehicle or spaceport + orbital constellation exercises with time-managed RTI synchronization.
- **CCSDS Space Packet Protocol:** Telemetry/telecommand framing between simulated FSW (Module 8) and ground/UI telemetry (Modules 10, 12, 14).

### Multi-Rate Execution Schedule
| Rate Group | Period | Target Modules | Phase A Status |
| :--- | :--- | :--- | :--- |
| **Fast HIL / Actuator Loop** | `1000 Hz` (`1 ms`) | Avionics bus I/O, TVC servo, FTS hardware | **Planned (Phase C)** |
| **IMU / Attitude Inner Loop** | `200 Hz` (`5 ms`) | IMU integration, high-rate SAS/TVC inner loop | **Planned (Phase B)** |
| **Primary 6-DOF & GNC Step** | `60 Hz` (`16.67 ms`) | `FlightController.stepFixed()`, aero, propulsion, contact/RUD | **Implemented (`FIXED_DT = 1/60`)** |
| **Nav / Telemetry Snapshot** | `4–20 Hz` (`50–250 ms`) | HUD telemetry throttling (`250 ms` in `SceneManager`), future plots | **Implemented (`4 Hz` HUD update)** |
| **Slow Thermal / ECLSS** | `1 Hz` (`1000 ms`) | Cryogenic tank boil-off, cabin ECLSS, orbital stationkeeping | **Planned (Phase B/C)** |
| **Visual Render Frame** | Uncoupled (`VSync / rAF`) | Three.js WebGL render + `EffectComposer` post-processing | **Implemented (`requestAnimationFrame`)** |

---

## 5. Live Phase A Codebase Mapping (`src/` & `electron/`)

| File | Architectural Role | Decoupling & Security Notes |
| :--- | :--- | :--- |
| [`electron/main.cjs`](../electron/main.cjs) | Electron main process, `BrowserWindow`, CSP headers, `--smoke-test` probe | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| [`electron/preload.cjs`](../electron/preload.cjs) | Minimal `contextBridge` (`window.desktopApp`) | Exposes read-only platform/version metadata only |
| [`scripts/launch-desktop.mjs`](../scripts/launch-desktop.mjs) | Dev Vite + Electron orchestrator and `--prod --smoke-test` runner | Strips `ELECTRON_RUN_AS_NODE`, enforces `127.0.0.1:5173` |
| [`src/main.ts`](../src/main.ts) | HUD DOM controller, keyboard manual/camera bindings, `window.__STARSHIP_SIM__` | Zero physics math; delegates all state updates to `SceneManager` |
| [`src/sim/FlightController.ts`](../src/sim/FlightController.ts) | **Headless 60 Hz flight physics engine** (Modules 2, 3, 4, 5, 7, 9 L1) | Zero Three.js/DOM imports; directly runnable in Node/Vitest & Web Workers |
| [`src/config/planets.ts`](../src/config/planets.ts) | NASA planetary constants, shader/lighting/terrain configs (Module 2) | Pure immutable TypeScript config records |
| [`src/utils/noise.ts`](../src/utils/noise.ts) | Deterministic `SeededNoise2D` (FBM, ridged, craters, flat pad mask) | Shared identically by `FlightController` physics and `TerrainSystem` mesh |
| [`src/scene/SceneManager.ts`](../src/scene/SceneManager.ts) | Top-level WebGL loop, camera tracking, PMREM IBL, Schlieren projection (Module 14) | Bridges `FlightController` telemetry to 3D scene & `PostProcessingPipeline` |
| [`src/scene/StarshipVehicle.ts`](../src/scene/StarshipVehicle.ts) | 1:1 Starship + Super Heavy procedural assembly & actuator animation | Instanced Raptors/interstage struts, gimbal, flaps, grid fins, legs, cryo frost |
| [`src/scene/LaunchComplex.ts`](../src/scene/LaunchComplex.ts) | Earth/Mars/Moon pads, Mechazilla, surface bases & orbital stations (Module 10) | Planet-specific pad deck heights synchronized with `FlightController` |
| [`src/scene/TerrainSystem.ts`](../src/scene/TerrainSystem.ts) | Radial-LOD terrain rings, `38 km` horizon skirt, `220` instanced boulders | Vertex height synced to `samplePlanetTerrainHeight` |
| [`src/scene/ProceduralTextures.ts`](../src/scene/ProceduralTextures.ts) | Procedural albedo/normal/roughness PBR textures | Cached per vehicle material and regenerated per planet |
| [`src/shaders/atmosphereShader.ts`](../src/shaders/atmosphereShader.ts) | Custom GLSL Rayleigh/Mie sky dome, starfield & Earth cloud layer | Driven by `PlanetAtmosphereShaderParams` |
| [`src/shaders/exhaustShader.ts`](../src/shaders/exhaustShader.ts) | Custom GLSL Raptor Mach-diamond & vacuum expansion plume shader | Reacts continuously to `uPressureBar` and `uThrottle` |
| [`src/effects/PropulsionEffects.ts`](../src/effects/PropulsionEffects.ts) | Multi-nozzle plumes, cryo LOX vents, cold-gas RCS cones, ground blast particles | Quality-scaled (`low` / `med` / `high`) |
| [`src/effects/ExplosionSystem.ts`](../src/effects/ExplosionSystem.ts) | RUD GLSL fireballs, shockwave ring, `160` debris, `240` smoke, flash, shake | Triggered once per unique `CrashEvent.id` |
| [`src/scene/PostProcessing.ts`](../src/scene/PostProcessing.ts) | `EffectComposer` with `UnrealBloomPass` + Schlieren heat-shimmer `ShaderPass` | Bypassed cleanly on `low` quality preset |
