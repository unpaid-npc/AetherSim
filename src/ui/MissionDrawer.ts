import {
  EARTH_LAUNCH_SITES,
  type LaunchSiteId,
  getLaunchSiteConfig,
  getLaunchSitesForPlanet,
} from "../config/launchSites";
import {
  DESTINATION_DISPLAY_ORDER,
  type PlanetId,
  getPlanetConfig,
} from "../config/planets";
import {
  VEHICLE_LIST,
  type VehicleId,
  getVehicleConfig,
} from "../config/vehicles";
import type { SceneTelemetry } from "../scene/SceneManager";
import type { ControlMode, MissionMode } from "../sim/FlightController";
import { createIcon, el } from "./dom";
import { formatCoordinates } from "./formatters";

export interface MissionDrawerCallbacks {
  onSelectPlanet: (id: PlanetId) => void;
  onSelectLaunchSite: (id: LaunchSiteId) => void;
  onSelectVehicle: (id: VehicleId) => void;
  onSelectMissionMode: (mode: MissionMode) => void;
  onSelectControlMode: (mode: ControlMode) => void;
  onClose: () => void;
}

/**
 * Slide-over Mission Configurator cleanly structuring Destination, Global Launch Site,
 * Multi-Rocket Vehicle Fleet, and Mission & Pilot selection.
 */
export class MissionDrawer {
  public readonly root: HTMLElement;

  private readonly destBtns = new Map<PlanetId, HTMLButtonElement>();
  private readonly siteGridEl: HTMLDivElement;
  private readonly siteCountBadgeEl: HTMLSpanElement;
  private readonly siteBtns = new Map<LaunchSiteId, HTMLButtonElement>();
  private readonly vehBtns = new Map<VehicleId, HTMLButtonElement>();
  private renderedPlanetId: PlanetId | null = null;
  private readonly onSelectLaunchSite: (id: LaunchSiteId) => void;

  private readonly launchBtn: HTMLButtonElement;
  private readonly landingBtn: HTMLButtonElement;
  private readonly pidBtn: HTMLButtonElement;
  private readonly aiBtn: HTMLButtonElement;
  private readonly manualBtn: HTMLButtonElement;
  private readonly manualHintBox: HTMLDivElement;

  private open = false;

  constructor(callbacks: MissionDrawerCallbacks) {
    this.onSelectLaunchSite = callbacks.onSelectLaunchSite;
    this.root = el("aside", "drawer-shell drawer-left");
    this.root.setAttribute("aria-label", "Mission Setup");
    this.root.setAttribute("aria-hidden", "true");

    const header = el("div", "drawer-header");
    const titleWrap = el("div", "drawer-title-wrap");
    titleWrap.append(
      el("span", "drawer-title", "MISSION SETUP"),
      el("span", "drawer-subtitle", "Destination, spaceport, launch vehicle & flight control")
    );
    const closeBtn = el("button", "ui-btn icon-only", undefined, "Close Mission Setup [Esc]");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close Mission Setup");
    closeBtn.append(createIcon("close"));
    closeBtn.addEventListener("click", callbacks.onClose);
    header.append(titleWrap, closeBtn);

    const scroll = el("div", "drawer-scroll");

    // 1. Destination Card Group (Earth-first order)
    const destGroup = el("section", "config-group stagger-card");
    destGroup.style.setProperty("--stagger-idx", "0");
    const destHead = el("div", "config-group-head");
    destHead.append(el("span", "config-group-label", "1. DESTINATION"), el("span", "future-slot-tag", "1:1 REAL SCALE"));
    const destGrid = el("div", "dest-grid");

    DESTINATION_DISPLAY_ORDER.forEach((id, idx) => {
      const cfg = getPlanetConfig(id);
      const card = el("button", "choice-card", undefined, `Switch world to ${cfg.name}`);
      card.type = "button";
      const top = el("div", "choice-card-top");
      top.append(el("span", "choice-card-title", `${idx + 1} · ${cfg.name}`));
      const badge = el(
        "span",
        id === "earth" ? "choice-badge featured" : "choice-badge",
        id === "earth" ? "FEATURED" : `${cfg.physics.gravityMps2.toFixed(2)} m/s²`
      );
      top.append(badge);
      const meta = el(
        "span",
        "choice-meta tabular",
        `${cfg.physics.gravityMps2.toFixed(2)} m/s² · ${cfg.physics.atmosphereLabel} · Orbit ${(cfg.scale.targetOrbitAltM / 1000).toFixed(0)} km`
      );
      card.append(top, meta);
      card.addEventListener("click", () => callbacks.onSelectPlanet(id));
      destGrid.append(card);
      this.destBtns.set(id, card);
    });
    destGroup.append(destHead, destGrid);

    // 2. Global Launch Site Card Group
    const siteGroup = el("section", "config-group stagger-card");
    siteGroup.style.setProperty("--stagger-idx", "1");
    const siteHead = el("div", "config-group-head");
    this.siteCountBadgeEl = el(
      "span",
      "future-slot-tag",
      `${EARTH_LAUNCH_SITES.length} EARTH SITES`
    );
    siteHead.append(el("span", "config-group-label", "2. LAUNCH SITE"), this.siteCountBadgeEl);
    this.siteGridEl = el("div", "site-grid");
    this.rebuildSiteCards("earth");
    siteGroup.append(siteHead, this.siteGridEl);

    // 3. Vehicle Fleet Card Group
    const vehGroup = el("section", "config-group stagger-card");
    vehGroup.style.setProperty("--stagger-idx", "2");
    const vehHead = el("div", "config-group-head");
    vehHead.append(
      el("span", "config-group-label", "3. LAUNCH VEHICLE"),
      el("span", "future-slot-tag", `${VEHICLE_LIST.length} ROCKETS`)
    );
    const vehGrid = el("div", "vehicle-grid");
    for (const v of VEHICLE_LIST) {
      const vehCard = el("button", "choice-card compact-card", undefined, `${v.name}: ${v.description}`);
      vehCard.type = "button";
      const vehTop = el("div", "choice-card-top");
      vehTop.append(
        el("span", "choice-card-title", v.name),
        el("span", v.rtlsCapable ? "choice-badge featured" : "choice-badge", v.badge)
      );
      vehCard.append(
        vehTop,
        el("span", "choice-meta tabular", `${v.heightM} m · ${v.enginesSummary}`)
      );
      vehCard.addEventListener("click", () => callbacks.onSelectVehicle(v.id));
      vehGrid.append(vehCard);
      this.vehBtns.set(v.id, vehCard);
    }
    vehGroup.append(vehHead, vehGrid);

    // 4. Mission Profile & Flight Control
    const modeGroup = el("section", "config-group stagger-card");
    modeGroup.style.setProperty("--stagger-idx", "3");
    modeGroup.append(el("span", "config-group-label", "4. MISSION & PILOT MODE"));

    const modeGrid = el("div", "mode-grid");
    this.launchBtn = el("button", "choice-card", undefined, "Full-stack launch, hot-stage & orbit insertion");
    this.launchBtn.type = "button";
    this.launchBtn.append(
      el("span", "choice-card-title", "Orbital Launch"),
      el("span", "choice-meta", "Ascent + RTLS Booster")
    );
    this.launchBtn.addEventListener("click", () => callbacks.onSelectMissionMode("launch"));

    this.landingBtn = el("button", "choice-card", undefined, "Propulsive belly-flop flip & pad touchdown");
    this.landingBtn.type = "button";
    this.landingBtn.append(
      el("span", "choice-card-title", "Propulsive Landing"),
      el("span", "choice-meta", "Terminal Flip & Touchdown")
    );
    this.landingBtn.addEventListener("click", () => callbacks.onSelectMissionMode("landing"));
    modeGrid.append(this.launchBtn, this.landingBtn);

    const pilotGrid = el("div", "pilot-grid");
    this.pidBtn = el("button", "ui-btn", "PID AUTO", "Classical analytical guidance autopilot");
    this.pidBtn.type = "button";
    this.pidBtn.addEventListener("click", () => callbacks.onSelectControlMode("autopilot"));

    this.aiBtn = el("button", "ui-btn", "AI (PPO)", "Continuous PPO neural network flight control");
    this.aiBtn.type = "button";
    this.aiBtn.addEventListener("click", () => callbacks.onSelectControlMode("ai_ppo"));

    this.manualBtn = el("button", "ui-btn", "MANUAL", "Direct keyboard throttle, TVC gimbal & RCS");
    this.manualBtn.type = "button";
    this.manualBtn.addEventListener("click", () => callbacks.onSelectControlMode("manual"));
    pilotGrid.append(this.pidBtn, this.aiBtn, this.manualBtn);

    this.manualHintBox = el(
      "div",
      "manual-controls-box",
      "MANUAL KEYS: W/Shift +Thr · S/Ctrl -Thr · Z 100% · X 0% · Arrows/IJKL Tilt · Q/E Roll · T SAS · G Legs · Space Start/Sep"
    );
    this.manualHintBox.style.display = "none";

    modeGroup.append(modeGrid, pilotGrid, this.manualHintBox);
    scroll.append(destGroup, siteGroup, vehGroup, modeGroup);
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

  private rebuildSiteCards(planetId: PlanetId): void {
    this.renderedPlanetId = planetId;
    this.siteGridEl.innerHTML = "";
    this.siteBtns.clear();
    const sites = getLaunchSitesForPlanet(planetId);
    this.siteCountBadgeEl.textContent =
      sites.length > 1 ? `${sites.length} EARTH SITES` : "REGIONAL SITE";

    for (const site of sites) {
      const card = el(
        "button",
        "choice-card compact-card",
        undefined,
        `${site.name} (${site.region}) — ${site.description}`
      );
      card.type = "button";
      const top = el("div", "choice-card-top");
      top.append(
        el("span", "choice-card-title", site.shortName),
        el("span", "choice-badge", site.biomeBadge)
      );
      const meta = el(
        "span",
        "choice-meta tabular",
        `${site.country} · ${formatCoordinates(site.latDeg, site.lonDeg)}`
      );
      card.append(top, meta);
      card.addEventListener("click", () => this.onSelectLaunchSite(site.id));
      this.siteGridEl.append(card);
      this.siteBtns.set(site.id, card);
    }
  }

  update(t: SceneTelemetry): void {
    const f = t.flight;
    if (this.renderedPlanetId !== f.planetId) {
      this.rebuildSiteCards(f.planetId);
    }
    for (const [id, card] of this.destBtns.entries()) {
      card.classList.toggle("active", id === f.planetId);
    }

    const activeSiteId = getLaunchSiteConfig(t.launchSiteId).id;
    for (const [id, card] of this.siteBtns.entries()) {
      card.classList.toggle("active", id === activeSiteId);
    }

    const veh = getVehicleConfig(t.vehicleId);
    for (const [id, card] of this.vehBtns.entries()) {
      card.classList.toggle("active", id === veh.id);
    }

    this.launchBtn.classList.toggle("active", f.missionMode === "launch");
    this.landingBtn.classList.toggle("active", f.missionMode === "landing");
    this.landingBtn.style.opacity = veh.supportsLandingMode ? "1" : "0.52";
    this.landingBtn.title = veh.supportsLandingMode
      ? "Propulsive belly-flop flip & pad touchdown"
      : `${veh.shortName} is orbital-launch only (clicking keeps Launch mode)`;
    this.pidBtn.classList.toggle("active", f.controlMode === "autopilot");
    this.aiBtn.classList.toggle("active", f.controlMode === "ai_ppo");
    this.manualBtn.classList.toggle("active", f.controlMode === "manual");
    this.manualHintBox.style.display = f.controlMode === "manual" ? "block" : "none";
  }
}
