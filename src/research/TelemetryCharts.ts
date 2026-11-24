import type { TrainingMetrics } from "../ai/PPOTrainer";
import type { FlightLogSample } from "./DataExporter";

interface ChartSeries {
  readonly label: string;
  readonly color: string;
  readonly values: number[];
}

function drawChartPanel(
  canvas: HTMLCanvasElement,
  title: string,
  xLabels: number[],
  leftSeries: ChartSeries[],
  rightSeries?: ChartSeries[],
  leftUnit = "",
  rightUnit = ""
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const wCss = canvas.clientWidth || 320;
  const hCss = canvas.clientHeight || 110;
  if (canvas.width !== Math.round(wCss * dpr) || canvas.height !== Math.round(hCss * dpr)) {
    canvas.width = Math.round(wCss * dpr);
    canvas.height = Math.round(hCss * dpr);
  }
  ctx.save();
  ctx.scale(dpr, dpr);

  ctx.fillStyle = "rgba(6, 10, 18, 0.92)";
  ctx.fillRect(0, 0, wCss, hCss);

  const padL = 38;
  const padR = rightSeries && rightSeries.length > 0 ? 38 : 10;
  const padT = 20;
  const padB = 18;
  const plotW = Math.max(20, wCss - padL - padR);
  const plotH = Math.max(20, hCss - padT - padB);

  // Gridlines
  ctx.strokeStyle = "rgba(148, 178, 214, 0.12)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const gy = padT + (plotH * i) / 3;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(padL + plotW, gy);
    ctx.stroke();
  }

  // Title
  ctx.fillStyle = "#cbd5e1";
  ctx.font = "600 10px 'Cascadia Mono', Consolas, monospace";
  ctx.fillText(title, 6, 12);

  // Legend top-right
  let lx = wCss - 8;
  const allSeries = [...leftSeries, ...(rightSeries ?? [])];
  for (let i = allSeries.length - 1; i >= 0; i--) {
    const s = allSeries[i];
    const tw = ctx.measureText(s.label).width;
    lx -= tw + 14;
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, 6, 7, 7);
    ctx.fillStyle = "#94a3b8";
    ctx.fillText(s.label, lx + 10, 12);
  }

  if (xLabels.length < 2) {
    ctx.fillStyle = "#64748b";
    ctx.font = "10px 'Cascadia Mono', Consolas, monospace";
    ctx.fillText("Waiting for telemetry...", padL + 8, padT + plotH * 0.54);
    ctx.restore();
    return;
  }

  const computeBounds = (seriesList: ChartSeries[]) => {
    let minV = Infinity;
    let maxV = -Infinity;
    for (const s of seriesList) {
      for (const v of s.values) {
        if (Number.isFinite(v)) {
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
    }
    if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
      return { minV: 0, maxV: 1 };
    }
    if (Math.abs(maxV - minV) < 1e-4) {
      minV -= 1;
      maxV += 1;
    }
    return { minV, maxV };
  };

  const renderGroup = (
    seriesList: ChartSeries[],
    minV: number,
    maxV: number
  ) => {
    const span = Math.max(1e-5, maxV - minV);
    const n = xLabels.length;
    for (const s of seriesList) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < s.values.length; i++) {
        const px = padL + (i / Math.max(1, n - 1)) * plotW;
        const norm = (s.values[i] - minV) / span;
        const py = padT + (1 - Math.max(0, Math.min(1, norm))) * plotH;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  };

  const lBounds = computeBounds(leftSeries);
  renderGroup(leftSeries, lBounds.minV, lBounds.maxV);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "9px 'Cascadia Mono', Consolas, monospace";
  ctx.fillText(`${lBounds.maxV.toFixed(0)}${leftUnit}`, 3, padT + 7);
  ctx.fillText(`${lBounds.minV.toFixed(0)}${leftUnit}`, 3, padT + plotH);

  if (rightSeries && rightSeries.length > 0) {
    const rBounds = computeBounds(rightSeries);
    renderGroup(rightSeries, rBounds.minV, rBounds.maxV);
    ctx.fillStyle = rightSeries[0].color;
    const topTxt = `${rBounds.maxV.toFixed(1)}${rightUnit}`;
    const botTxt = `${rBounds.minV.toFixed(1)}${rightUnit}`;
    ctx.fillText(topTxt, padL + plotW + 3, padT + 7);
    ctx.fillText(botTxt, padL + plotW + 3, padT + plotH);
  }

  // X range labels
  const tStart = xLabels[0];
  const tEnd = xLabels[xLabels.length - 1];
  ctx.fillStyle = "#64748b";
  ctx.fillText(`${tStart.toFixed(0)}`, padL, hCss - 4);
  const endStr = `${tEnd.toFixed(0)}`;
  ctx.fillText(endStr, padL + plotW - ctx.measureText(endStr).width, hCss - 4);

  ctx.restore();
}

/**
 * Renders 4 high-DPI HTML5 canvas streaming scientific & RL training charts.
 */
export class TelemetryCharts {
  public readonly root = document.createElement("div");
  private readonly cAltVy = document.createElement("canvas");
  private readonly cQG = document.createElement("canvas");
  private readonly cTiltThr = document.createElement("canvas");
  private readonly cPpo = document.createElement("canvas");

  constructor() {
    this.root.className = "charts-stack";
    for (const c of [this.cAltVy, this.cQG, this.cTiltThr, this.cPpo]) {
      c.className = "research-chart-canvas";
      this.root.append(c);
    }
  }

  render(
    flightLog: readonly FlightLogSample[],
    trainingHistory: readonly TrainingMetrics[]
  ): void {
    const tail = flightLog.slice(-180);
    const times = tail.map((s) => s.tSec);

    drawChartPanel(
      this.cAltVy,
      "ALTITUDE & VERT VEL",
      times,
      [{ label: "Alt(m)", color: "#38bdf8", values: tail.map((s) => s.altM) }],
      [{ label: "Vy(m/s)", color: "#fbbf24", values: tail.map((s) => s.vy) }],
      "m",
      ""
    );

    drawChartPanel(
      this.cQG,
      "DYNAMIC PRESS & G-LOAD",
      times,
      [{ label: "q(kPa)", color: "#f97316", values: tail.map((s) => s.qKpa) }],
      [{ label: "G", color: "#34d399", values: tail.map((s) => s.gLoad) }],
      "k",
      "g"
    );

    drawChartPanel(
      this.cTiltThr,
      "ATTITUDE TILT & THROTTLE",
      times,
      [{ label: "Tilt(°)", color: "#f87171", values: tail.map((s) => s.tiltDeg) }],
      [{ label: "Thr(%)", color: "#a78bfa", values: tail.map((s) => s.throttle * 100) }],
      "°",
      "%"
    );

    const epX = trainingHistory.map((m) => m.episodesCompleted);
    drawChartPanel(
      this.cPpo,
      "PPO LEARNING CURVE",
      epX,
      [
        {
          label: "LastRet",
          color: "rgba(148, 163, 184, 0.55)",
          values: trainingHistory.map((m) => m.lastEpisodeReturn),
        },
        {
          label: "Mean20",
          color: "#38bdf8",
          values: trainingHistory.map((m) => m.rollingMeanReturn),
        },
      ],
      [
        {
          label: "Succ%",
          color: "#34d399",
          values: trainingHistory.map((m) => m.landingSuccessRatePct),
        },
      ],
      "",
      "%"
    );
  }
}
