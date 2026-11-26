import type { ActivationSnapshot } from "../ai/NeuralNetwork";
import type { TrainingMetrics } from "../ai/PPOTrainer";
import {
  buildExperimentBundleJSON,
  formatFlightTelemetryCSV,
  formatTrainingHistoryCSV,
  triggerBrowserDownload,
  type FlightLogSample,
} from "../research/DataExporter";
import type { MonteCarloPilot, MonteCarloSummary } from "../research/MonteCarloRunner";
import { NeuralNetVisualizer } from "../research/NeuralNetVisualizer";
import { TelemetryCharts } from "../research/TelemetryCharts";
import type { FaultConfig } from "../sim/FaultInjector";
import type { FlightTelemetry } from "../sim/FlightController";
import { createIcon, el } from "./dom";

export type ResearchTab = "plots" | "nn" | "faults" | "mc" | "export";

export interface ResearchDrawerCallbacks {
  appVersion: string;
  onSetFaults: (cfg: Partial<FaultConfig>) => void;
  onResetFaults: () => FaultConfig;
  onGetFaults: () => FaultConfig;
  onRunMonteCarlo: (episodes: number, pilot: MonteCarloPilot) => void;
  onIsMonteCarloRunning: () => boolean;
  onGetFlightLog: () => readonly FlightLogSample[];
  onGetTrainingHistory: () => readonly TrainingMetrics[];
  onGetLastActivations: () => ActivationSnapshot | null;
  onGetFlightTelemetry: () => FlightTelemetry;
  onClose: () => void;
}

const TAB_DEFS: ReadonlyArray<{ id: ResearchTab; label: string; tip: string }> = [
  { id: "plots", label: "PLOTS", tip: "Live streaming flight & PPO learning charts" },
  { id: "nn", label: "NEURAL NET", tip: "Live 14→64→64→3 actor activation visualizer" },
  { id: "faults", label: "FAULTS", tip: "Inject thrust loss, crosswind, IMU bias/noise & TVC lag" },
  { id: "mc", label: "MONTE CARLO", tip: "Batch 20/50/100 seeded dispersion runs with 95% CI" },
  { id: "export", label: "EXPORT", tip: "Export flight CSV, RL training CSV, and JSON bundle" },
];

/** Right slide-over Aerospace Research Workbench housing all 5 research tabs. */
export class ResearchDrawer {
  public readonly root: HTMLElement;

  private readonly charts = new TelemetryCharts();
  private readonly nnViz = new NeuralNetVisualizer();
  private readonly tabBtns = new Map<ResearchTab, HTMLButtonElement>();
  private readonly tabViews = new Map<ResearchTab, HTMLElement>();

  private readonly mcStatusEl: HTMLDivElement;
  private readonly mcSummaryEl: HTMLDivElement;

  private activeTab: ResearchTab = "plots";
  private open = false;
  private lastChartRepaintMs = 0;
  private latestMcSummary: MonteCarloSummary | null = null;
  private readonly cb: ResearchDrawerCallbacks;

  constructor(callbacks: ResearchDrawerCallbacks) {
    this.cb = callbacks;
    this.root = el("aside", "drawer-shell drawer-right");
    this.root.setAttribute("aria-label", "Aerospace Research Lab");
    this.root.setAttribute("aria-hidden", "true");

    const header = el("div", "drawer-header");
    const titleWrap = el("div", "drawer-title-wrap");
    titleWrap.append(
      el("span", "drawer-title", "RESEARCH LAB"),
      el("span", "drawer-subtitle", "Telemetry charts, NN activations, faults & Monte Carlo")
    );
    const closeBtn = el("button", "ui-btn icon-only", undefined, "Close Research Lab [Esc]");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close Research Lab");
    closeBtn.append(createIcon("close"));
    closeBtn.addEventListener("click", callbacks.onClose);
    header.append(titleWrap, closeBtn);

    const scroll = el("div", "drawer-scroll");

    const tabBar = el("div", "tab-bar");
    tabBar.setAttribute("role", "tablist");
    for (const td of TAB_DEFS) {
      const b = el("button", "tab-btn", td.label, td.tip);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => this.setActiveTab(td.id));
      tabBar.append(b);
      this.tabBtns.set(td.id, b);
    }

    // Tab 1: PLOTS
    const plotsView = el("div");
    plotsView.append(this.charts.root);
    this.tabViews.set("plots", plotsView);

    // Tab 2: NEURAL NET
    const nnView = el("div");
    nnView.append(this.nnViz.canvas);
    this.tabViews.set("nn", nnView);

    // Tab 3: FAULTS
    const faultsView = el("div", "section-divider");
    const makeSlider = (
      label: string,
      min: number,
      max: number,
      step: number,
      unit: string,
      initial: number,
      onChange: (v: number) => void
    ) => {
      const row = el("div", "fault-row");
      const head = el("div", "fault-row-head");
      const valStrong = el("strong", "tabular", `${initial}${unit}`);
      head.append(el("span", undefined, label), valStrong);
      const input = document.createElement("input");
      input.type = "range";
      input.className = "fault-slider";
      input.setAttribute("aria-label", label);
      input.setAttribute("aria-valuemin", String(min));
      input.setAttribute("aria-valuemax", String(max));
      input.setAttribute("aria-valuenow", String(initial));
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(initial);
      input.addEventListener("input", () => {
        const v = Number(input.value);
        input.setAttribute("aria-valuenow", String(v));
        valStrong.textContent = `${v}${unit}`;
        onChange(v);
      });
      row.append(head, input);
      faultsView.append(row);
      return { input, valStrong, unit };
    };

    const fThrust = makeSlider("Engine Thrust Loss", 0, 50, 5, "%", 0, (v) =>
      callbacks.onSetFaults({ thrustLossPct: v })
    );
    const fAlt = makeSlider("Thrust Fault Trigger Alt", 0, 1000, 50, "m", 0, (v) =>
      callbacks.onSetFaults({ thrustLossTriggerAltM: v })
    );
    const fWind = makeSlider("Crosswind / Gust Speed", 0, 40, 2, " m/s", 0, (v) =>
      callbacks.onSetFaults({ windSpeedMps: v })
    );
    const fBias = makeSlider("IMU Attitude Bias", 0, 10, 0.5, "°", 0, (v) =>
      callbacks.onSetFaults({ imuBiasDeg: v })
    );
    const fNoise = makeSlider("IMU Attitude Noise", 0, 5, 0.5, "°", 0, (v) =>
      callbacks.onSetFaults({ imuNoiseDeg: v })
    );

    const faultBtnRow = el("div", "action-row");
    const tvcLagBtn = el("button", "ui-btn", "TVC LAG: OFF", "Toggle actuator gimbal lag & 45% authority reduction");
    tvcLagBtn.type = "button";
    tvcLagBtn.setAttribute("aria-pressed", "false");
    tvcLagBtn.addEventListener("click", () => {
      const cur = callbacks.onGetFaults().tvcLagEnabled;
      callbacks.onSetFaults({ tvcLagEnabled: !cur });
      tvcLagBtn.textContent = !cur ? "TVC LAG: ON" : "TVC LAG: OFF";
      tvcLagBtn.classList.toggle("active", !cur);
      tvcLagBtn.setAttribute("aria-pressed", String(!cur));
    });
    const resetFaultsBtn = el("button", "ui-btn", "RESET FAULTS", "Restore nominal zero-fault conditions");
    resetFaultsBtn.type = "button";
    resetFaultsBtn.addEventListener("click", () => {
      const def = callbacks.onResetFaults();
      fThrust.input.value = String(def.thrustLossPct);
      fThrust.valStrong.textContent = `${def.thrustLossPct}${fThrust.unit}`;
      fAlt.input.value = String(def.thrustLossTriggerAltM);
      fAlt.valStrong.textContent = `${def.thrustLossTriggerAltM}${fAlt.unit}`;
      fWind.input.value = String(def.windSpeedMps);
      fWind.valStrong.textContent = `${def.windSpeedMps}${fWind.unit}`;
      fBias.input.value = String(def.imuBiasDeg);
      fBias.valStrong.textContent = `${def.imuBiasDeg}${fBias.unit}`;
      fNoise.input.value = String(def.imuNoiseDeg);
      fNoise.valStrong.textContent = `${def.imuNoiseDeg}${fNoise.unit}`;
      tvcLagBtn.textContent = "TVC LAG: OFF";
      tvcLagBtn.classList.remove("active");
    });
    faultBtnRow.append(tvcLagBtn, resetFaultsBtn);
    faultsView.append(faultBtnRow);
    this.tabViews.set("faults", faultsView);

    // Tab 4: MONTE CARLO
    const mcView = el("div", "section-divider");
    let mcPilot: MonteCarloPilot = "ai_ppo";
    const mcPilotRow = el("div", "action-row");
    const mcAiBtn = el("button", "ui-btn active", "PILOT: AI NEURAL");
    mcAiBtn.type = "button";
    const mcPidBtn = el("button", "ui-btn", "PILOT: PID AUTO");
    mcPidBtn.type = "button";
    mcAiBtn.addEventListener("click", () => {
      mcPilot = "ai_ppo";
      mcAiBtn.classList.add("active");
      mcPidBtn.classList.remove("active");
    });
    mcPidBtn.addEventListener("click", () => {
      mcPilot = "autopilot";
      mcPidBtn.classList.add("active");
      mcAiBtn.classList.remove("active");
    });
    mcPilotRow.append(mcAiBtn, mcPidBtn);

    const mcRunRow = el("div", "action-row");
    this.mcStatusEl = el("div", "drawer-subtitle", "Select sample count to run off-thread Monte Carlo dispersion trials.");
    this.mcSummaryEl = el("div", "mc-summary-grid");
    this.mcSummaryEl.style.display = "none";

    for (const n of [20, 50, 100]) {
      const rb = el("button", "ui-btn primary", `RUN ${n} TRIALS`);
      rb.type = "button";
      rb.addEventListener("click", () => {
        if (callbacks.onIsMonteCarloRunning()) return;
        this.mcStatusEl.textContent = `Running ${n} Monte Carlo trials off-thread...`;
        callbacks.onRunMonteCarlo(n, mcPilot);
      });
      mcRunRow.append(rb);
    }
    mcView.append(mcPilotRow, mcRunRow, this.mcStatusEl, this.mcSummaryEl);
    this.tabViews.set("mc", mcView);

    // Tab 5: EXPORT
    const exportView = el("div", "export-stack");
    const expFlightBtn = el("button", "ui-btn primary", "Export Flight Telemetry (.csv)");
    expFlightBtn.type = "button";
    expFlightBtn.addEventListener("click", () => {
      const csv = formatFlightTelemetryCSV(callbacks.onGetFlightLog());
      const tel = callbacks.onGetFlightTelemetry();
      triggerBrowserDownload(
        `aethersim-flight-${tel.planetId}-${tel.missionMode}.csv`,
        csv,
        "text/csv;charset=utf-8"
      );
    });

    const expTrainBtn = el("button", "ui-btn primary", "Export RL Training History (.csv)");
    expTrainBtn.type = "button";
    expTrainBtn.addEventListener("click", () => {
      const csv = formatTrainingHistoryCSV(callbacks.onGetTrainingHistory());
      triggerBrowserDownload("aethersim-ppo-training.csv", csv, "text/csv;charset=utf-8");
    });

    const expBundleBtn = el("button", "ui-btn", "Export Full Experiment Bundle (.json)");
    expBundleBtn.type = "button";
    expBundleBtn.addEventListener("click", () => {
      const tel = callbacks.onGetFlightTelemetry();
      const json = buildExperimentBundleJSON({
        aethersimVersion: callbacks.appVersion,
        planet: tel.planetId,
        mission: tel.missionMode,
        pilot: tel.controlMode,
        faultConfig: callbacks.onGetFaults(),
        monteCarloSummary: this.latestMcSummary,
        trainingHistory: callbacks.onGetTrainingHistory(),
        flightSeries: callbacks.onGetFlightLog(),
      });
      triggerBrowserDownload(
        `aethersim-experiment-${tel.planetId}-${tel.missionMode}.json`,
        json,
        "application/json"
      );
    });

    exportView.append(
      expFlightBtn,
      expTrainBtn,
      expBundleBtn,
      el(
        "div",
        "drawer-subtitle",
        "Exports include true physical state, active faults, Clopper-Pearson Monte Carlo statistics, and PPO training curves."
      )
    );
    this.tabViews.set("export", exportView);

    scroll.append(tabBar, plotsView, nnView, faultsView, mcView, exportView);
    this.root.append(header, scroll);
    this.setActiveTab("plots");
  }

  setActiveTab(tab: ResearchTab): void {
    this.activeTab = tab;
    for (const [id, b] of this.tabBtns.entries()) {
      const active = id === tab;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
    }
    for (const [id, view] of this.tabViews.entries()) {
      view.style.display = id === tab ? "block" : "none";
    }
    if (this.open) {
      this.repaintCanvases(true);
    }
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.root.classList.toggle("open", open);
    this.root.setAttribute("aria-hidden", String(!open));
    if (open) {
      this.repaintCanvases(true);
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  renderMonteCarloSummary(summary: MonteCarloSummary | null): void {
    this.latestMcSummary = summary;
    if (!summary) {
      this.mcSummaryEl.style.display = "none";
      return;
    }
    this.mcStatusEl.textContent = `Completed ${summary.episodes} trials in ${summary.durationMs} ms (${summary.pilot === "ai_ppo" ? "AI NEURAL" : "PID AUTO"} · ${summary.planet.toUpperCase()} ${summary.mission.toUpperCase()})`;
    this.mcSummaryEl.style.display = "grid";
    this.mcSummaryEl.innerHTML = "";
    const addStat = (label: string, value: string) => {
      const item = el("div", "telemetry-item");
      item.append(el("span", "telemetry-label", label), el("span", "telemetry-value tabular", value));
      this.mcSummaryEl.append(item);
    };
    addStat(
      "Success Rate (95% CI)",
      `${summary.successRatePct.toFixed(1)}% [${summary.ciLowPct.toFixed(1)}–${summary.ciHighPct.toFixed(1)}%]`
    );
    addStat("Crash / RUD Rate", `${summary.crashRatePct.toFixed(1)}% (${summary.crashCount}/${summary.episodes})`);
    addStat("Return (Mean ± Std)", `${summary.meanReturn.toFixed(1)} ± ${summary.stdReturn.toFixed(1)}`);
    addStat(
      "Mean Touchdown |vy|",
      summary.meanTouchdownVy !== null ? `${summary.meanTouchdownVy.toFixed(2)} m/s` : "N/A"
    );
    addStat(
      "Mean Pad Offset",
      summary.meanPadOffsetM !== null ? `${summary.meanPadOffsetM.toFixed(1)} m` : "N/A"
    );
    addStat("Mean Fuel Left", `${summary.meanFuelRemainingPct.toFixed(1)}%`);
  }

  repaintCanvases(force = false): void {
    if (!this.open) return;
    const now = performance.now();
    if (!force && now - this.lastChartRepaintMs < 62) {
      return; // ~16 Hz cap so 3D WebGL maintains smooth frame pacing
    }
    this.lastChartRepaintMs = now;
    if (this.activeTab === "plots") {
      this.charts.render(this.cb.onGetFlightLog(), this.cb.onGetTrainingHistory());
    } else if (this.activeTab === "nn") {
      this.nnViz.render(this.cb.onGetLastActivations());
    }
  }
}
