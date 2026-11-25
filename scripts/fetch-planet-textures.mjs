#!/usr/bin/env node
/**
 * Fetches verified NASA-derived Solar System Scope (CC-BY 4.0) 8K planetary maps
 * from Wikimedia Commons (with NASA SVS / Three.js fallbacks), validates content
 * headers, and downsamples via Pillow Lanczos to crisp 4096x2048 progressive JPEGs
 * (< 3 MB each) in public/textures/planets/.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "public", "textures", "planets");
const PYTHON_BIN = path.join(ROOT, "venv", "Scripts", "python.exe");
const USER_AGENT = "AetherSim/1.1 (https://github.com/unpaid-npc/AetherSim)";

const TEXTURES = [
  {
    filename: "earth_day_4k.jpg",
    title: "Earth Blue Marble Day Map",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/0/04/Solarsystemscope_texture_8k_earth_daymap.jpg",
      "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_atmos_2048.jpg",
    ],
    sourceCredits: "NASA Visible Earth / Solar System Scope 8K Earth Daymap (CC-BY 4.0)",
  },
  {
    filename: "earth_clouds_4k.jpg",
    title: "Earth Global Cloud Map",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/7/7a/Solarsystemscope_texture_8k_earth_clouds.jpg",
      "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_clouds_1024.png",
    ],
    sourceCredits: "NASA Visible Earth / Solar System Scope 8K Earth Clouds (CC-BY 4.0)",
  },
  {
    filename: "earth_night_4k.jpg",
    title: "Earth Night City Lights Map",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/b/b3/Solarsystemscope_texture_8k_earth_nightmap.jpg",
      "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_lights_2048.png",
    ],
    sourceCredits: "NASA Earth Observatory / Solar System Scope 8K Earth Nightmap (CC-BY 4.0)",
  },
  {
    filename: "earth_specular_4k.jpg",
    title: "Earth Ocean Specular Mask",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/d/d8/Solarsystemscope_texture_8k_earth_specular_map.tif",
      "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_specular_2048.jpg",
    ],
    sourceCredits: "NASA / Solar System Scope 8K Earth Specular Map (CC-BY 4.0)",
  },
  {
    filename: "mars_4k.jpg",
    title: "Mars MOLA/Viking Global Color Map",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/7/70/Solarsystemscope_texture_8k_mars.jpg",
    ],
    sourceCredits: "NASA Viking & MOLA / Solar System Scope 8K Mars Map (CC-BY 4.0)",
  },
  {
    filename: "moon_4k.jpg",
    title: "Moon LROC WAC Global Color Map",
    urls: [
      "https://upload.wikimedia.org/wikipedia/commons/d/d1/Solarsystemscope_texture_8k_moon.jpg",
      "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_4k.tif",
    ],
    sourceCredits: "NASA LROC / Solar System Scope 8K Moon Map (CC-BY 4.0)",
  },
];

async function downloadToFile(url, destPath) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "image/*,*/*;q=0.8",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
    throw new Error(`Rejected HTML response (${contentType}) from ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 32_768) {
    throw new Error(`Suspiciously small payload (${buf.length} B) from ${url}`);
  }
  fs.writeFileSync(destPath, buf);
  return { bytes: buf.length, contentType };
}

function downscaleWithPillow(rawPath, outPath) {
  const pyExe = fs.existsSync(PYTHON_BIN) ? PYTHON_BIN : "python";
  const script = `
import os, sys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
raw_path, out_path = sys.argv[1], sys.argv[2]
with Image.open(raw_path) as img:
    rgb = img.convert("RGB")
    resized = rgb.resize((4096, 2048), Image.Resampling.LANCZOS)
    for q in (88, 84, 78, 72):
        resized.save(out_path, format="JPEG", quality=q, optimize=True, progressive=True)
        if os.path.getsize(out_path) <= 2_950_000:
            break
    with Image.open(out_path) as check:
        print(f"{check.size[0]}x{check.size[1]}|{os.path.getsize(out_path)}")
`;
  const proc = spawnSync(pyExe, ["-c", script, rawPath, outPath], {
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    throw new Error(`Pillow resize failed: ${proc.stderr || proc.stdout}`);
  }
  const out = proc.stdout.trim();
  const [dims, sizeStr] = out.split("|");
  return { dims, bytes: Number(sizeStr) };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aethersim-tex-"));

  try {
    const manifestRows = [];
    for (const item of TEXTURES) {
      const outPath = path.join(OUT_DIR, item.filename);
      const rawPath = path.join(tmpDir, `${item.filename}.raw`);

      let downloaded = null;
      let usedUrl = "";
      let lastErr = null;
      for (const url of item.urls) {
        try {
          console.log(`[fetch] Downloading ${item.filename} from ${url} ...`);
          downloaded = await downloadToFile(url, rawPath);
          usedUrl = url;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`[warn] ${item.filename} failed on ${url}: ${err.message}`);
        }
      }
      if (!downloaded) {
        throw new Error(`All sources failed for ${item.filename}: ${lastErr?.message}`);
      }

      const { dims, bytes } = downscaleWithPillow(rawPath, outPath);
      if (dims !== "4096x2048") {
        throw new Error(`Unexpected output dimensions ${dims} for ${item.filename}`);
      }
      if (bytes >= 3 * 1024 * 1024) {
        throw new Error(`Output ${item.filename} (${bytes} B) exceeds 3 MB limit`);
      }

      const mb = (bytes / (1024 * 1024)).toFixed(2);
      console.log(`[ok] ${item.filename} -> ${dims}, ${bytes.toLocaleString()} bytes (${mb} MB)`);
      manifestRows.push({
        ...item,
        usedUrl,
        dims,
        bytes,
      });
    }

    const attributionMd = `# Planetary Satellite Texture Attribution

All 4K (\`4096x2048\`) equirectangular planetary textures in this directory are derived from NASA public-domain imagery and redistributed via Solar System Scope under **Creative Commons Attribution 4.0 International (CC-BY 4.0)**.

| File | Description | Resolution | Size | Primary Source |
| :--- | :--- | :---: | :---: | :--- |
${manifestRows
  .map(
    (r) =>
      `| \`${r.filename}\` | ${r.sourceCredits} | ${r.dims} | ${(r.bytes / (1024 * 1024)).toFixed(2)} MB | ${r.usedUrl} |`
  )
  .join("\n")}

- NASA imagery datasets: Visible Earth Blue Marble / Black Marble, Mars Viking & MOLA, Lunar Reconnaissance Orbiter Camera (LROC WAC).
- Solar System Scope texture derivations: https://www.solarsystemscope.com/textures/ (CC-BY 4.0).
`;
    fs.writeFileSync(path.join(OUT_DIR, "ATTRIBUTION.md"), attributionMd, "utf8");
    console.log(`[done] Wrote ATTRIBUTION.md and all ${manifestRows.length} 4K textures.`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
