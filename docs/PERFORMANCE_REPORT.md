# AetherSim v2.0.0 — Desktop GPU & FPS Performance Report

Measured directly inside the built Electron desktop application via `npm run profile:desktop` ([scripts/profile-desktop.mjs](../scripts/profile-desktop.mjs)), with raw frame telemetry saved in [results/v2_performance_profile.json](../results/v2_performance_profile.json).

---

## Test Environment & Hardware Scope
- **Measured At (UTC):** `2026-11-26T06:06:48.992Z`
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
| **MARS** | `LOW` | **58.9** | 16.70 ms | 17.10 ms | 106 | 85,220 | 33.5 MB |
| **MARS** | `MED` | **53.5** | 16.70 ms | 33.20 ms | 120 | 111,474 | 33.5 MB |
| **MARS** | `HIGH` | **31.7** | 33.30 ms | 50.00 ms | 120 | 147,954 | 33.5 MB |
| **EARTH** | `LOW` | **45.1** | 16.70 ms | 50.80 ms | 128 | 96,330 | 33.5 MB |
| **EARTH** | `MED` | **25.9** | 33.30 ms | 99.60 ms | 142 | 129,190 | 33.5 MB |
| **EARTH** | `HIGH` | **23.3** | 49.80 ms | 50.60 ms | 142 | 165,670 | 33.5 MB |
| **MOON** | `LOW` | **53.1** | 16.70 ms | 17.00 ms | 109 | 83,768 | 33.5 MB |
| **MOON** | `MED` | **42.2** | 16.80 ms | 33.50 ms | 123 | 110,022 | 33.5 MB |
| **MOON** | `HIGH` | **35.3** | 33.20 ms | 33.60 ms | 123 | 146,502 | 33.5 MB |

---

## Observations
- **Quality Scaling:** `LOW` bypasses `EffectComposer` (`UnrealBloomPass` + `SchlierenHeatShader`) and drops shadow map resolution from `2048×2048` to `1024×1024`, delivering lower frame times on integrated GPUs.
- **Console / WebGL Errors:** `0` errors, `0` warnings.
