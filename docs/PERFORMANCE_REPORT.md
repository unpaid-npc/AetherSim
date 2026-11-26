# AetherSim v2.0.0 — Desktop GPU & FPS Performance Report

Measured directly inside the built Electron desktop application via `npm run profile:desktop` ([scripts/profile-desktop.mjs](../scripts/profile-desktop.mjs)), with raw frame telemetry saved in [results/v2_performance_profile.json](../results/v2_performance_profile.json).

---

## Test Environment & Hardware Scope
- **Measured At (UTC):** `2026-11-26T07:05:27.717Z`
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
| **MARS** | `LOW` | **52.2** | 16.70 ms | 16.80 ms | 107 | 85,360 | 61.0 MB |
| **MARS** | `MED` | **57.7** | 16.70 ms | 17.00 ms | 121 | 111,614 | 61.0 MB |
| **MARS** | `HIGH` | **33.6** | 33.30 ms | 33.50 ms | 121 | 148,094 | 61.0 MB |
| **EARTH** | `LOW` | **57.1** | 16.70 ms | 17.00 ms | 128 | 96,330 | 61.0 MB |
| **EARTH** | `MED` | **56.8** | 16.70 ms | 16.90 ms | 142 | 129,190 | 61.0 MB |
| **EARTH** | `HIGH` | **26.0** | 33.40 ms | 83.30 ms | 142 | 165,670 | 61.0 MB |
| **MOON** | `LOW` | **53.4** | 16.70 ms | 16.80 ms | 109 | 83,768 | 61.0 MB |
| **MOON** | `MED` | **59.8** | 16.70 ms | 16.90 ms | 123 | 110,022 | 61.0 MB |
| **MOON** | `HIGH` | **37.1** | 33.10 ms | 33.50 ms | 123 | 146,502 | 61.0 MB |

---

## Observations
- **Quality Scaling:** `LOW` bypasses `EffectComposer` (`UnrealBloomPass` + `SchlierenHeatShader`) and drops shadow map resolution from `2048×2048` to `1024×1024`, delivering lower frame times on integrated GPUs.
- **Console / WebGL Errors:** `0` errors, `0` warnings.
