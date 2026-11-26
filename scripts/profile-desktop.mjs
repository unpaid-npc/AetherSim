import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronBinary from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const appVersion = pkg.version || "2.0.0";
const majorPrefix = `v${String(appVersion).split(".")[0]}`;

const distIndex = path.join(rootDir, "dist", "index.html");
if (!fs.existsSync(distIndex)) {
  console.error("Missing dist/index.html — run `npm run build` before profiling.");
  process.exit(1);
}

const env = { ...process.env, ELECTRON_PROFILE: "1" };
delete env.ELECTRON_RUN_AS_NODE;

const stdoutChunks = [];
const stderrChunks = [];

const child = spawn(String(electronBinary), [rootDir], {
  cwd: rootDir,
  stdio: ["ignore", "pipe", "pipe"],
  env,
});

child.stdout.on("data", (d) => stdoutChunks.push(d.toString("utf8")));
child.stderr.on("data", (d) => stderrChunks.push(d.toString("utf8")));

const exitCode = await new Promise((resolve) => {
  child.on("exit", (code) => resolve(code ?? 1));
});

const fullStdout = stdoutChunks.join("");
const startMarker = "PROFILE_JSON_START";
const endMarker = "PROFILE_JSON_END";
const iStart = fullStdout.indexOf(startMarker);
const iEnd = fullStdout.indexOf(endMarker);

if (exitCode !== 0 || iStart === -1 || iEnd === -1) {
  console.error("Desktop profiling failed (exitCode =", exitCode, ")");
  if (fullStdout) console.error("STDOUT:\n", fullStdout);
  if (stderrChunks.length) console.error("STDERR:\n", stderrChunks.join(""));
  process.exit(1);
}

const parsed = JSON.parse(fullStdout.slice(iStart + startMarker.length, iEnd).trim());
const cpus = os.cpus();
const firstSample = parsed.samples[0] ?? {};
const sysHw = parsed.systemHardware ?? null;
const cpuModel = firstSample.cpuModel || (cpus.length > 0 ? cpus[0].model.trim() : "Unknown CPU");
const cpuCores = firstSample.cpuCores || cpus.length;
const gpuShortName = firstSample.gpuShortName || firstSample.rendererName || "Unknown WebGL Renderer";
const gpuTier = firstSample.gpuTier || "unknown";
const isHybridOnIgpu = Boolean(firstSample.isHybridOnIgpu);

const hostInfo = {
  platform: `${os.type()} ${os.release()} (${os.arch()})`,
  cpuModel,
  cpuCores,
  logicalCores: cpuCores,
  totalRamGB: sysHw?.totalRamGb ?? Number((os.totalmem() / (1024 * 1024 * 1024)).toFixed(1)),
  nodeVersion: process.version,
  electronVersion: process.versions.electron ?? "45.4.1",
  gpuRenderer: firstSample.rendererName ?? "Unknown WebGL Renderer",
  gpuShortName,
  gpuTier,
  isHybridOnIgpu,
  glbLoadedCount: firstSample.glbLoadedCount ?? 0,
  estimatedVramMB: firstSample.estimatedVramMB ?? 0,
  resolution: `${firstSample.canvasWidth ?? 0}x${firstSample.canvasHeight ?? 0}`,
};

const output = {
  version: appVersion,
  generatedAtIso: new Date().toISOString(),
  profileStatus: parsed.profileStatus,
  host: hostInfo,
  systemHardware: sysHw,
  samples: parsed.samples,
  warnings: parsed.warnings,
  errors: parsed.errors,
};

const resultsDir = path.join(rootDir, "results");
const docsDir = path.join(rootDir, "docs");
fs.mkdirSync(resultsDir, { recursive: true });
fs.mkdirSync(docsDir, { recursive: true });

const profileFileName = `${majorPrefix}_performance_profile.json`;
fs.writeFileSync(
  path.join(resultsDir, profileFileName),
  JSON.stringify(output, null, 2)
);

const tableHeader =
  "| Planet | Quality | Avg FPS | p50 Frame (ms) | p95 Frame (ms) | Draw Calls | Triangles | Shadows | JS Heap (MB) |\n" +
  "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |";

const tableRows = output.samples.map((s) => {
  const heapStr = s.jsHeapUsedMB !== null ? `${s.jsHeapUsedMB.toFixed(1)} MB` : "N/A";
  const csmStr = `${s.shadowCascades ?? 1}× CSM`;
  return `| **${s.planet.toUpperCase()}** | \`${s.quality.toUpperCase()}\` | **${s.avgFps.toFixed(1)}** | ${s.p50FrameMs.toFixed(2)} ms | ${s.p95FrameMs.toFixed(2)} ms | ${s.drawCalls} | ${s.triangles.toLocaleString("en-US")} | ${csmStr} | ${heapStr} |`;
});

const gpuScopeNote =
  gpuTier === "dgpu"
    ? `Measured on discrete GPU (\`${gpuShortName}\`) with hardware-accelerated WebGL2 and Cascaded Shadow Maps (\`LOW\`: 1×, \`MED\`: 2×, \`HIGH\`: 3×).`
    : isHybridOnIgpu
      ? `Measured on integrated GPU (\`${gpuShortName}\`) on a hybrid-graphics laptop where a discrete GPU is also present. Set Windows Graphics Preference to **High Performance** for \`electron.exe\` to unlock discrete-GPU frame rates under \`MED\` / \`HIGH\`.`
      : `Performance numbers below are specific to the \`${gpuShortName}\` (\`${gpuTier}\`) hardware above and are **not** claimed as universal across all GPUs.`;

const reportMd = `# AetherSim v${appVersion} — Desktop GPU & FPS Performance Report

Measured directly inside the built Electron desktop application via \`npm run profile:desktop\` ([scripts/profile-desktop.mjs](../scripts/profile-desktop.mjs)), with raw frame telemetry saved in [results/${profileFileName}](../results/${profileFileName}).

---

## Test Environment & Hardware Scope
- **Measured At (UTC):** \`${output.generatedAtIso}\`
- **OS / Architecture:** \`${hostInfo.platform}\`
- **CPU:** \`${hostInfo.cpuModel}\` (\`${hostInfo.cpuCores}\` logical cores)
- **System Memory:** \`${hostInfo.totalRamGB} GB\`
- **Active GPU:** \`${hostInfo.gpuShortName}\` (\`tier: ${hostInfo.gpuTier}\`, \`hybridOnIgpu: ${hostInfo.isHybridOnIgpu}\`)
- **Raw WebGL Renderer:** \`${hostInfo.gpuRenderer}\`
- **Loaded Hero GLB Assets / VRAM Est.:** \`${hostInfo.glbLoadedCount}\` models / \`${hostInfo.estimatedVramMB} MB\`
- **Viewport Resolution:** \`${hostInfo.resolution}\`
- **Sampling Protocol:** \`3,000 ms\` live \`requestAnimationFrame\` delta sampling after \`600 ms\` planet/quality settle across all 9 \`(Planet × Quality)\` combinations.

> [!NOTE]
> ${gpuScopeNote}

---

## Measured Desktop Telemetry Matrix

${tableHeader}
${tableRows.join("\n")}

---

## Observations
- **Quality & Shadow Scaling:** \`LOW\` uses a single \`1024×1024\` texel-snapped directional shadow map and bypasses \`EffectComposer\` bloom; \`MED\` enables 2-cascade CSM (\`2048\` + \`1024\`); \`HIGH\` enables full 3-cascade CSM (\`2048\` + \`2048\` + \`1024\`) up to \`6 km\`. All cascades auto-disable cleanly above \`15 km\` camera altitude.
- **Console / WebGL Errors:** \`${output.errors.length}\` errors, \`${output.warnings.length}\` warnings.
`;

fs.writeFileSync(path.join(docsDir, "PERFORMANCE_REPORT.md"), reportMd);

console.log(
  `Desktop profile saved (${output.profileStatus}). CPU: ${hostInfo.cpuModel} (${hostInfo.cpuCores}T) | GPU: ${hostInfo.gpuShortName} [${hostInfo.gpuTier}] (hybridOnIgpu=${hostInfo.isHybridOnIgpu})`
);
console.table(
  output.samples.map((s) => ({
    planet: s.planet,
    quality: s.quality,
    avgFps: Number(s.avgFps.toFixed(1)),
    p50Ms: Number(s.p50FrameMs.toFixed(2)),
    p95Ms: Number(s.p95FrameMs.toFixed(2)),
    drawCalls: s.drawCalls,
    triangles: s.triangles,
    heapMB: s.jsHeapUsedMB,
  }))
);
