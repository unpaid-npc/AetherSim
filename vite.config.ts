import { defineConfig, type Plugin } from "vite";

function cspMetaPlugin(): Plugin {
  let isServe = false;
  return {
    name: "starship-csp-meta",
    configResolved(resolved) {
      isServe = resolved.command === "serve";
    },
    transformIndexHtml(html) {
      const policy = isServe
        ? "default-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173; script-src 'self' 'unsafe-inline' blob: http://127.0.0.1:5173; worker-src 'self' blob: http://127.0.0.1:5173; style-src 'self' 'unsafe-inline' http://127.0.0.1:5173; img-src 'self' data: blob: https://tiles.maps.eox.at https://gibs.earthdata.nasa.gov; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173 blob: data: https://tiles.maps.eox.at https://gibs.earthdata.nasa.gov https://celestrak.org;"
        : "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tiles.maps.eox.at https://gibs.earthdata.nasa.gov; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' https://tiles.maps.eox.at https://gibs.earthdata.nasa.gov https://celestrak.org;";

      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`
      );
    },
  };
}

/**
 * satellite.js v7.x re-exports an optional Emscripten pthreads WASM bulk propagator
 * that references node:worker_threads via top-level await. AetherSim uses the pure-JS
 * SGP4 API (`json2satrec`, `propagate`, `gstime`, `eciToGeodetic`), so stubbing the
 * unused `./wasm/index.js` export keeps the production bundle clean and fast.
 */
function skipUnusedSatelliteWasmPlugin(): Plugin {
  const virtualId = "\0satellite-wasm-stub";
  return {
    name: "skip-unused-satellite-wasm",
    enforce: "pre",
    resolveId(source, importer) {
      const normImporter = importer ? importer.replace(/\\/g, "/") : "";
      if (
        normImporter.includes("/satellite.js/") &&
        (source === "./wasm/index.js" ||
          source.endsWith("/wasm/index.js") ||
          source.startsWith("#wasm-"))
      ) {
        return virtualId;
      }
      return null;
    },
    load(id) {
      if (id === virtualId) {
        return "export default function () { return Promise.resolve({}); }";
      }
      return null;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [cspMetaPlugin(), skipUnusedSatelliteWasmPlugin()],
  css: {
    postcss: {
      plugins: [],
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        "**/venv/**",
        "**/release/**",
        "**/dist/**",
        "**/archive/**",
        "**/results/**",
        "**/docs/**",
        "**/videos/**",
        "**/models/**",
        "**/logs/**",
        "**/__pycache__/**",
        "**/.pytest_cache/**",
      ],
    },
    warmup: {
      clientFiles: [
        "./index.html",
        "./src/main.ts",
        "./src/style.css",
        "./src/scene/SceneManager.ts",
      ],
    },
  },
  optimizeDeps: {
    entries: ["index.html"],
    include: [
      "three",
      "gsap",
      "three/addons/controls/OrbitControls.js",
      "three/addons/postprocessing/EffectComposer.js",
      "three/addons/postprocessing/RenderPass.js",
      "three/addons/postprocessing/UnrealBloomPass.js",
      "three/addons/postprocessing/ShaderPass.js",
      "three/addons/postprocessing/OutputPass.js",
    ],
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
