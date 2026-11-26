import { el } from "./dom";

export type ToastTone = "info" | "ok" | "warn" | "danger";

const MAX_TOASTS = 3;

/** Non-blocking flight milestone & accessibility notification banner queue. */
export class ToastSystem {
  public readonly root: HTMLDivElement;
  private recentMap = new Map<string, number>();

  constructor() {
    this.root = el("div", "toast-stack");
    this.root.setAttribute("aria-live", "polite");
    this.root.setAttribute("aria-atomic", "false");
  }

  show(
    title: string,
    detail?: string,
    tone: ToastTone = "info",
    durationMs = 3400
  ): void {
    const key = `${tone}:${title}`;
    const now = performance.now();
    const last = this.recentMap.get(key) ?? 0;
    if (now - last < 900) {
      return;
    }
    this.recentMap.set(key, now);

    while (this.root.children.length >= MAX_TOASTS) {
      this.root.firstElementChild?.remove();
    }

    const item = el("div", `toast-item ${tone}`);
    const dot = el("span", "toast-dot");
    const strong = el("strong", undefined, title);
    item.append(dot, strong);
    if (detail) {
      item.append(el("span", "toast-detail", detail));
    }

    this.root.append(item);
    window.requestAnimationFrame(() => {
      item.classList.add("visible");
    });

    window.setTimeout(() => {
      item.classList.remove("visible");
      window.setTimeout(() => item.remove(), 220);
    }, durationMs);
  }
}
