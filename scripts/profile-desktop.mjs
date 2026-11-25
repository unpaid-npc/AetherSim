import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronBinary from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

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
const hostInfo = {
  platform: `${os.type()} ${os.release()} (${os.arch()})`,
  cpuModel: cpus.length > 0 ? cpus[0].model.trim() : "Unknown CPU",
  logicalCores: cpus.length,
  totalRamGB: Number((os.totalmem() / (1024 * 1024 * 1024)).toFixed(1)),
  nodeVersion: process.version,
  electronVersion: process.versions.electron ?? "45.4.1",
  gpuRenderer: parsed.samples[0]?.rendererName ?? "Unknown WebGL Renderer",
  resolution: `${parsed.samples[0]?.canvasWidth ?? 0}x${parsed.samples[0]?.canvasHeight ?? 0}`,
};

const output = {
  generatedAtIso: new Date().toISOString(),
  profileStatus: parsed.profileStatus,
  host: hostInfo,
  samples: parsed.samples,
  warnings: parsed.warnings,
  errors: parsed.errors,
};

const resultsDir = path.join(rootDir, "results");
const docsDir = path.join(rootDir, "docs");
fs.mkdirSync(resultsDir, { recursive: true });
fs.mkdirSync(docsDir, { recursive: true });

fs.writeFileSync(
  path.join(resultsDir, "v1_performance_profile.json"),
  JSON.stringify(output, null, 2)
);

const tableHeader =
  "| Planet | Quality | Avg FPS | p50 Frame (ms) | p95 Frame (ms) | Draw Calls | Triangles | JS Heap (MB) |\n" +
  "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |";

const tableRows = output.samples.map((s) => {
  const heapStr = s.jsHeapUsedMB !== null ? `${s.jsHeapUsedMB.toFixed(1)} MB` : "N/A";
  return `| **${s.planet.toUpperCase()}** | \`${s.quality.toUpperCase()}\` | **${s.avgFps.toFixed(1)}** | ${s.p50FrameMs.toFixed(2)} ms | ${s.p95FrameMs.toFixed(2)} ms | ${s.drawCalls} | ${s.triangles.toLocaleString("en-US")} | ${heapStr} |`;
});

const reportMd = `# AetherSim v1.0.0 — Desktop GPU & FPS Performance Report

Measured directly inside the built Electron desktop application via \`npm run profile:desktop\` ([scripts/profile-desktop.mjs](../scripts/profile-desktop.mjs)), with raw frame telemetry saved in [results/v1_performance_profile.json](../results/v1_performance_profile.json).

---

## Test Environment & Hardware Scope
- **Measured At (UTC):** \`${output.generatedAtIso}\`
- **OS / Architecture:** \`${hostInfo.platform}\`
- **CPU:** \`${hostInfo.cpuModel}\` (\`${hostInfo.logicalCores}\` logical cores)
- **System Memory:** \`${hostInfo.totalRamGB} GB\`
- **WebGL GPU Renderer:** \`${hostInfo.gpuRenderer}\`
- **Viewport Resolution:** \`${hostInfo.resolution}\`
- **Sampling Protocol:** \`3,000 ms\` live \`requestAnimationFrame\` delta sampling after \`600 ms\` planet/quality settle across all 9 \`(Planet × Quality)\` combinations.

> [!NOTE]
> Performance numbers below are specific to the integrated GPU hardware above and are **not** claimed as universal across all GPUs. Discrete GPUs (e.g., GTX 1650 / RTX-class) will exhibit proportionally lower frame times under \`MED\` / \`HIGH\` post-processing.

---

## Measured Desktop Telemetry Matrix

${tableHeader}
${tableRows.join("\n")}

---

## Observations
- **Quality Scaling:** \`LOW\` bypasses \`EffectComposer\` (\`UnrealBloomPass\` + \`SchlierenHeatShader\`) and drops shadow map resolution from \`2048×2048\` to \`1024×1024\`, delivering lower frame times on integrated GPUs.
- **Console / WebGL Errors:** \`${output.errors.length}\` errors, \`${output.warnings.length}\` warnings.
`;

fs.writeFileSync(path.join(docsDir, "PERFORMANCE_REPORT.md"), reportMd);

console.log(`Desktop profile saved (${output.profileStatus}). Host GPU: ${hostInfo.gpuRenderer}`);
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
