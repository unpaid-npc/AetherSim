const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, Menu, ipcMain, session } = require("electron");

const isSmokeTest = process.env.ELECTRON_SMOKE_TEST === "1";
const isProfile = process.env.ELECTRON_PROFILE === "1";
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

app.commandLine.appendSwitch("enable-webgl");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("force_high_performance_gpu");
if (devServerUrl) {
  app.commandLine.appendSwitch("proxy-bypass-list", "127.0.0.1;localhost");
}
if (isProfile) {
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}

const PCI_VENDORS = {
  0x10de: "NVIDIA",
  0x1002: "AMD",
  0x8086: "Intel",
  0x1414: "Microsoft",
};

function classifyPciGpuTier(vendorId, deviceString) {
  const s = String(deviceString || "").trim();
  if (/swiftshader|llvmpipe|softpipe|basic render|warp/i.test(s) || vendorId === 0x1414) {
    return "software";
  }
  if (vendorId === 0x10de || /\bnvidia|geforce|quadro|rtx|gtx\b/i.test(s)) {
    return "dgpu";
  }
  if (vendorId === 0x1002 || /\bamd|radeon\b/i.test(s)) {
    return /\b(RX\s*\d|R9\b|R7\b|Pro\s*W|FirePro|Vega\s*(56|64|Frontier)|Fury|Instinct|XT\b|XTX\b)\b/i.test(s)
      ? "dgpu"
      : "igpu";
  }
  if (vendorId === 0x8086 || /\bintel\b/i.test(s)) {
    return /\bArc\s*[AB]\d{3}/i.test(s) ? "dgpu" : "igpu";
  }
  return "unknown";
}

async function collectSystemHardwareInfo() {
  const cpus = os.cpus() || [];
  const cpuModel = cpus.length > 0 ? String(cpus[0].model || "").trim() : "Unknown CPU";
  const cpuCores = cpus.length;
  const totalRamGb = Number((os.totalmem() / (1024 * 1024 * 1024)).toFixed(1));
  let gpuDevices = [];
  try {
    const gpuInfo = await app.getGPUInfo("basic");
    const rawDevices = Array.isArray(gpuInfo && gpuInfo.gpuDevice) ? gpuInfo.gpuDevice : [];
    gpuDevices = rawDevices.map((d) => {
      const vendorId = Number(d && d.vendorId) || 0;
      const deviceId = Number(d && d.deviceId) || 0;
      const deviceString = String((d && (d.deviceString || d.description)) || "").trim();
      return {
        vendorId,
        deviceId,
        vendorName: PCI_VENDORS[vendorId] || "Unknown",
        deviceString,
        active: Boolean(d && d.active),
        tier: classifyPciGpuTier(vendorId, deviceString),
      };
    });
  } catch {
    gpuDevices = [];
  }
  return { cpuModel, cpuCores, totalRamGb, gpuDevices };
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
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: ${devOrigin}; ` +
    `worker-src 'self' blob: ${devOrigin}; ` +
    `style-src 'self' 'unsafe-inline' ${devOrigin}; ` +
    "img-src 'self' data: blob: https://tiles.maps.eox.at https://gibs.earthdata.nasa.gov; " +
    "media-src 'self' blob: data:; " +
    "font-src 'self' data:; " +
    `connect-src 'self' ${devOrigin} ${wsOrigin} blob: data: https://tiles.maps.eox.at https://gibs.earthdata.nasa.gov https://celestrak.org;`;

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
          if (smokeTimer) {
            clearInterval(smokeTimer);
            smokeTimer = null;
          }

          // Automated live camera sweep: test physical F1-F8 + Ship/Booster + Re-lock
          win.webContents.focus();
          const initialBootId = await win.webContents.executeJavaScript("window.__AETHERSIM_BOOT_ID__ || null");
          const sweepSteps = [];

          const verifyCam = async (label, expected) => {
            await new Promise((r) => setTimeout(r, 85));
            const probeState = await win.webContents.executeJavaScript(`
              (() => {
                const probe = window.__AETHERSIM_PROFILER__ ? window.__AETHERSIM_PROFILER__.probeCanvas() : { pct: 0, meanRgb: [0,0,0] };
                const activeModeBtns = Array.from(document.querySelectorAll('[data-cam-mode].active')).map((b) => b.dataset.camMode);
                const activeTrackBtns = Array.from(document.querySelectorAll('[data-track-target].active')).map((b) => b.dataset.trackTarget);
                const autoBtn = document.querySelector('[data-cam-action="auto"]');
                const autoActive = Boolean(autoBtn && autoBtn.classList.contains('active'));
                return {
                  bootId: window.__AETHERSIM_BOOT_ID__ || null,
                  cameraPreset: window.__STARSHIP_SIM__ ? window.__STARSHIP_SIM__.cameraPreset : null,
                  trackTarget: window.__STARSHIP_SIM__ ? window.__STARSHIP_SIM__.trackTarget : null,
                  activeModeBtns,
                  activeTrackBtns,
                  autoActive,
                  nonBlackPct: probe.pct,
                  meanRgb: probe.meanRgb,
                };
              })()
            `);
            const modeOk = !expected.mode || (probeState.cameraPreset === expected.mode && probeState.activeModeBtns.length === 1 && probeState.activeModeBtns[0] === expected.mode);
            const targetOk = !expected.target || (probeState.trackTarget === expected.target && probeState.activeTrackBtns.length === 1 && probeState.activeTrackBtns[0] === expected.target);
            const autoOk = typeof expected.auto !== "boolean" || probeState.autoActive === expected.auto;
            const noReload = Boolean(initialBootId && probeState.bootId === initialBootId);
            const nonBlack = probeState.nonBlackPct > 0;
            const passed = modeOk && targetOk && autoOk && noReload && nonBlack;
            sweepSteps.push({
              label,
              passed,
              mode: probeState.cameraPreset,
              trackTarget: probeState.trackTarget,
              autoActive: probeState.autoActive,
              nonBlackPct: probeState.nonBlackPct,
            });
            if (!passed) {
              mainErrors.push(
                `cameraSweep '${label}' failed: got=${JSON.stringify(probeState)} expected=${JSON.stringify(expected)}`
              );
            }
          };

          const keySweep = [
            { keyCode: "F1", label: "Key F1 (Pad)", expected: { mode: "pad", auto: false } },
            { keyCode: "F2", label: "Key F2 (Chase)", expected: { mode: "chase", auto: false } },
            { keyCode: "F3", label: "Key F3 (Engine)", expected: { mode: "engine", auto: false } },
            { keyCode: "F4", label: "Key F4 (Station)", expected: { mode: "station", auto: false } },
            { keyCode: "F5", label: "Key F5 (Free)", expected: { mode: "free", auto: false } },
            { keyCode: "F6", label: "Key F6 (Map)", expected: { mode: "map", auto: false } },
            { keyCode: "F7", label: "Key F7 (Booster)", expected: { mode: "booster", target: "booster", auto: false } },
            { keyCode: "F8", label: "Key F8 On (Auto -> Pad)", expected: { mode: "pad", target: "booster", auto: true } },
            { keyCode: "F8", label: "Key F8 Off", expected: { mode: "pad", target: "booster", auto: false } },
            { keyCode: "F7", label: "Key F7 Re-enter Booster", expected: { mode: "booster", target: "booster", auto: false } },
          ];
          for (const item of keySweep) {
            win.webContents.sendInputEvent({ type: "keyDown", keyCode: item.keyCode });
            win.webContents.sendInputEvent({ type: "keyUp", keyCode: item.keyCode });
            await verifyCam(item.label, item.expected);
          }

          await win.webContents.executeJavaScript("document.querySelector('[data-track-target=\"ship\"]')?.click()");
          await verifyCam("Track Ship from F7 -> Chase", { mode: "chase", target: "ship", auto: false });

          await win.webContents.executeJavaScript("document.querySelector('[data-track-target=\"booster\"]')?.click()");
          await verifyCam("Track Booster in Chase", { mode: "chase", target: "booster", auto: false });

          await win.webContents.executeJavaScript("document.querySelector('[data-cam-mode=\"engine\"]')?.click()");
          await verifyCam("F3 Engine on Booster", { mode: "engine", target: "booster", auto: false });

          await win.webContents.executeJavaScript("document.querySelector('[data-cam-action=\"relock\"]')?.click()");
          await verifyCam("Re-lock on Booster", { mode: "engine", target: "booster", auto: false });

          // Return to default startup camera cleanly
          await win.webContents.executeJavaScript("document.querySelector('[data-track-target=\"ship\"]')?.click(); document.querySelector('[data-cam-mode=\"free\"]')?.click()");
          await verifyCam("Return Free on Ship", { mode: "free", target: "ship", auto: false });

          const postDiag = await win.webContents.executeJavaScript(`
            (() => {
              const canvas = document.getElementById('sim-canvas');
              const rect = canvas ? canvas.getBoundingClientRect() : null;
              return {
                title: document.title,
                readyState: document.readyState,
                hasDesktopBridge: Boolean(window.desktopApp && window.desktopApp.isElectron),
                hudChildren: document.getElementById('hud-root')?.children.length || 0,
                fatalBanner: document.getElementById('aether-fatal-banner')?.textContent || null,
                canvasWidth: rect ? Math.round(rect.width) : 0,
                canvasHeight: rect ? Math.round(rect.height) : 0,
                sim: window.__STARSHIP_SIM__ || null,
                cameraSweepPassed: true,
                cameraSweep: ${JSON.stringify(sweepSteps)},
              };
            })()
          `);
          postDiag.cameraSweep = sweepSteps;
          postDiag.cameraSweepPassed = sweepSteps.every((s) => s.passed);
          finalizeSmoke(postDiag, postDiag.cameraSweepPassed);
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
          const systemHardware = await collectSystemHardwareInfo();
          const allErrors = [...mainErrors, ...rendererErrors];
          const ok = allErrors.length === 0 && Array.isArray(results) && results.length === 9;
          console.log("PROFILE_JSON_START");
          console.log(
            JSON.stringify(
              {
                profileStatus: ok ? "PROFILE_OK" : "PROFILE_FAIL",
                systemHardware,
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

function installApplicationMenu() {
  const template = [
    {
      label: "AetherSim",
      submenu: [
        { role: "reload", accelerator: "CmdOrCtrl+R" },
        { role: "forceReload", accelerator: "CmdOrCtrl+Shift+R" },
        {
          label: "Toggle Developer Tools",
          accelerator: process.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: (_item, focusedWindow) => {
            if (focusedWindow) {
              focusedWindow.webContents.toggleDevTools();
            }
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  ipcMain.handle("system:get-hardware-info", async () => collectSystemHardwareInfo());
  installApplicationMenu();
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
