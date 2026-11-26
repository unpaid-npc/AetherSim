import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "public", "textures", "pbr");
const tmpDir = path.join(rootDir, "public", "textures", "pbr", "_tmp");
const venvPython = path.join(rootDir, "venv", "Scripts", "python.exe");

const USER_AGENT = "AetherSim/2.0 (https://github.com/unpaid-npc/AetherSim)";
const MAX_BYTES = 2_500_000;

const TARGET_SLOTS = [
  {
    prefix: "asphalt",
    label: "Asphalt Highway Surface",
    preferred: ["asphalt_02", "asphalt_01", "asphalt_04", "asphalt_track"],
    keywords: ["asphalt"],
  },
  {
    prefix: "concrete",
    label: "Launchpad Reinforced Concrete",
    preferred: ["concrete_floor_02", "concrete_layers_02", "concrete_floor_worn_001", "weathered_concrete", "concrete_pavers"],
    keywords: ["concrete"],
  },
  {
    prefix: "sand",
    label: "Gulf Coastal Beach Sand",
    preferred: ["coast_sand_01", "coast_sand_02", "sand_01", "sandy_gravel_02"],
    keywords: ["sand"],
  },
  {
    prefix: "soil",
    label: "Coastal Scrub & Grass Soil",
    preferred: ["coast_sand_rocks_02", "aerial_grass_rock", "forrest_ground_01", "brown_mud_leaves_01", "rocky_terrain_02"],
    keywords: ["ground", "grass", "soil", "mud"],
  },
  {
    prefix: "metal_wall",
    label: "Industrial Corrugated Steel Cladding",
    preferred: ["corrugated_iron_02", "corrugated_iron_03", "corrugated_iron", "metal_plate", "rusty_metal_02"],
    keywords: ["corrugated", "metal"],
  },
];

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.json();
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

function findMapEntry(filesData, candidateKeys) {
  for (const key of candidateKeys) {
    const mapObj = filesData[key];
    if (!mapObj || !mapObj["4k"]) continue;
    const node = mapObj["4k"];
    if (node.jpg && node.jpg.url) {
      return { mapKey: key, ext: "jpg", url: node.jpg.url };
    }
    if (node.png && node.png.url) {
      return { mapKey: key, ext: "png", url: node.png.url };
    }
  }
  return null;
}

function normalizeTo4kJpeg(srcPath, destPath) {
  const pyCode = `
import os, sys
from PIL import Image
src, dst, max_bytes = sys.argv[1], sys.argv[2], int(sys.argv[3])
Image.MAX_IMAGE_PIXELS = None
im = Image.open(src).convert("RGB")
if im.size != (4096, 4096):
    im = im.resize((4096, 4096), Image.Resampling.LANCZOS)
for q in (84, 76, 68, 60, 52, 44):
    im.save(dst, "JPEG", quality=q, optimize=True, progressive=True, subsampling=2)
    if os.path.getsize(dst) <= max_bytes:
        break
sz = os.path.getsize(dst)
print(f"{im.size[0]}x{im.size[1]}:{sz}")
`;
  const pyBin = fs.existsSync(venvPython) ? venvPython : "python";
  const res = spawnSync(pyBin, ["-c", pyCode, srcPath, destPath, String(MAX_BYTES)], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`Pillow conversion failed for ${srcPath}: ${res.stderr || res.stdout}`);
  }
  const [dims, bytesStr] = (res.stdout || "").trim().split(":");
  return { dims, bytes: Number(bytesStr || fs.statSync(destPath).size) };
}

async function pickWorkingAsset(slot, allAssets) {
  const keys = Object.keys(allAssets);
  const candidates = [];
  for (const p of slot.preferred) {
    if (allAssets[p]) candidates.push(p);
  }
  for (const id of keys) {
    if (candidates.includes(id)) continue;
    const meta = allAssets[id];
    const hay = `${id} ${meta.name || ""} ${(meta.categories || []).join(" ")} ${(meta.tags || []).join(" ")}`.toLowerCase();
    if (slot.keywords.some((kw) => hay.includes(kw))) {
      candidates.push(id);
    }
  }

  for (const id of candidates) {
    const filesData = await fetchJson(`https://api.polyhaven.com/files/${id}`);
    const diff = findMapEntry(filesData, ["Diffuse", "col", "Albedo", "BaseColor"]);
    const nor = findMapEntry(filesData, ["nor_gl", "Normal", "nor_dx"]);
    const rough = findMapEntry(filesData, ["Rough", "rough_ao"]);
    if (diff && nor && rough) {
      return { id, name: allAssets[id]?.name || id, diff, nor, rough };
    }
  }
  throw new Error(`No suitable 4K PBR asset found for slot ${slot.prefix}`);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log("[PBR Fetch] Querying Poly Haven texture catalog...");
  const allAssets = await fetchJson("https://api.polyhaven.com/assets?t=textures");
  const attributionLines = [
    "# Poly Haven 4K PBR Texture Attribution (CC0 1.0 Public Domain)",
    "",
    "All PBR textures in this directory are genuine photoscanned assets downloaded from [Poly Haven](https://polyhaven.com/textures) under the **CC0 1.0 Universal Public Domain** license.",
    "",
    "| Surface | Poly Haven Asset ID | Map | Filename | Resolution | Size |",
    "| :--- | :--- | :--- | :--- | :--- | :--- |",
  ];

  const summary = [];

  for (const slot of TARGET_SLOTS) {
    const chosen = await pickWorkingAsset(slot, allAssets);
    console.log(`[PBR Fetch] ${slot.prefix} -> ${chosen.id} (${chosen.name})`);

    const maps = [
      { suffix: "diff", label: chosen.diff.mapKey, info: chosen.diff },
      { suffix: "nor", label: chosen.nor.mapKey, info: chosen.nor },
      { suffix: "rough", label: chosen.rough.mapKey, info: chosen.rough },
    ];

    for (const m of maps) {
      const destName = `${slot.prefix}_${m.suffix}_4k.jpg`;
      const destPath = path.join(outDir, destName);
      const rawPath = path.join(tmpDir, `${destName}.${m.info.ext}`);

      console.log(`  Downloading ${m.info.url} ...`);
      await downloadFile(m.info.url, rawPath);
      const stats = normalizeTo4kJpeg(rawPath, destPath);
      console.log(`  Saved ${destName} (${stats.dims}, ${(stats.bytes / 1024).toFixed(1)} KB)`);

      summary.push({
        slot: slot.prefix,
        assetId: chosen.id,
        file: destName,
        dims: stats.dims,
        bytes: stats.bytes,
      });

      attributionLines.push(
        `| ${slot.label} | [\`${chosen.id}\`](https://polyhaven.com/a/${chosen.id}) | ${m.label} | \`${destName}\` | ${stats.dims} | ${(stats.bytes / 1024).toFixed(1)} KB |`
      );
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(outDir, "ATTRIBUTION.md"), `${attributionLines.join("\n")}\n`, "utf8");
  console.log("[PBR Fetch] Complete! Wrote public/textures/pbr/ATTRIBUTION.md");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("[PBR Fetch Error]", err);
  process.exit(1);
});
