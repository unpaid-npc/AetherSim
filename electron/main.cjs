const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

const isSmokeTest = process.env.ELECTRON_SMOKE_TEST === "1";
const isProfile = process.env.ELECTRON_PROFILE === "1";
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

app.commandLine.appendSwitch("enable-webgl");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
if (devServerUrl) {
  app.commandLine.appendSwitch("proxy-bypass-list", "127.0.0.1;localhost");
}
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

app.on("child-process-gone", (_event, details) => {
  const entry = `child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`;
  mainErrors.push(entry);
  if (!isSmokeTest && !isProfile) {
    console.error(`[Main] ${entry}`);
  }
});

function installDevCspHeaders() {
  if (!devServerUrl) {
    return;
  }
  const devOrigin = new URL(devServerUrl).origin;
  const wsOrigin = devOrigin.replace(/^http/, "ws");
  const devCsp =
    `default-src 'self' ${devOrigin} ${wsOrigin}; ` +
    `script-src 'self' 'unsafe-inline' blob: ${devOrigin}; ` +
    `worker-src 'self' blob: ${devOrigin}; ` +
    `style-src 'self' 'unsafe-inline' ${devOrigin}; ` +
    "img-src 'self' data: blob:; " +
    "media-src 'self' blob: data:; " +
    "font-src 'self' data:; " +
    `connect-src 'self' ${devOrigin} ${wsOrigin} blob: data:;`;

  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [`${devOrigin}/*`] },
    (details, callback) => {
      if (details.resourceType !== "mainFrame" && details.resourceType !== "subFrame") {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [devCsp],
        },
      });
    }
  );
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

  const bootStartMs = Date.now();
  let bootReady = false;
  let readyMs = null;
  let devNetworkRetries = 0;
  let retryTimer = null;
  let smokeTimer = null;
  let watchdogTimer = null;
  let smokeBusy = false;

  const rendererErrors = [];
  const rendererWarnings = [];
  const networkErrors = [];

  win.once("ready-to-show", () => {
    if (!isSmokeTest) {
      win.show();
    }
  });

  win.webContents.on("console-message", (event) => {
    const level = event && event.level;
    const message = event && event.message;
    const line = event && event.lineNumber;
    const sourceId = event && event.sourceId;
    if (level === "error" || level === 3) {
      const entry = `console.error (${sourceId}:${line}): ${message}`;
      rendererErrors.push(entry);
      if (!isSmokeTest && !isProfile) {
        console.error(`[Renderer] ${entry}`);
      }
    } else if (level === "warning" || level === 2) {
      rendererWarnings.push(`console.warn (${sourceId}:${line}): ${message}`);
    }
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) {
      return;
    }
    const entry = `did-fail-load (${errorCode}) ${validatedURL}: ${errorDescription}`;
    rendererErrors.push(entry);
    if (!isSmokeTest && !isProfile) {
      console.error(`[Load] ${entry}`);
    }
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    const entry = `render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`;
    rendererErrors.push(entry);
    if (!isSmokeTest && !isProfile) {
      console.error(`[Renderer] ${entry}`);
    }
  });

  const devOrigin = devServerUrl ? new URL(devServerUrl).origin : null;
  const errorFilter = devOrigin ? { urls: [`${devOrigin}/*`] } : { urls: ["file://*/*"] };
  const transientDevErrors = new Set([
    "net::ERR_NETWORK_CHANGED",
    "net::ERR_CONNECTION_RESET",
    "net::ERR_EMPTY_RESPONSE",
  ]);

  session.defaultSession.webRequest.onErrorOccurred(errorFilter, (details) => {
    if (details.error === "net::ERR_ABORTED") {
      return;
    }
    const entry = `${details.error} (${details.resourceType}) ${details.url}`;
    networkErrors.push(entry);
    if (!isSmokeTest && !isProfile) {
      console.error(`[Network] ${entry}`);
    }
    if (
      devServerUrl &&
      !bootReady &&
      transientDevErrors.has(details.error) &&
      devNetworkRetries < 2 &&
      !retryTimer &&
      !win.isDestroyed()
    ) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (win.isDestroyed() || bootReady) {
          return;
        }
        devNetworkRetries += 1;
        networkErrors.length = 0;
        rendererErrors.length = 0;
        if (!isSmokeTest && !isProfile) {
          console.warn(`[Dev Recovery] Transient ${details.error}; reloading (${devNetworkRetries}/2)...`);
        }
        win.webContents.reloadIgnoringCache();
      }, 350);
    }
  });

  win.on("closed", () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (smokeTimer) {
      clearInterval(smokeTimer);
      smokeTimer = null;
    }
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    session.defaultSession.webRequest.onErrorOccurred(null);
  });

  if (isSmokeTest) {
    const SMOKE_TIMEOUT_MS = 25000;
    let firstReadyAtMs = null;

    const finalizeSmoke = (diagnostics, ok) => {
      if (smokeTimer) {
        clearInterval(smokeTimer);
        smokeTimer = null;
      }
      const allErrors = [...mainErrors, ...rendererErrors, ...networkErrors];
      const finalOk = Boolean(ok && allErrors.length === 0);
      console.log(
        JSON.stringify(
          {
            smokeStatus: finalOk ? "SMOKE_OK" : "SMOKE_FAIL",
            mode: devServerUrl ? "dev" : "prod",
            bootMs: readyMs ?? Date.now() - bootStartMs,
            devNetworkRetries,
            diagnostics,
            warnings: rendererWarnings,
            errors: allErrors,
          },
          null,
          2
        )
      );
      app.exit(finalOk ? 0 : 1);
    };

    smokeTimer = setInterval(async () => {
      if (smokeBusy || win.isDestroyed()) {
        return;
      }
      smokeBusy = true;
      try {
        const elapsedMs = Date.now() - bootStartMs;
        const diagnostics = await win.webContents.executeJavaScript(`
          (() => {
            const canvas = document.getElementById('sim-canvas');
            const hud = document.getElementById('hud-root');
            const banner = document.getElementById('aether-fatal-banner');
            const rect = canvas ? canvas.getBoundingClientRect() : null;
            return {
              title: document.title,
              readyState: document.readyState,
              hasDesktopBridge: Boolean(window.desktopApp && window.desktopApp.isElectron),
              hudChildren: hud ? hud.children.length : 0,
              fatalBanner: banner ? banner.textContent : null,
              canvasWidth: rect ? Math.round(rect.width) : 0,
              canvasHeight: rect ? Math.round(rect.height) : 0,
              sim: window.__STARSHIP_SIM__ || null,
            };
          })()
        `);

        const simReady = Boolean(diagnostics && diagnostics.sim && diagnostics.sim.ready === true);
        if (simReady && diagnostics.hudChildren > 0 && readyMs === null) {
          bootReady = true;
          readyMs = elapsedMs;
          firstReadyAtMs = Date.now();
        }

        const metricsReady = Boolean(
          simReady &&
            diagnostics.hasDesktopBridge &&
            diagnostics.hudChildren > 0 &&
            diagnostics.canvasWidth >= 800 &&
            diagnostics.canvasHeight >= 500 &&
            diagnostics.sim.drawCalls > 0 &&
            diagnostics.sim.triangles > 0 &&
            diagnostics.sim.fps > 0 &&
            typeof diagnostics.sim.canvasNonBlackPct === "number" &&
            diagnostics.sim.canvasNonBlackPct > 20
        );

        const settleTimedOut = firstReadyAtMs !== null && Date.now() - firstReadyAtMs > 2000;
        if (diagnostics.fatalBanner) {
          finalizeSmoke(diagnostics, false);
        } else if (metricsReady) {
          finalizeSmoke(diagnostics, true);
        } else if (elapsedMs >= SMOKE_TIMEOUT_MS || settleTimedOut) {
          finalizeSmoke(diagnostics, false);
        }
      } catch (err) {
        if (Date.now() - bootStartMs >= SMOKE_TIMEOUT_MS) {
          mainErrors.push(`smoke executeJavaScript failed: ${String(err)}`);
          finalizeSmoke(null, false);
        }
      } finally {
        smokeBusy = false;
      }
    }, 250);
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
  } else {
    const WATCHDOG_TIMEOUT_MS = 15000;
    let watchdogBusy = false;
    watchdogTimer = setInterval(async () => {
      if (watchdogBusy || win.isDestroyed()) {
        return;
      }
      watchdogBusy = true;
      try {
        const isReady = await win.webContents.executeJavaScript(
          "Boolean(window.__STARSHIP_SIM__ && window.__STARSHIP_SIM__.ready)"
        );
        if (isReady) {
          bootReady = true;
          clearInterval(watchdogTimer);
          watchdogTimer = null;
          return;
        }
        if (Date.now() - bootStartMs >= WATCHDOG_TIMEOUT_MS) {
          clearInterval(watchdogTimer);
          watchdogTimer = null;
          const allErrors = [...mainErrors, ...rendererErrors, ...networkErrors];
          const detailText =
            allErrors.length > 0
              ? allErrors.join("\n")
              : `Timed out after ${WATCHDOG_TIMEOUT_MS} ms waiting for AetherSim renderer bootstrap (${devServerUrl || "dist/index.html"}).`;
          const payload = JSON.stringify({
            title: "AetherSim Startup Watchdog — Renderer Not Ready",
            detail: detailText,
          });
          await win.webContents.executeJavaScript(`
            (() => {
              if (document.getElementById('aether-fatal-banner')) return;
              const data = ${payload};
              const box = document.createElement('div');
              box.id = 'aether-fatal-banner';
              box.style.cssText = 'position:fixed;inset:24px;z-index:99999;display:flex;flex-direction:column;gap:12px;padding:20px 24px;border-radius:12px;border:1px solid #f87171;background:rgba(10,14,24,0.96);color:#f8fafc;font-family:Segoe UI,system-ui,sans-serif;box-shadow:0 20px 50px rgba(0,0,0,0.7);overflow:auto;';
              const h = document.createElement('h2');
              h.textContent = data.title;
              h.style.cssText = 'margin:0;color:#fca5a5;font-size:18px;font-weight:700;';
              const pre = document.createElement('pre');
              pre.textContent = data.detail;
              pre.style.cssText = 'margin:0;padding:12px;border-radius:8px;background:#05070d;border:1px solid rgba(248,113,113,0.3);color:#e2e8f0;font-family:Cascadia Mono,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;overflow:auto;flex:1;';
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.textContent = 'Reload Simulator';
              btn.style.cssText = 'align-self:flex-start;padding:8px 16px;border-radius:8px;border:1px solid #38bdf8;background:rgba(56,189,248,0.2);color:#eef4fb;font-weight:600;cursor:pointer;';
              btn.addEventListener('click', () => window.location.reload());
              box.append(h, pre, btn);
              (document.body || document.documentElement).append(box);
            })()
          `);
        }
      } catch {
        // Window may have navigated or closed during check
      } finally {
        watchdogBusy = false;
      }
    }, 1000);
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
