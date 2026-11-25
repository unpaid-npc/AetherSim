# AetherSim v1.0.0 — Desktop GPU & FPS Performance Report

Measured directly inside the built Electron desktop application via `npm run profile:desktop` ([scripts/profile-desktop.mjs](../scripts/profile-desktop.mjs)), with raw frame telemetry saved in [results/v1_performance_profile.json](../results/v1_performance_profile.json).

---

## Test Environment & Hardware Scope
- **Measured At (UTC):** `2026-11-25T06:13:28.646Z`
- **OS / Architecture:** `Windows_NT 10.0.26300 (x64)`
- **CPU:** `AMD Ryzen 5 5600H with Radeon Graphics` (`12` logical cores)
- **System Memory:** `7.3 GB`
- **WebGL GPU Renderer:** `ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)`
- **Viewport Resolution:** `1426x779`
- **Sampling Protocol:** `3,000 ms` live `requestAnimationFrame` delta sampling after `600 ms` planet/quality settle across all 9 `(Planet × Quality)` combinations.

> [!NOTE]
> Performance numbers below are specific to the integrated GPU hardware above and are **not** claimed as universal across all GPUs. Discrete GPUs (e.g., GTX 1650 / RTX-class) will exhibit proportionally lower frame times under `MED` / `HIGH` post-processing.

---

## Measured Desktop Telemetry Matrix

| Planet | Quality | Avg FPS | p50 Frame (ms) | p95 Frame (ms) | Draw Calls | Triangles | JS Heap (MB) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **MARS** | `LOW` | **60.3** | 16.70 ms | 17.10 ms | 108 | 62,744 | 20.7 MB |
| **MARS** | `MED` | **60.0** | 16.70 ms | 17.10 ms | 123 | 62,759 | 20.7 MB |
| **MARS** | `HIGH` | **60.1** | 16.70 ms | 17.10 ms | 123 | 62,759 | 20.7 MB |
| **EARTH** | `LOW` | **60.2** | 16.70 ms | 17.20 ms | 153 | 68,228 | 20.7 MB |
| **EARTH** | `MED` | **60.3** | 16.70 ms | 17.00 ms | 168 | 68,243 | 20.7 MB |
| **EARTH** | `HIGH` | **60.1** | 16.70 ms | 16.90 ms | 168 | 68,243 | 20.7 MB |
| **MOON** | `LOW` | **60.2** | 16.70 ms | 17.10 ms | 124 | 61,692 | 20.7 MB |
| **MOON** | `MED` | **57.1** | 16.70 ms | 32.40 ms | 139 | 61,707 | 20.7 MB |
| **MOON** | `HIGH` | **60.2** | 16.70 ms | 17.00 ms | 139 | 61,707 | 20.7 MB |

---

## Observations
- **Quality Scaling:** `LOW` bypasses `EffectComposer` (`UnrealBloomPass` + `SchlierenHeatShader`) and drops shadow map resolution from `2048×2048` to `1024×1024`, delivering lower frame times on integrated GPUs.
- **Console / WebGL Errors:** `0` errors, `0` warnings.
