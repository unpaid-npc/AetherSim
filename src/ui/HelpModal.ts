import { createIcon, el } from "./dom";

/** Accessible Help & Keyboard Reference Modal overlay. */
export class HelpModal {
  public readonly root: HTMLDivElement;
  private open = false;

  constructor(appVersion: string) {
    this.root = el("div", "help-modal-backdrop");
    this.root.style.display = "none";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-hidden", "true");
    this.root.setAttribute("aria-label", `AetherSim v${appVersion} Quick Guide and Controls`);

    const modal = el("div", "glass-panel help-modal");
    const header = el("div", "drawer-header");
    header.style.padding = "0 0 10px 0";
    header.append(el("h3", undefined, `AetherSim v${appVersion} — Quick Guide & Controls`));
    const closeBtn = el("button", "ui-btn icon-only", undefined, "Close Help [Esc]");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close Help Modal");
    closeBtn.append(createIcon("close"));
    closeBtn.addEventListener("click", () => this.setOpen(false));
    header.append(closeBtn);

    const body = document.createElement("div");
    body.style.cssText = "display:flex;flex-direction:column;gap:10px;";
    body.innerHTML = `
      <p><strong>Mission, Global Sites, Fleet &amp; Orbital Explorer (v${appVersion}):</strong></p>
      <ul>
        <li>Click the top <strong>Mission Pill</strong> (<code>EARTH · STARBASE · STARSHIP · LAUNCH</code>) to switch <strong>Destination</strong> (Earth, Moon, Mars), <strong>6 Earth Launch Sites</strong> (Starbase, KSC LC-39A, Sriharikota, Kourou, Tanegashima, Baikonur), <strong>4 Rockets</strong> (Starship, Falcon 9, ISRO LVM3, Saturn V), and Pilot Mode.</li>
        <li>Click <strong>ORBITS</strong> (or click any satellite in space / <code>F6 Map</code>) to inspect the <strong>ISS</strong>, Tiangong, Hubble, Sentinel-2A, NOAA-20, GPS III, GOES-16, and Starlink demo train with live CelesTrak SGP4 data, 3D orbital paths &amp; Earth ground tracks.</li>
        <li><strong>3-Step Neural AI Workflow (AI Pilot Drawer):</strong> <code>1. Pre-Train Brain</code> (~1–2s BC + DAgger) &rarr; <code>2. Fast Train (PPO)</code> (Web Worker) &rarr; <code>3. Fly Trained AI (3D)</code>.</li>
      </ul>
      <p><strong>Keyboard Shortcuts &amp; Accessibility:</strong></p>
      <ul>
        <li><code>1 / 2 / 3</code> Switch Destination (<strong>Earth</strong> / <strong>Moon</strong> / <strong>Mars</strong>)</li>
        <li><code>F1 – F8</code> Cameras (Pad, Chase, Engine, Station, Free, Map, Booster, Auto)</li>
        <li><code>[ / ]</code> Step Physics Time Warp (<code>1x</code>–<code>50x</code>)</li>
        <li><code>Space</code> Launch / Start Mission or Trigger Stage Separation &middot; <code>R</code> Reset &amp; Re-lock Camera</li>
        <li><code>T</code> SAS Assist &middot; <code>G</code> Landing Legs &middot; <code>M</code> Mute Audio &middot; <code>V</code> Auto Director &middot; <code>Esc</code> Close Modals &amp; Drawers</li>
        <li><code>Manual Pilot:</code> <code>W/Shift</code> &amp; <code>S/Ctrl</code> Throttle &middot; <code>Z/X</code> 100%/0% &middot; <code>Arrows/IJKL</code> Tilt &middot; <code>Q/E</code> Roll</li>
      </ul>
    `;

    modal.append(header, body);
    this.root.append(modal);
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) {
        this.setOpen(false);
      }
    });
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.root.style.display = open ? "flex" : "none";
    this.root.setAttribute("aria-hidden", String(!open));
  }

  isOpen(): boolean {
    return this.open;
  }
}
