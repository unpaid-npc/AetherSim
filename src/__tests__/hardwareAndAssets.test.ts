import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { AssetPipeline } from "../scene/AssetPipeline";
import {
  SHADOW_DISABLE_ALTITUDE_M,
  ShadowSystem,
  ensureCascadedShadowShaderChunk,
  getShadowQualityConfig,
} from "../scene/ShadowSystem";
import {
  PCI_VENDOR_AMD,
  PCI_VENDOR_NVIDIA,
  type SystemHardwareInfo,
  classifySystemGpuAdapter,
  cleanCpuModel,
  parseGpuRenderer,
  resolveHardwareDiagnostics,
} from "../utils/hardwareInfo";

describe("Phase B1 — Hardware Diagnostics & GPU Classifier", () => {
  it("parses NVIDIA discrete GPU ANGLE renderer string accurately", () => {
    const parsed = parseGpuRenderer(
      "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F9D) Direct3D11 vs_5_0 ps_5_0, D3D11)"
    );
    expect(parsed.shortName).toBe("NVIDIA GeForce GTX 1650");
    expect(parsed.vendor).toBe("NVIDIA");
    expect(parsed.gpuTier).toBe("dgpu");
    expect(parsed.tag).toBe("dGPU");
  });

  it("parses AMD Ryzen integrated GPU and discrete RX GPUs separately", () => {
    const igpu = parseGpuRenderer(
      "ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)"
    );
    expect(igpu.shortName).toBe("AMD Radeon Vega (iGPU)");
    expect(igpu.gpuTier).toBe("igpu");
    expect(igpu.tag).toBe("iGPU");

    const dgpu = parseGpuRenderer(
      "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)"
    );
    expect(dgpu.shortName).toBe("AMD Radeon RX 6700 XT");
    expect(dgpu.gpuTier).toBe("dgpu");
    expect(dgpu.tag).toBe("dGPU");
  });

  it("classifies SwiftShader and software rasterizers cleanly", () => {
    const sw = parseGpuRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))");
    expect(sw.gpuTier).toBe("software");
    expect(sw.tag).toBe("SW");
    expect(sw.shortName).toContain("SwiftShader");
  });

  it("cleans Ryzen CPU names and flags hybrid-laptop iGPU fallback accurately", () => {
    expect(cleanCpuModel("AMD Ryzen 5 5600H with Radeon Graphics         ")).toBe(
      "AMD Ryzen 5 5600H"
    );

    const hybridHost: SystemHardwareInfo = {
      cpuModel: "AMD Ryzen 5 5600H with Radeon Graphics",
      cpuCores: 12,
      totalRamGb: 16,
      gpuDevices: [
        {
          vendorId: PCI_VENDOR_AMD,
          deviceId: 0x1638,
          vendorName: "AMD",
          deviceString: "AMD Radeon(TM) Graphics",
          active: true,
          tier: classifySystemGpuAdapter(PCI_VENDOR_AMD, "AMD Radeon(TM) Graphics"),
        },
        {
          vendorId: PCI_VENDOR_NVIDIA,
          deviceId: 0x1f9d,
          vendorName: "NVIDIA",
          deviceString: "NVIDIA GeForce GTX 1650",
          active: false,
          tier: classifySystemGpuAdapter(PCI_VENDOR_NVIDIA, "NVIDIA GeForce GTX 1650"),
        },
      ],
    };

    const onIgpu = resolveHardwareDiagnostics(
      "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
      hybridHost,
      64 * 1024 * 1024,
      2,
      2
    );
    expect(onIgpu.cpuModel).toBe("AMD Ryzen 5 5600H");
    expect(onIgpu.cpuCores).toBe(12);
    expect(onIgpu.gpuTier).toBe("igpu");
    expect(onIgpu.isHybridOnIgpu).toBe(true);
    expect(onIgpu.detectedDiscreteGpuName).toBe("NVIDIA GeForce GTX 1650");
    expect(onIgpu.estimatedVramMB).toBeCloseTo(64, 1);

    const onDgpu = resolveHardwareDiagnostics(
      "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      hybridHost,
      64 * 1024 * 1024,
      2,
      3
    );
    expect(onDgpu.gpuTier).toBe("dgpu");
    expect(onDgpu.isHybridOnIgpu).toBe(false);
    expect(onDgpu.shadowCascades).toBe(3);
  });
});

describe("Phase B1 — Offline glTF/GLB + Draco + KTX2 AssetPipeline", () => {
  it("caches templates, clones instances, estimates VRAM, and disposes cleanly", async () => {
    const pipeline = new AssetPipeline(null);

    const template = new THREE.Group();
    const geom = new THREE.BoxGeometry(10, 20, 10);
    const tex = new THREE.DataTexture(new Uint8Array(64 * 64 * 4), 64, 64, THREE.RGBAFormat);
    tex.generateMipmaps = true;
    const mat = new THREE.MeshStandardMaterial({ map: tex });
    template.add(new THREE.Mesh(geom, mat));

    pipeline.registerTemplate("./models/test_unit.glb", template);
    expect(pipeline.hasCachedAsset("./models/test_unit.glb")).toBe(true);
    expect(pipeline.getLoadedAssetCount()).toBe(1);
    expect(pipeline.getEstimatedVramBytes()).toBeGreaterThan(64 * 64 * 4);

    const cloneA = await pipeline.loadModelInstance("./models/test_unit.glb", {
      maxAnisotropy: 4,
      castShadow: true,
      receiveShadow: true,
    });
    const cloneB = await pipeline.loadModelInstance("./models/test_unit.glb");

    expect(cloneA).not.toBeNull();
    expect(cloneB).not.toBeNull();
    expect(cloneA).not.toBe(cloneB);
    const meshA = cloneA!.children[0] as THREE.Mesh;
    expect(meshA.castShadow).toBe(true);
    expect(meshA.receiveShadow).toBe(true);

    pipeline.disposeAll();
    expect(pipeline.getLoadedAssetCount()).toBe(0);
    expect(pipeline.getEstimatedVramBytes()).toBe(0);
  });

  it("degrades gracefully with null when loading missing assets in headless mode", async () => {
    const pipeline = new AssetPipeline(null);
    const missing = await pipeline.loadModelInstance("./models/does_not_exist.glb");
    expect(missing).toBeNull();
    expect(pipeline.getLoadedAssetCount()).toBe(0);
    pipeline.disposeAll();
  });

  it("ships valid offline Draco/Basis decoders and Starbase binary glTF 2.0 hero GLBs", () => {
    const root = process.cwd();
    const requiredFiles = [
      "public/decoders/draco/draco_decoder.js",
      "public/decoders/draco/draco_decoder.wasm",
      "public/decoders/draco/draco_wasm_wrapper.js",
      "public/decoders/basis/basis_transcoder.js",
      "public/decoders/basis/basis_transcoder.wasm",
      "public/models/starbase_megabay.glb",
      "public/models/tracking_radome.glb",
    ];
    for (const rel of requiredFiles) {
      const abs = path.join(root, rel);
      expect(fs.existsSync(abs), `Missing offline asset ${rel}`).toBe(true);
      expect(fs.statSync(abs).size).toBeGreaterThan(1024);
    }

    // Check glTF 2.0 binary magic header ('glTF' = 0x46546C67)
    for (const glbRel of [
      "public/models/starbase_megabay.glb",
      "public/models/tracking_radome.glb",
    ]) {
      const buf = fs.readFileSync(path.join(root, glbRel));
      expect(buf.readUInt32LE(0)).toBe(0x46546c67);
      expect(buf.readUInt32LE(4)).toBe(2);
    }
  });
});

describe("Phase B1 — Log-Depth-Safe Multi-Cascade ShadowSystem", () => {
  it("installs idempotent CSM shader chunk and maps LOW/MED/HIGH cascade configs", () => {
    expect(ensureCascadedShadowShaderChunk()).toBe(true);
    expect(THREE.ShaderChunk.lights_fragment_begin).toContain(
      "AetherSim multi-cascade directional sun shadows"
    );

    const lowCfg = getShadowQualityConfig("low");
    const medCfg = getShadowQualityConfig("med");
    const highCfg = getShadowQualityConfig("high");

    expect(lowCfg.cascadeCount).toBe(1);
    expect(lowCfg.cascades[0].mapSize).toBe(1024);

    expect(medCfg.cascadeCount).toBe(2);
    expect(medCfg.cascades[0].radiusM).toBe(180);
    expect(medCfg.cascades[1].radiusM).toBe(1400);

    expect(highCfg.cascadeCount).toBe(3);
    expect(highCfg.cascades[0].radiusM).toBe(180);
    expect(highCfg.cascades[1].radiusM).toBe(1400);
    expect(highCfg.cascades[2].radiusM).toBe(6000);
  });

  it("keeps aux cascade intensity at 0, texel-snaps in world space, and disables above 15 km", () => {
    const scene = new THREE.Scene();
    const shadows = new ShadowSystem(scene, "high");
    shadows.setPlanetLighting([0.6, 0.4, -0.7], "#fff7ea", 3.1);

    // Primary cascade carries full sunlight; aux cascades stay 0 to eliminate double-lighting
    expect(shadows.lights[0].intensity).toBeCloseTo(3.1, 4);
    expect(shadows.lights[1].intensity).toBe(0);
    expect(shadows.lights[2].intensity).toBe(0);
    expect(shadows.getActiveCascadeCount()).toBe(3);

    // Verify floating-origin cancellation: shifting camera renderOrigin keeps world target locked
    const anchorWorld = { x: 12.3, y: 60.0, z: -8.7 };
    shadows.update(anchorWorld, { x: 0, y: 0, z: 0 }, 120);
    const worldTargetA = shadows.lights[0].target.position.clone();

    const originShift = { x: 145.6, y: 42.1, z: -89.4 };
    shadows.update(anchorWorld, originShift, 120);
    const worldTargetB = shadows.lights[0].target.position
      .clone()
      .add(new THREE.Vector3(originShift.x, originShift.y, originShift.z));

    expect(worldTargetA.distanceTo(worldTargetB)).toBeLessThan(1e-4);

    // Auto-disable shadows cleanly above 15 km camera altitude
    shadows.update(anchorWorld, originShift, SHADOW_DISABLE_ALTITUDE_M + 250);
    expect(shadows.isShadowsEnabled()).toBe(false);
    expect(shadows.getActiveCascadeCount()).toBe(0);
    expect(shadows.lights.every((l) => !l.castShadow)).toBe(true);
    expect(shadows.lights[0].visible).toBe(true);
    expect(shadows.lights[1].visible).toBe(false);
    expect(shadows.lights[2].visible).toBe(false);

    // Re-enables cleanly when descending below 15 km
    shadows.update(anchorWorld, originShift, 5000);
    expect(shadows.isShadowsEnabled()).toBe(true);
    expect(shadows.getActiveCascadeCount()).toBe(3);
    expect(shadows.lights[0].castShadow).toBe(true);
    expect(shadows.lights[1].castShadow).toBe(true);
    expect(shadows.lights[2].castShadow).toBe(true);

    // Switching to LOW drops to 1 active cascade
    shadows.setQuality("low");
    expect(shadows.getActiveCascadeCount()).toBe(1);
    expect(shadows.lights[0].castShadow).toBe(true);
    expect(shadows.lights[1].castShadow).toBe(false);
    expect(shadows.lights[2].castShadow).toBe(false);

    shadows.dispose();
  });
});
