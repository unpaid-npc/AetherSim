export type IconName =
  | "globe"
  | "play"
  | "pause"
  | "reset"
  | "stage"
  | "brain"
  | "flask"
  | "sliders"
  | "help"
  | "close"
  | "chevronDown"
  | "target"
  | "orbit";

const SVG_NS = "http://www.w3.org/2000/svg";

const ICON_PATHS: Record<IconName, string[]> = {
  globe: [
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z",
    "M2 12h20",
    "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z",
  ],
  play: ["M6 4l14 8-14 8V4z"],
  pause: ["M7 4h4v16H7z", "M13 4h4v16h-4z"],
  reset: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5"],
  stage: ["M12 2v14", "M5 9l7-7 7 7", "M4 20h16"],
  brain: [
    "M9.5 4a3.5 3.5 0 0 0-3.5 3.5c0 .7.2 1.3.5 1.9A3.5 3.5 0 0 0 5 12.5a3.5 3.5 0 0 0 2.5 3.3A3.2 3.2 0 0 0 10.5 20h1V4h-2Z",
    "M14.5 4a3.5 3.5 0 0 1 3.5 3.5c0 .7-.2 1.3-.5 1.9a3.5 3.5 0 0 1 1.5 3.1 3.5 3.5 0 0 1-2.5 3.3A3.2 3.2 0 0 1 13.5 20h-1V4h2Z",
  ],
  flask: ["M9 3h6", "M10 3v5.2l-4.8 8.3A2 2 0 0 0 6.9 19.5h10.2a2 2 0 0 0 1.7-3L14 8.2V3"],
  sliders: [
    "M4 7h16",
    "M4 17h16",
    "M9 4v6",
    "M15 14v6",
  ],
  help: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
    "M9.4 9.2a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.3-2.6 4.1",
    "M12 17.5h.01",
  ],
  close: ["M6 6l12 12", "M18 6l-12 12"],
  chevronDown: ["M6 9l6 6 6-6"],
  target: [
    "M12 2v4",
    "M12 18v4",
    "M2 12h4",
    "M18 12h4",
    "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z",
  ],
  orbit: [
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
    "M2.6 15.8C1.2 13.6 4.4 9.2 9.8 6.4c5.4-2.8 10.8-3.2 12.2-1 1.4 2.2-1.8 6.6-7.2 9.4-5.4 2.8-10.8 3.2-12.2 1Z",
  ],
};

export function createIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "ui-icon");

  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
  tooltip?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (tooltip) node.title = tooltip;
  return node;
}
