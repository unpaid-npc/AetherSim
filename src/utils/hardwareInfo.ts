export type GpuTier = "dgpu" | "igpu" | "software" | "unknown";

export type GpuTierTag = "dGPU" | "iGPU" | "SW" | "GPU";

export interface SystemGpuAdapter {
  vendorId: number;
  deviceId: number;
  vendorName: string;
  deviceString: string;
  active: boolean;
  tier: GpuTier;
}

export interface SystemHardwareInfo {
  cpuModel: string;
  cpuCores: number;
  totalRamGb: number;
  gpuDevices: SystemGpuAdapter[];
}

export interface ParsedGpuRenderer {
  rawRenderer: string;
  shortName: string;
  vendor: string;
  gpuTier: GpuTier;
  tag: GpuTierTag;
}

export interface ResolvedHardwareDiagnostics {
  cpuModel: string;
  cpuCores: number;
  totalRamGb: number;
  rawRenderer: string;
  gpuShortName: string;
  gpuVendor: string;
  gpuTier: GpuTier;
  gpuTag: GpuTierTag;
  isHybridOnIgpu: boolean;
  detectedDiscreteGpuName: string | null;
  estimatedVramMB: number;
  glbLoadedCount: number;
  shadowCascades: number;
}

export const PCI_VENDOR_NVIDIA = 0x10de;
export const PCI_VENDOR_AMD = 0x1002;
export const PCI_VENDOR_INTEL = 0x8086;
export const PCI_VENDOR_MICROSOFT = 0x1414;

export function cleanCpuModel(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") {
    return "Host CPU";
  }
  const normalized = raw
    .replace(/\((R|TM|C)\)/gi, "")
    .replace(/\bwith Radeon.*$/i, "")
    .replace(/\bCPU\s*@\s*[\d.]+\s*GHz\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : "Host CPU";
}

export function getVendorNameFromPciId(vendorId: number): string {
  switch (vendorId) {
    case PCI_VENDOR_NVIDIA:
      return "NVIDIA";
    case PCI_VENDOR_AMD:
      return "AMD";
    case PCI_VENDOR_INTEL:
      return "Intel";
    case PCI_VENDOR_MICROSOFT:
      return "Microsoft";
    default:
      return "Unknown";
  }
}

export function classifySystemGpuAdapter(
  vendorId: number,
  deviceString = ""
): GpuTier {
  const s = deviceString.trim();
  if (/swiftshader|llvmpipe|softpipe|basic render|warp/i.test(s)) {
    return "software";
  }
  if (vendorId === PCI_VENDOR_MICROSOFT) {
    return "software";
  }
  if (vendorId === PCI_VENDOR_NVIDIA || /\bnvidia|geforce|quadro|rtx|gtx|tesla\b/i.test(s)) {
    return "dgpu";
  }
  if (vendorId === PCI_VENDOR_AMD || /\bamd|radeon\b/i.test(s)) {
    if (
      /\b(RX\s*\d|R9\b|R7\b|Pro\s*W|FirePro|Vega\s*(56|64|Frontier)|Fury|Instinct|XT\b|XTX\b)\b/i.test(
        s
      )
    ) {
      return "dgpu";
    }
    return "igpu";
  }
  if (vendorId === PCI_VENDOR_INTEL || /\bintel\b/i.test(s)) {
    if (/\bArc\b/i.test(s) && !/\bArc\(TM\)\s*Graphics\b/i.test(s)) {
      return "dgpu";
    }
    return "igpu";
  }
  return "unknown";
}

function tierToTag(tier: GpuTier): GpuTierTag {
  switch (tier) {
    case "dgpu":
      return "dGPU";
    case "igpu":
      return "iGPU";
    case "software":
      return "SW";
    default:
      return "GPU";
  }
}

function extractCoreDeviceString(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "WebGL GPU";
  }

  // Handle Chromium ANGLE format:
  // "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F9D) Direct3D11 vs_5_0 ps_5_0, D3D11)"
  // or "ANGLE (AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0)"
  const angleMatch = trimmed.match(/^ANGLE\s*\((.+)\)$/i);
  let inner = angleMatch ? angleMatch[1].trim() : trimmed;

  // Split top-level comma segments (e.g., vendor, device, backend)
  const parts = inner.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // Pick the segment with the actual device name (skip short vendor prefix like "NVIDIA" or "AMD")
    const candidate = parts.find(
      (p) =>
        !/^(NVIDIA|AMD|ATI|Intel|Google|Apple|Qualcomm|ARM|Microsoft|D3D11|D3D9|OpenGL|Metal|Vulkan)$/i.test(
          p
        )
    );
    if (candidate) {
      inner = candidate;
    }
  }

  // Strip API/shader suffixes and hex PCI device IDs
  inner = inner
    .replace(/\(\s*0x[0-9a-f]+\s*\)/gi, "")
    .replace(/\bDirect3D\d*\b.*$/i, "")
    .replace(/\bD3D\d+\b.*$/i, "")
    .replace(/\bvs_\d+_\d+.*$/i, "")
    .replace(/\bOpenGL\b.*$/i, "")
    .replace(/\bVulkan\s*[\d.]*\s*\((.+)\)/i, "$1")
    .replace(/\/PCIe\/SSE2$/i, "")
    .replace(/\((R|TM|C)\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return inner || trimmed;
}

export function parseGpuRenderer(rawWebGLRenderer: string): ParsedGpuRenderer {
  const raw = (rawWebGLRenderer || "").trim() || "WebGL";
  const core = extractCoreDeviceString(raw);
  const combined = `${raw} ${core}`;

  // Software renderers
  if (/swiftshader|llvmpipe|softpipe|microsoft basic render|software rasterizer|mesa offscreen/i.test(combined)) {
    const swName = /swiftshader/i.test(combined)
      ? "SwiftShader (Software)"
      : /llvmpipe/i.test(combined)
        ? "llvmpipe (Software)"
        : "Software Renderer";
    return {
      rawRenderer: raw,
      shortName: swName,
      vendor: "Software",
      gpuTier: "software",
      tag: "SW",
    };
  }

  // NVIDIA discrete GPUs
  if (/\bnvidia|geforce|quadro|rtx\s*\d|gtx\s*\d|titan|mx\d{3}\b/i.test(combined)) {
    let shortName = core;
    if (!/^NVIDIA\b/i.test(shortName)) {
      shortName = `NVIDIA ${shortName}`;
    }
    return {
      rawRenderer: raw,
      shortName: shortName.replace(/\s+/g, " ").trim(),
      vendor: "NVIDIA",
      gpuTier: "dgpu",
      tag: "dGPU",
    };
  }

  // AMD GPUs (distinguish discrete Radeon RX / Pro vs Ryzen integrated Radeon)
  if (/\bamd|radeon|ati\b/i.test(combined)) {
    const isDiscrete =
      /\b(RX\s*\d|R9\b|R7\b|Pro\s*W|FirePro|Vega\s*(56|64|Frontier)|Fury|Instinct|XT\b|XTX\b)\b/i.test(
        combined
      );
    let shortName = core;
    if (/^AMD Radeon Graphics$/i.test(shortName) || /^Radeon Graphics$/i.test(shortName)) {
      shortName = "AMD Radeon Vega (iGPU)";
    } else if (!/^AMD\b/i.test(shortName)) {
      shortName = `AMD ${shortName}`;
    }
    const tier: GpuTier = isDiscrete ? "dgpu" : "igpu";
    return {
      rawRenderer: raw,
      shortName: shortName.replace(/\s+/g, " ").trim(),
      vendor: "AMD",
      gpuTier: tier,
      tag: tierToTag(tier),
    };
  }

  // Intel GPUs (discrete Arc A/B series vs integrated UHD / Iris / HD)
  if (/\bintel|iris|uhd\s*graphics|hd\s*graphics|arc\b/i.test(combined)) {
    const isDiscreteArc = /\bArc\s*[AB]\d{3}/i.test(combined);
    const tier: GpuTier = isDiscreteArc ? "dgpu" : "igpu";
    let shortName = core;
    if (!/^Intel\b/i.test(shortName)) {
      shortName = `Intel ${shortName}`;
    }
    return {
      rawRenderer: raw,
      shortName: shortName.replace(/\s+/g, " ").trim(),
      vendor: "Intel",
      gpuTier: tier,
      tag: tierToTag(tier),
    };
  }

  // Apple Silicon GPUs (unified SoC — integrated tier, not hybrid Windows laptop)
  if (/\bapple\s*(m\d|gpu)/i.test(combined)) {
    return {
      rawRenderer: raw,
      shortName: core,
      vendor: "Apple",
      gpuTier: "igpu",
      tag: "iGPU",
    };
  }

  return {
    rawRenderer: raw,
    shortName: core.length > 34 ? `${core.slice(0, 31)}...` : core,
    vendor: "Unknown",
    gpuTier: "unknown",
    tag: "GPU",
  };
}

export function detectDiscreteGpuInSystem(
  gpuDevices: readonly SystemGpuAdapter[] | undefined
): string | null {
  if (!gpuDevices || gpuDevices.length === 0) {
    return null;
  }
  const discrete = gpuDevices.find((dev) => dev.tier === "dgpu");
  if (!discrete) {
    return null;
  }
  if (discrete.deviceString && discrete.deviceString.trim().length > 0) {
    return discrete.deviceString.trim();
  }
  return `${discrete.vendorName || getVendorNameFromPciId(discrete.vendorId)} Discrete GPU`;
}

export function resolveHardwareDiagnostics(
  rawWebGLRenderer: string,
  systemInfo: SystemHardwareInfo | null,
  estimatedVramBytes = 0,
  glbLoadedCount = 0,
  shadowCascades = 1
): ResolvedHardwareDiagnostics {
  const parsed = parseGpuRenderer(rawWebGLRenderer);
  const detectedDiscreteGpuName = detectDiscreteGpuInSystem(systemInfo?.gpuDevices);
  const isHybridOnIgpu =
    (parsed.gpuTier === "igpu" || parsed.gpuTier === "software") &&
    detectedDiscreteGpuName !== null;

  const fallbackCores =
    typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 0;

  return {
    cpuModel: cleanCpuModel(systemInfo?.cpuModel),
    cpuCores: systemInfo?.cpuCores ?? fallbackCores,
    totalRamGb: systemInfo?.totalRamGb ?? 0,
    rawRenderer: parsed.rawRenderer,
    gpuShortName: parsed.shortName,
    gpuVendor: parsed.vendor,
    gpuTier: parsed.gpuTier,
    gpuTag: parsed.tag,
    isHybridOnIgpu,
    detectedDiscreteGpuName,
    estimatedVramMB: Number((Math.max(0, estimatedVramBytes) / (1024 * 1024)).toFixed(1)),
    glbLoadedCount,
    shadowCascades,
  };
}
