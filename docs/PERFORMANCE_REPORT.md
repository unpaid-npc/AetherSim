# AetherSim v2.0.0 — Desktop GPU & FPS Performance Report

Measured directly inside the built Electron desktop application via `npm run profile:desktop` ([scripts/profile-desktop.mjs](../scripts/profile-desktop.mjs)), with raw frame telemetry saved in [results/v2_performance_profile.json](../results/v2_performance_profile.json).

---

## Test Environment & Hardware Scope
- **Measured At (UTC):** `2026-11-26T08:37:21.564Z`
- **OS / Architecture:** `Windows_NT 10.0.26300 (x64)`
- **CPU:** `AMD Ryzen 5 5600H` (`12` logical cores)
- **System Memory:** `7.3 GB`
- **Active GPU:** `NVIDIA GeForce GTX 1650` (`tier: dgpu`, `hybridOnIgpu: false`)
- **Raw WebGL Renderer:** `ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F99) Direct3D11 vs_5_0 ps_5_0, D3D11)`
- **Loaded Hero GLB Assets / VRAM Est.:** `2` models / `75.9 MB`
- **Viewport Resolution:** `1426x779`
- **Sampling Protocol:** `3,000 ms` live `requestAnimationFrame` delta sampling after `600 ms` planet/quality settle across all 9 `(Planet × Quality)` combinations.

> [!NOTE]
> Measured on discrete GPU (`NVIDIA GeForce GTX 1650`) with hardware-accelerated WebGL2 and Cascaded Shadow Maps (`LOW`: 1×, `MED`: 2×, `HIGH`: 3×).

---

## Measured Desktop Telemetry Matrix

| Planet | Quality | Avg FPS | p50 Frame (ms) | p95 Frame (ms) | Draw Calls | Triangles | Shadows | JS Heap (MB) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **MARS** | `LOW` | **55.3** | 16.70 ms | 16.80 ms | 107 | 85,360 | 1× CSM | 57.5 MB |
| **MARS** | `MED` | **60.1** | 16.70 ms | 16.90 ms | 147 | 124,318 | 2× CSM | 57.5 MB |
| **MARS** | `HIGH` | **60.2** | 16.70 ms | 16.80 ms | 173 | 173,502 | 3× CSM | 57.5 MB |
| **EARTH** | `LOW` | **57.8** | 16.70 ms | 16.90 ms | 134 | 97,114 | 1× CSM | 57.5 MB |
| **EARTH** | `MED` | **59.7** | 16.70 ms | 17.00 ms | 198 | 139,010 | 2× CSM | 57.5 MB |
| **EARTH** | `HIGH` | **59.9** | 16.70 ms | 16.90 ms | 254 | 185,310 | 3× CSM | 57.5 MB |
| **MOON** | `LOW` | **54.0** | 16.70 ms | 17.00 ms | 109 | 83,768 | 1× CSM | 57.5 MB |
| **MOON** | `MED` | **59.9** | 16.70 ms | 17.00 ms | 146 | 120,634 | 2× CSM | 57.5 MB |
| **MOON** | `HIGH` | **60.2** | 16.70 ms | 16.80 ms | 170 | 167,790 | 3× CSM | 57.5 MB |

---

## Observations
- **Quality & Shadow Scaling:** `LOW` uses a single `1024×1024` texel-snapped directional shadow map and bypasses `EffectComposer` bloom; `MED` enables 2-cascade CSM (`2048` + `1024`); `HIGH` enables full 3-cascade CSM (`2048` + `2048` + `1024`) up to `6 km`. All cascades auto-disable cleanly above `15 km` camera altitude.
- **Console / WebGL Errors:** `0` errors, `0` warnings.
