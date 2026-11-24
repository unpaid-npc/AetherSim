# AetherSim — Verification, Validation, Uncertainty Quantification (VVUQ) & Safety

> [!CAUTION]
> **Non-Flight-Qualification Disclaimer:** AetherSim (`v0.3.0`) is a desktop research, training, and visualization simulator. It has **not** undergone DO-178C, NASA NPR 7150.2, or formal NASA-STD-7009 accreditation and **must never be used as the basis for flight software qualification, range safety certification, or operational launch/landing decisions**.

---

## 1. VVUQ Framework (Aligned with NASA-STD-7009 & ASME V&V)

AetherSim separates assurance into four rigorous layers:

### A. Code Verification (Does the solver implement the equations without bugs?)
- **Static Type Discipline:** Strict TypeScript (`"strict": true`, `"noUnusedLocals": true`, `"noImplicitReturns": true` in `tsconfig.json`) enforced via `tsc --noEmit` on every build.
- **Headless Physics Unit & Invariant Suite (`src/__tests__/`):**
  - `planets.test.ts`: Verifies Mars/Earth/Moon physical constant ordering ($g_{\text{Moon}} < g_{\text{Mars}} < g_{\text{Earth}}$, vacuum vs. thin CO₂ vs. `1.01325 bar` N₂/O₂) and distinct environmental configs.
  - `noise.test.ts`: Verifies bitwise seed determinism for `SeededNoise2D` and strict flat launch-apron invariants ($h = 0$ for $r < 65\text{ m}$).
  - `flightController.test.ts`: Verifies end-to-end launch countdown $\rightarrow$ liftoff $\rightarrow$ ascent $\rightarrow$ stage separation, Max-Q ordering across planets (`Earth > Mars * 10`, `Moon === 0`), nominal propulsive landing envelopes (`|vy| <= 4.5 m/s`, `tilt <= 12°`, `legs >= 0.7`), manual TVC/RCS + SAS angular damping, and deterministic RUD triggers.
- **Timestep Convergence (Planned M3/Phase B):** Automated $\Delta t$-refinement checks comparing `60 Hz`, `240 Hz`, and `1000 Hz` fixed steps to bound numerical integration error.

### B. Solution Verification (Are discretization and numerical errors bounded?)
- **Fixed-Timestep Accumulator:** `FlightController.ts` uses a fixed `FIXED_DT = 1 / 60 s` physics step with frame-dt clamping (`0..0.1 s`) so rendering frame-rate variations never alter trajectory integration.
- **Single-Source Terrain Truth:** `TerrainSystem.ts` and `FlightController.getSurfaceHeightAt()` invoke the identical `samplePlanetTerrainHeight()` function (`src/utils/noise.ts`), eliminating visual-vs-physics ground mismatch.
- **Grid Convergence Index (GCI) (Planned Phase B):** Required whenever external CFD/FEA meshes or tabulated aerodynamic grids are introduced.

### C. Empirical Validation (Do models match physical reality?)
- **Phase A Reference Grounding:** Planetary gravity, surface pressure, scale height, near-surface density, and solar irradiance values in `src/config/planets.ts` are sourced from NASA Planetary Fact Sheets.
- **Analytical & Historical Benchmarks (Planned Phase B):** Compare ascent/descent $\Delta v$, gravity losses, and Max-Q profiles against analytical Tsiolkovsky/gravity-turn solutions and open telemetry benchmarks (e.g., orbital booster return profiles).

### D. Uncertainty Quantification (UQ) & Out-of-Distribution (OOD) Envelopes for AI/ML & PINNs
When Milestone 2 (PPO RL) and Phase B/C (PINN aerodynamic surrogates & Digital Twins) introduce learned models, AetherSim enforces strict runtime boundaries:
1. **Bounded Action & Physical Clamping:** Learned policies never bypass physical actuator limits (`throttle ∈ [0, 1]`, TVC gimbal `±15°`, finite fuel & RCS thrust).
2. **Epistemic Uncertainty & OOD Detection (Planned M2/Phase B):** Input states $(h, v, q, \text{AoA}, \text{Mach})$ are monitored against the training envelope (e.g., Mahalanobis distance / deep-ensemble variance $\sigma^2$).
3. **Mandatory Classical Fallback:** If an OOD trigger or ensemble uncertainty threshold is exceeded, control or surrogate evaluation must automatically fall back to verified classical GNC laws (PID/convex guidance) or conservative lookup tables—never extrapolating an unconstrained neural network.

---

## 2. Statistical Monte Carlo Acceptance Criteria

> **Current Status:** Phase A (`v0.3.0`) runs deterministic headless unit tests (`10` Vitest cases) plus an archived `100`-seed 2D Python benchmark (`archive/legacy-rl-2d/`). Automated 3D Monte Carlo sweeps are **Planned for Milestone 3**.

When evaluating stochastic dispersions (wind gusts, sensor noise, initial state perturbations, engine-out faults), AetherSim applies distribution-free statistical bounds:

### A. Clopper-Pearson Exact Binomial Confidence Bounds (Pass/Fail Landing Reliability)
For $k = 0$ failures observed in $N$ independent Monte Carlo trials, the lower confidence bound $p_L$ at confidence level $1 - \alpha$ is:
$$p_L = \alpha^{1/N} \quad \implies \quad N \ge \frac{\ln(\alpha)}{\ln(p_L)}$$

| Target Reliability ($p_L$) | Confidence ($1 - \alpha$) | Zero-Failure Trials Required ($N$) |
| :--- | :--- | :--- |
| `95%` | `95%` ($\alpha = 0.05$) | **`N >= 59`** |
| `99%` | `95%` ($\alpha = 0.05$) | **`N >= 299`** |
| `99%` | `99%` ($\alpha = 0.01$) | **`N >= 459`** |
| `99.9%` | `95%` ($\alpha = 0.05$) | **`N >= 2,995`** |

### B. Wilks' Distribution-Free Tolerance Bounds (Continuous Metrics: Touchdown Speed, Dispersion, Peak Load)
Without assuming Gaussian residuals, the maximum (or minimum) order statistic of $N$ independent runs bounds at least fraction $\beta$ of the true population with confidence $\gamma$ when $1 - \beta^N \ge \gamma$:
- **95% / 95% one-sided limit** (1st-order max): $N \ge 59$ runs.
- **99% / 95% one-sided limit** (1st-order max): $N \ge 299$ runs.
- **99% / 99% one-sided limit** (1st-order max): $N \ge 459$ runs.

---

## 3. Defensive Cybersecurity & Sandbox Boundaries

### Implemented in Phase A (`v0.3.0`)
- **Electron Process Isolation (`electron/main.cjs`, `electron/preload.cjs`):** `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`. The renderer cannot access Node.js `fs`, `child_process`, or OS APIs.
- **Strict Content Security Policy (`vite.config.ts`, `electron/main.cjs`):** Production builds enforce `default-src 'self'; script-src 'self'; connect-src 'self';`, blocking arbitrary remote script execution or exfiltration.
- **Least-Privilege Preload Bridge:** `window.desktopApp` exposes only static `isElectron`, `platform`, and runtime version strings.

### Planned Defensive Boundaries for Phase B/C (HIL FlatSat & Distributed Co-Simulation)
- **Network Segmentation:** Any future DDS/HLA or HIL FlatSat testbed must run on an isolated lab VLAN with zero routing to operational flight networks or public internet endpoints.
- **Signed Artifacts & Integrity Checks:** FSW binaries, FMU plugins, and ONNX/PPO policy checkpoints must be SHA-256 verified before loading.
- **Authorized Fault Injection Only:** Fault injection (sensor bias, bus dropout, actuator jam) is strictly confined to simulated SIL/HIL test harnesses for resilience verification—never offensive tooling or external system tampering.

---

## 4. Mandatory Evidence Gates Before Any Safety-Critical Flight Use

Any future evolution of AetherSim modules toward real hardware or flight support requires passing **all** gates below (none are satisfied by Phase A):

| Gate | Requirement & Standard | Owner | Phase A Status |
| :--- | :--- | :--- | :--- |
| **G1: Formal VVUQ Package** | NASA-STD-7009 Credibility Assessment Scale (CAS) levels documented for every model & surrogate | Simulation V&V Lead | **Not Met** (Phase A) |
| **G2: FSW Certification** | DO-178C / NASA NPR 7150.2 Class A/B traceability, MC/DC coverage, static analysis | Flight Software Lead | **Not Met** (No FSW yet) |
| **G3: Independent V&V (IV&V)** | Independent reproduction of Monte Carlo Wilks/Clopper-Pearson dispersion campaigns (`N >= 299+`) | Independent V&V Team | **Not Met** |
| **G4: HIL FlatSat Qualification** | Closed-loop real-time tests on flight-representative avionics, sensors, and physical buses | Avionics / HIL Lead | **Not Met** (Phase C) |
| **G5: Range Safety & AFSS Review** | Independent IIP corridor & Flight Termination System verification per RCC-319 / AFSPCMAN 91-710 | Range Safety Authority | **Not Met** |
| **G6: Configuration Control Board** | Signed release baseline, frozen checksums, and operational flight readiness sign-off | Chief Engineer / CCB | **Not Met** |
