import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronBinary from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const isProd = args.has("--prod");
const isSmokeTest = args.has("--smoke-test");

const DEV_URL = "http://127.0.0.1:5173";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch {
      // Server still booting
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Vite dev server at ${url}`);
}

function launchElectron(extraEnv = {}) {
  const env = {
    ...process.env,
    ...extraEnv,
    ...(isSmokeTest ? { ELECTRON_SMOKE_TEST: "1" } : {}),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  return spawn(String(electronBinary), [rootDir], {
    cwd: rootDir,
    stdio: "inherit",
    env,
  });
}

if (isProd) {
  const child = launchElectron();
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  const viteBin = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
  const viteProc = spawn(
    process.execPath,
    [viteBin, "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
    { cwd: rootDir, stdio: "inherit" }
  );

  const cleanup = () => {
    if (!viteProc.killed) {
      viteProc.kill();
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    await waitForServer(DEV_URL);
    const electronProc = launchElectron({ VITE_DEV_SERVER_URL: DEV_URL });
    electronProc.on("exit", (code) => {
      cleanup();
      process.exit(code ?? 0);
    });
  } catch (err) {
    console.error(err);
    cleanup();
    process.exit(1);
  }
}
