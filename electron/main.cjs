const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

const isSmokeTest = process.env.ELECTRON_SMOKE_TEST === "1";
const isProfile = process.env.ELECTRON_PROFILE === "1";
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

app.commandLine.appendSwitch("enable-webgl");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
if (isProfile) {
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}

const mainErrors = [];

process.on("uncaughtException", (err) => {
  mainErrors.push(`uncaughtException: ${err && err.stack ? err.stack : String(err)}`);
});

process.on("unhandledRejection", (reason) => {
  mainErrors.push(`unhandledRejection: ${String(reason)}`);
});

function installDevCspHeaders() {
  if (!devServerUrl) {
    return;
  }
  const devCsp =
    "default-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173; " +
    "script-src 'self' 'unsafe-inline' http://127.0.0.1:5173; " +
    "worker-src 'self' blob: http://127.0.0.1:5173; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173;";

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [devCsp],
      },
    });
  });
}

function createWindow() {
  const icoPath = path.join(__dirname, "..", "build", "icon.ico");
  const icon = fs.existsSync(icoPath) ? icoPath : undefined;

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: "AetherSim — 3D Aerospace Launch & Landing Simulator",
    backgroundColor: "#05070d",
    icon,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
    },
  });

  const rendererErrors = [];
  const rendererWarnings = [];

  win.once("ready-to-show", () => {
    if (!isSmokeTest) {
      win.show();
    }
  });

  win.webContents.on("console-message", (event) => {
    const level = event.level;
    const message = event.message;
    const line = event.lineNumber;
    const sourceId = event.sourceId;
    if (level === "error" || level >= 3) {
      rendererErrors.push(`console.error (${sourceId}:${line}): ${message}`);
    } else if (level === "warning" || level >= 2) {
      rendererWarnings.push(`console.warn (${sourceId}:${line}): ${message}`);
    }
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    rendererErrors.push(`did-fail-load (${errorCode}) ${validatedURL}: ${errorDescription}`);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    rendererErrors.push(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });

  if (isSmokeTest) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const diagnostics = await win.webContents.executeJavaScript(`
            (() => {
              const canvas = document.getElementById('sim-canvas');
              const rect = canvas ? canvas.getBoundingClientRect() : null;
              return {
                title: document.title,
                hasDesktopBridge: Boolean(window.desktopApp && window.desktopApp.isElectron),
                canvasWidth: rect ? Math.round(rect.width) : 0,
                canvasHeight: rect ? Math.round(rect.height) : 0,
                sim: window.__STARSHIP_SIM__ || null,
              };
            })()
          `);
          const allErrors = [...mainErrors, ...rendererErrors];
          const ok =
            allErrors.length === 0 &&
            diagnostics &&
            diagnostics.hasDesktopBridge &&
            diagnostics.canvasWidth > 0 &&
            diagnostics.canvasHeight > 0 &&
            diagnostics.sim &&
            diagnostics.sim.ready === true;

          console.log(
            JSON.stringify(
              {
                smokeStatus: ok ? "SMOKE_OK" : "SMOKE_FAIL",
                diagnostics,
                warnings: rendererWarnings,
                errors: allErrors,
              },
              null,
              2
            )
          );
          app.exit(ok ? 0 : 1);
        } catch (err) {
          console.error("SMOKE_FAIL:", err);
          app.exit(1);
        }
      }, 4000);
    });
  } else if (isProfile) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const results = await win.webContents.executeJavaScript(`
            (async () => {
              const api = window.__AETHERSIM_PROFILER__;
              if (!api) {
                throw new Error('Missing window.__AETHERSIM_PROFILER__');
              }
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              const planets = ['mars', 'earth', 'moon'];
              const qualities = ['low', 'med', 'high'];
              const samples = [];
              for (const planet of planets) {
                api.setPlanet(planet);
                for (const quality of qualities) {
                  api.setQuality(quality);
                  await sleep(600);
                  const stats = await api.sampleFrames(3000);
                  samples.push({ planet, quality, ...stats });
                }
              }
              return samples;
            })()
          `);
          const allErrors = [...mainErrors, ...rendererErrors];
          const ok = allErrors.length === 0 && Array.isArray(results) && results.length === 9;
          console.log("PROFILE_JSON_START");
          console.log(
            JSON.stringify(
              {
                profileStatus: ok ? "PROFILE_OK" : "PROFILE_FAIL",
                samples: results,
                warnings: rendererWarnings,
                errors: allErrors,
              },
              null,
              2
            )
          );
          console.log("PROFILE_JSON_END");
          app.exit(ok ? 0 : 1);
        } catch (err) {
          console.error("PROFILE_FAIL:", err);
          app.exit(1);
        }
      }, 2200);
    });
  }

  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  installDevCspHeaders();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
