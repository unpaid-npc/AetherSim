import type { PolicyCheckpoint } from "../ai/NeuralNetwork";
import type { SceneTelemetry } from "../scene/SceneManager";
import { createIcon, el } from "./dom";

export interface AIPilotDrawerCallbacks {
  onStartPreTrain: () => void;
  onToggleTurboTrain: () => void;
  onStartAIEval: () => void;
  onStartLiveTrain: () => void;
  onResetAIWeights: () => void;
  onSetLearningRate: (lr: number) => void;
  onToggleDomainRandomization: () => void;
  onExportCheckpoint: () => PolicyCheckpoint;
  onImportCheckpoint: (json: string) => void;
  onDownloadFile: (filename: string, content: string, mime: string) => void;
  onClose: () => void;
}

/** Optional slide-over drawer housing the Guided PPO Neural AI Pilot & Worker controls. */
export class AIPilotDrawer {
  public readonly root: HTMLElement;

  private readonly statePill: HTMLSpanElement;
  private readonly statusBanner: HTMLDivElement;
  private readonly statusDot: HTMLSpanElement;
  private readonly statusText: HTMLSpanElement;
  private readonly statusNote: HTMLDivElement;

  private readonly brainLevelVal: HTMLSpanElement;
  private readonly bestSuccessLbl: HTMLSpanElement;
  private readonly bestSuccessVal: HTMLSpanElement;
  private readonly epVal: HTMLSpanElement;
  private readonly rateVal: HTMLSpanElement;
  private readonly meanRetVal: HTMLSpanElement;
  private readonly bestRetVal: HTMLSpanElement;

  private readonly warmStartBtn: HTMLButtonElement;
  private readonly turboTrainBtn: HTMLButtonElement;
  private readonly flyTrainedBtn: HTMLButtonElement;
  private readonly liveTrainBtn: HTMLButtonElement;
  private readonly resetBrainBtn: HTMLButtonElement;

  private readonly lrBtns = new Map<number, HTMLButtonElement>();
  private readonly randBtn: HTMLButtonElement;
  private readonly errBanner: HTMLDivElement;

  private open = false;
  private advOpen = false;
  private resetConfirmArmed = false;
  private resetConfirmTimer: number | null = null;

  constructor(callbacks: AIPilotDrawerCallbacks) {
    this.root = el("aside", "drawer-shell drawer-left");
    this.root.setAttribute("aria-label", "Neural AI Pilot");
    this.root.setAttribute("aria-hidden", "true");

    const header = el("div", "drawer-header");
    const titleWrap = el("div", "drawer-title-wrap");
    titleWrap.append(
      el("span", "drawer-title", "NEURAL AI PILOT"),
      el("span", "drawer-subtitle", "Continuous PPO Actor-Critic · 14 → 64 → 64 → 3")
    );
    const rightHead = el("div", "topbar-right");
    this.statePill = el("span", "ai-state-pill", "IDLE");
    const closeBtn = el("button", "ui-btn icon-only", undefined, "Close AI Pilot Drawer [Esc]");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close AI Pilot Drawer");
    closeBtn.append(createIcon("close"));
    closeBtn.addEventListener("click", callbacks.onClose);
    rightHead.append(this.statePill, closeBtn);
    header.append(titleWrap, rightHead);

    const scroll = el("div", "drawer-scroll");

    this.statusBanner = el("div", "ai-status-banner status-idle-untrained stagger-card");
    this.statusBanner.style.setProperty("--stagger-idx", "0");
    this.statusDot = el("span", "ai-status-dot");
    this.statusText = el("span", "ai-status-banner-text", "IDLE — UNTRAINED BRAIN (Will Crash)");
    this.statusBanner.append(this.statusDot, this.statusText);

    this.statusNote = el(
      "div",
      "ai-status-note stagger-card",
      "Untrained random brain. Click 1. Pre-Train Brain or 2. Fast Train."
    );
    this.statusNote.style.setProperty("--stagger-idx", "1");

    const scorecard = el("div", "ai-scorecard stagger-card");
    scorecard.style.setProperty("--stagger-idx", "2");
    const makeRow = (label: string) => {
      const item = el("div", "telemetry-item");
      const lbl = el("span", "telemetry-label", label);
      const val = el("span", "telemetry-value tabular", "-");
      item.append(lbl, val);
      scorecard.append(item);
      return { lbl, val };
    };
    this.brainLevelVal = makeRow("Brain Level").val;
    const bestRow = makeRow("Best Landing");
    this.bestSuccessLbl = bestRow.lbl;
    this.bestSuccessVal = bestRow.val;
    this.epVal = makeRow("Train Episodes").val;
    this.rateVal = makeRow("Worker Speed").val;
    this.meanRetVal = makeRow("Live Rollout Ret").val;
    this.bestRetVal = makeRow("Best Eval Return").val;

    const guidedStack = el("div", "ai-guided-stack stagger-card");
    guidedStack.style.setProperty("--stagger-idx", "3");
    this.warmStartBtn = el(
      "button",
      "ui-btn primary",
      "1. PRE-TRAIN BRAIN (FAST)",
      "Pre-train via Behavior Cloning + DAgger (~1-2s), evaluate 5 trials, and save best brain"
    );
    this.warmStartBtn.type = "button";
    this.warmStartBtn.addEventListener("click", callbacks.onStartPreTrain);

    this.turboTrainBtn = el(
      "button",
      "ui-btn primary",
      "2. FAST TRAIN (PPO)",
      "Toggle background Web Worker PPO fine-tuning (safely protects Best Saved Brain)"
    );
    this.turboTrainBtn.type = "button";
    this.turboTrainBtn.addEventListener("click", callbacks.onToggleTurboTrain);

    this.flyTrainedBtn = el(
      "button",
      "ui-btn",
      "3. FLY TRAINED AI (3D)",
      "Loads Best Saved Brain, resets vehicle, and flies deterministically in 3D"
    );
    this.flyTrainedBtn.type = "button";
    this.flyTrainedBtn.addEventListener("click", callbacks.onStartAIEval);
    guidedStack.append(this.warmStartBtn, this.turboTrainBtn, this.flyTrainedBtn);

    const secondaryRow = el("div", "ai-secondary-row stagger-card");
    secondaryRow.style.setProperty("--stagger-idx", "4");
    this.liveTrainBtn = el(
      "button",
      "ui-btn",
      "WATCH LEARN (3D)",
      "Live 3D self-play: watch crashes, PPO updates & automatic retries"
    );
    this.liveTrainBtn.type = "button";
    this.liveTrainBtn.addEventListener("click", callbacks.onStartLiveTrain);

    this.resetBrainBtn = el(
      "button",
      "ui-btn",
      "RESET AI BRAIN",
      "Wipe learned neural weights back to random initialization (requires confirmation click)"
    );
    this.resetBrainBtn.type = "button";
    const clearConfirm = () => {
      this.resetConfirmArmed = false;
      this.resetBrainBtn.textContent = "RESET AI BRAIN";
      this.resetBrainBtn.classList.remove("danger-confirm");
      if (this.resetConfirmTimer !== null) {
        window.clearTimeout(this.resetConfirmTimer);
        this.resetConfirmTimer = null;
      }
    };
    this.resetBrainBtn.addEventListener("click", () => {
      if (!this.resetConfirmArmed) {
        this.resetConfirmArmed = true;
        this.resetBrainBtn.textContent = "Click again to confirm";
        this.resetBrainBtn.classList.add("danger-confirm");
        this.resetConfirmTimer = window.setTimeout(clearConfirm, 3000);
        return;
      }
      clearConfirm();
      callbacks.onResetAIWeights();
    });
    secondaryRow.append(this.liveTrainBtn, this.resetBrainBtn);

    // Collapsible Advanced Hyperparameters
    const advToggle = el("button", "ui-btn", "▸ Advanced Hyperparameters");
    advToggle.type = "button";
    advToggle.setAttribute("aria-expanded", "false");
    const advBody = el("div", "section-divider");
    advBody.style.display = "none";
    advToggle.addEventListener("click", () => {
      this.advOpen = !this.advOpen;
      advBody.style.display = this.advOpen ? "flex" : "none";
      advToggle.setAttribute("aria-expanded", String(this.advOpen));
      advToggle.textContent = this.advOpen
        ? "▾ Advanced Hyperparameters"
        : "▸ Advanced Hyperparameters";
    });

    const lrRow = el("div", "action-row");
    for (const lr of [3e-4, 6e-4, 1e-3]) {
      const lbl = lr === 3e-4 ? "LR 3e-4" : lr === 6e-4 ? "LR 6e-4" : "LR 1e-3";
      const b = el("button", "ui-btn", lbl, `Set Adam learning rate to ${lbl}`);
      b.type = "button";
      b.addEventListener("click", () => callbacks.onSetLearningRate(lr));
      lrRow.append(b);
      this.lrBtns.set(lr, b);
    }

    this.randBtn = el(
      "button",
      "ui-btn active",
      "RAND: ON",
      "Randomize initial position, velocity, and tilt during training"
    );
    this.randBtn.type = "button";
    this.randBtn.addEventListener("click", callbacks.onToggleDomainRandomization);

    const ckptRow = el("div", "action-row");
    const saveBtn = el("button", "ui-btn", "SAVE .JSON", "Download trained neural weights (.json)");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", () => {
      const cp = callbacks.onExportCheckpoint();
      callbacks.onDownloadFile(
        `aethersim-ppo-${cp.planet}-${cp.mission}-ep${cp.episodesCompleted}.json`,
        JSON.stringify(cp, null, 2),
        "application/json"
      );
    });

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      callbacks.onImportCheckpoint(await f.text());
      fileInput.value = "";
    });
    const loadBtn = el("button", "ui-btn", "LOAD .JSON", "Load saved .json neural weights");
    loadBtn.type = "button";
    loadBtn.addEventListener("click", () => fileInput.click());
    ckptRow.append(saveBtn, loadBtn, fileInput);
    advBody.append(lrRow, this.randBtn, ckptRow);

    this.errBanner = el("div", "status-banner crash");
    this.errBanner.style.display = "none";

    scroll.append(
      this.statusBanner,
      this.statusNote,
      scorecard,
      guidedStack,
      secondaryRow,
      advToggle,
      advBody,
      this.errBanner
    );
    this.root.append(header, scroll);
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.root.classList.toggle("open", open);
    this.root.setAttribute("aria-hidden", String(!open));
  }

  isOpen(): boolean {
    return this.open;
  }

  update(t: SceneTelemetry): void {
    const f = t.flight;
    const ai = t.ai;
    const m = ai.metrics;
    const best = ai.bestBrain;

    this.statePill.textContent =
      ai.mode === "pre_training"
        ? "PRE-TRAIN"
        : ai.mode === "live_train"
          ? "LIVE 3D"
          : ai.mode === "turbo_train"
            ? "TRAINING"
            : ai.mode === "eval"
              ? "FLYING AI"
              : "IDLE";
    this.statePill.className = `ai-state-pill ${
      ai.mode === "pre_training" || ai.mode === "live_train" || ai.mode === "turbo_train"
        ? "training"
        : ai.mode === "eval"
          ? "eval"
          : ""
    }`.trim();

    if (ai.mode === "pre_training") {
      this.statusBanner.className = "ai-status-banner status-pretrain";
      this.statusDot.className = "ai-status-dot pulsing";
      this.statusText.textContent = "PRE-TRAINING BRAIN... (Imitating Guidance)";
    } else if (ai.mode === "turbo_train") {
      this.statusBanner.className = "ai-status-banner status-turbo";
      this.statusDot.className = "ai-status-dot pulsing";
      this.statusText.textContent = `TRAINING IN BACKGROUND... (Ep ${m.episodesCompleted} | ${m.stepsPerSec.toLocaleString("en-US")} st/s)`;
    } else if (ai.mode === "live_train") {
      this.statusBanner.className = "ai-status-banner status-live";
      this.statusDot.className = "ai-status-dot pulsing";
      this.statusText.textContent = `WATCHING AI LEARN LIVE (3D Ep ${m.episodesCompleted})`;
    } else if (ai.mode === "eval") {
      this.statusBanner.className = best.hasTrainedWeights
        ? "ai-status-banner status-eval"
        : "ai-status-banner status-idle-untrained";
      this.statusDot.className = "ai-status-dot";
      this.statusText.textContent = best.hasTrainedWeights
        ? "FLYING BEST TRAINED AI (DETERMINISTIC)"
        : "FLYING UNTRAINED BRAIN (Will Crash)";
    } else if (best.hasTrainedWeights) {
      this.statusBanner.className = "ai-status-banner status-idle-ready";
      this.statusDot.className = "ai-status-dot";
      this.statusText.textContent = `IDLE — READY (${best.evalSafeRatePct.toFixed(0)}% Safe · ${best.evalSuccessCount}/${best.evalEpisodes} Nom)`;
    } else {
      this.statusBanner.className = "ai-status-banner status-idle-untrained";
      this.statusDot.className = "ai-status-dot";
      this.statusText.textContent = "IDLE — UNTRAINED BRAIN (Will Crash)";
    }

    this.statusNote.textContent = ai.statusMessage;

    this.warmStartBtn.disabled = ai.mode === "pre_training";
    this.warmStartBtn.textContent =
      ai.mode === "pre_training" ? "PRE-TRAINING..." : "1. PRE-TRAIN BRAIN (FAST)";
    this.turboTrainBtn.textContent =
      ai.mode === "turbo_train" ? "STOP TRAINING" : "2. FAST TRAIN (PPO)";
    this.turboTrainBtn.classList.toggle("warn-active", ai.mode === "turbo_train");
    this.turboTrainBtn.classList.toggle("active", ai.mode === "turbo_train");
    this.flyTrainedBtn.classList.toggle("active", ai.mode === "eval");
    this.liveTrainBtn.textContent =
      ai.mode === "live_train" ? "STOP LIVE 3D" : "WATCH LEARN (3D)";
    this.liveTrainBtn.classList.toggle("active", ai.mode === "live_train");

    this.randBtn.classList.toggle("active", ai.randomizeSpawn);
    this.randBtn.textContent = ai.randomizeSpawn ? "RAND: ON" : "RAND: OFF";
    for (const [lr, b] of this.lrBtns.entries()) {
      b.classList.toggle("active", Math.abs(ai.learningRate - lr) < 1e-6);
    }

    const levelLabel =
      ai.brainLevel === "ppo_trained"
        ? "PPO TRAINED"
        : ai.brainLevel === "pre_trained"
          ? "PRE-TRAINED"
          : "UNTRAINED";
    this.brainLevelVal.textContent = levelLabel;
    this.brainLevelVal.className = `telemetry-value tabular brain-level-badge ${ai.brainLevel}`;

    this.bestSuccessLbl.textContent = f.missionMode === "landing" ? "Best Landing" : "Best Launch";
    if (!best.hasTrainedWeights || best.evalEpisodes === 0) {
      this.bestSuccessVal.textContent = "Not Eval";
    } else if (f.missionMode === "landing") {
      this.bestSuccessVal.textContent =
        best.evalSuccessCount === best.evalEpisodes
          ? `100% (${best.evalEpisodes}/${best.evalEpisodes} nom)`
          : `${best.evalSafeRatePct.toFixed(0)}% safe (${best.evalSuccessCount}/${best.evalEpisodes} nom)`;
    } else {
      this.bestSuccessVal.textContent = `${best.evalSuccessRatePct.toFixed(0)}% (${best.evalSuccessCount}/${best.evalEpisodes})`;
    }

    this.epVal.textContent = `${m.episodesCompleted}`;
    this.rateVal.textContent =
      m.stepsPerSec > 0 ? `${m.stepsPerSec.toLocaleString("en-US")} st/s` : "0 st/s";
    this.meanRetVal.textContent = m.episodesCompleted > 0 ? m.rollingMeanReturn.toFixed(1) : "—";
    this.bestRetVal.textContent = best.hasTrainedWeights ? best.evalMeanReturn.toFixed(1) : "—";

    if (ai.lastError) {
      this.errBanner.style.display = "block";
      this.errBanner.textContent = `AI ERROR: ${ai.lastError}`;
    } else {
      this.errBanner.style.display = "none";
    }
  }
}
