import type { ActivationSnapshot } from "../ai/NeuralNetwork";

const INPUT_LABELS = [
  "x",
  "Alt",
  "z",
  "vx",
  "vy",
  "vz",
  "Pitch",
  "Roll",
  "Yaw",
  "ωx",
  "ωy",
  "ωz",
  "Fuel",
  "g",
];

const OUTPUT_LABELS = ["THR", "PITCH", "YAW"];

function activationColor(val: number): string {
  const c = Math.max(-1, Math.min(1, val));
  if (c >= 0) {
    const r = Math.round(35 + c * 215);
    const g = Math.round(130 + c * 85);
    const b = Math.round(200 - c * 110);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const t = -c;
  const r = Math.round(30 - t * 18);
  const g = Math.round(80 + t * 50);
  const b = Math.round(160 + t * 85);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * High-DPI HTML5 canvas live Actor-Critic neural network activation visualizer (14 -> 64 -> 64 -> 3).
 */
export class NeuralNetVisualizer {
  public readonly canvas = document.createElement("canvas");

  constructor() {
    this.canvas.className = "nn-visualizer-canvas";
  }

  render(snapshot: ActivationSnapshot | null): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 330;
    const h = this.canvas.clientHeight || 310;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "rgba(6, 10, 18, 0.94)";
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "600 10px 'Cascadia Mono', Consolas, monospace";
    ctx.fillText("ACTOR MLP  14 → 64(tanh) → 64(tanh) → 3", 8, 14);

    if (!snapshot) {
      ctx.fillStyle = "#64748b";
      ctx.fillText("Switch Pilot to AI NEURAL or Watch AI Learn", 24, h * 0.5);
      ctx.restore();
      return;
    }

    const colX = [56, w * 0.39, w * 0.65, w - 68];
    const topY = 28;
    const botY = h - 22;

    // Sample 16 representative neurons from each 64-wide hidden layer for clear graph lines
    const h1Count = 16;
    const h2Count = 16;
    const h1Vals = new Float32Array(h1Count);
    const h2Vals = new Float32Array(h2Count);
    for (let i = 0; i < 16; i++) {
      let s1 = 0;
      let s2 = 0;
      for (let k = 0; k < 4; k++) {
        s1 += snapshot.actorHidden1[i * 4 + k] ?? 0;
        s2 += snapshot.actorHidden2[i * 4 + k] ?? 0;
      }
      h1Vals[i] = s1 * 0.25;
      h2Vals[i] = s2 * 0.25;
    }

    const yFor = (idx: number, count: number) =>
      count <= 1 ? (topY + botY) * 0.5 : topY + (idx / (count - 1)) * (botY - topY);

    // Synaptic connections (modulated opacity by source activation)
    const drawLinks = (
      x0: number,
      vals0: ArrayLike<number>,
      x1: number,
      vals1: ArrayLike<number>
    ) => {
      for (let i = 0; i < vals0.length; i++) {
        const y0 = yFor(i, vals0.length);
        const a0 = Math.abs(vals0[i]);
        if (a0 < 0.08) continue;
        for (let j = 0; j < vals1.length; j += 2) {
          const y1 = yFor(j, vals1.length);
          const strength = Math.min(0.42, a0 * Math.abs(vals1[j]) * 0.55);
          if (strength < 0.04) continue;
          ctx.strokeStyle =
            vals0[i] >= 0
              ? `rgba(56, 189, 248, ${strength.toFixed(2)})`
              : `rgba(99, 102, 241, ${strength.toFixed(2)})`;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      }
    };

    drawLinks(colX[0], snapshot.obs, colX[1], h1Vals);
    drawLinks(colX[1], h1Vals, colX[2], h2Vals);
    drawLinks(colX[2], h2Vals, colX[3], snapshot.mean);

    // Input nodes (14)
    ctx.font = "9px 'Cascadia Mono', Consolas, monospace";
    for (let i = 0; i < 14; i++) {
      const y = yFor(i, 14);
      const v = snapshot.obs[i] ?? 0;
      ctx.fillStyle = activationColor(v);
      ctx.beginPath();
      ctx.arc(colX[0], y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(`${INPUT_LABELS[i]}`, 6, y + 3);
    }

    // Hidden layer 1 & 2 heatmap bars (all 64 neurons compactly shown) + sampled nodes
    const drawHiddenLayer = (x: number, full: Float32Array, sampled: Float32Array) => {
      const stripH = (botY - topY) / 64;
      for (let k = 0; k < 64; k++) {
        ctx.fillStyle = activationColor(full[k] ?? 0);
        ctx.fillRect(x - 10, topY + k * stripH, 5, Math.max(1.5, stripH - 0.5));
      }
      for (let i = 0; i < sampled.length; i++) {
        const y = yFor(i, sampled.length);
        ctx.fillStyle = activationColor(sampled[i]);
        ctx.beginPath();
        ctx.arc(x + 4, y, 3.8, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    drawHiddenLayer(colX[1], snapshot.actorHidden1, h1Vals);
    drawHiddenLayer(colX[2], snapshot.actorHidden2, h2Vals);

    // Output nodes (3) + Critic V(s)
    for (let i = 0; i < 3; i++) {
      const y = topY + (i + 1) * ((botY - topY) / 4);
      const val = i === 0 ? 0.5 * (snapshot.mean[0] + 1) : snapshot.mean[i];
      ctx.fillStyle = activationColor(snapshot.mean[i]);
      ctx.beginPath();
      ctx.arc(colX[3], y, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e2e8f0";
      const txt =
        i === 0
          ? `${OUTPUT_LABELS[i]} ${Math.round(Math.max(0, Math.min(1, val)) * 100)}%`
          : `${OUTPUT_LABELS[i]} ${val >= 0 ? "+" : ""}${val.toFixed(2)}`;
      ctx.fillText(txt, colX[3] + 10, y + 3);
    }

    // Critic value badge
    ctx.fillStyle = "#34d399";
    ctx.font = "600 10px 'Cascadia Mono', Consolas, monospace";
    ctx.fillText(`CRITIC V(s) = ${snapshot.value.toFixed(2)}`, 8, h - 6);

    ctx.restore();
  }
}
