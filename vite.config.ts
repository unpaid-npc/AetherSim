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
        ? "default-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173; script-src 'self' 'unsafe-inline' http://127.0.0.1:5173; worker-src 'self' blob: http://127.0.0.1:5173; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173;"
        : "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';";

      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`
      );
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [cspMetaPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
