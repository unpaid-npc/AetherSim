import type { PlanetId } from "../config/planets";
import type {
  OrbitalCategory,
  OrbitalDataSource,
  SatelliteStateSnapshot,
} from "../orbital/SatelliteCatalog";
import type { OrbitalVisibilityOptions } from "../scene/OrbitalObjectManager";
import type { SceneTelemetry } from "../scene/SceneManager";
import { createIcon, el } from "./dom";
import { formatCoordinates } from "./formatters";

export interface OrbitalDrawerCallbacks {
  onSelectObject: (id: string) => void;
  onInspectObject: (id: string) => void;
  onViewInMap: (id: string) => void;
  onBackToVehicle: () => void;
  onToggleVisibility: (next: Partial<OrbitalVisibilityOptions>) => void;
  onRefreshLive: () => void;
  onClose: () => void;
}

type CategoryFilter = "all" | OrbitalCategory;

const EARTH_FILTERS: ReadonlyArray<{ id: CategoryFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "station", label: "Stations" },
  { id: "science", label: "Science" },
  { id: "earth_obs", label: "Earth Obs" },
  { id: "nav_geo", label: "Nav & GEO" },
  { id: "starlink", label: "Starlink" },
];

const OTHER_FILTERS: ReadonlyArray<{ id: CategoryFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "station", label: "Stations" },
  { id: "science", label: "Science" },
];

function classifyOrbitRegime(snap: SatelliteStateSnapshot): string {
  if (snap.planetId === "moon") {
    return snap.apogeeKm > 500 ? "NRHO / HALO" : "LLO POLAR";
  }
  if (snap.planetId === "mars") {
    return snap.inclinationDeg > 70 ? "LMO POLAR" : "LMO";
  }
  if (snap.altitudeKm > 33_000) return "GEO";
  if (snap.altitudeKm > 10_000) return "MEO";
  if (snap.inclinationDeg > 94) return "SSO";
  return "LEO";
}

function formatCategoryLabel(cat: OrbitalCategory): string {
  if (cat === "station") return "SPACE STATION";
  if (cat === "science") return "SCIENCE";
  if (cat === "earth_obs") return "EARTH OBS";
  if (cat === "nav_geo") return "NAV & GEO";
  return "STARLINK";
}

function formatSourcePill(
  source: OrbitalDataSource,
  planetId: PlanetId
): { text: string; cls: string } {
  if (planetId !== "earth" || source === "simulated") {
    return {
      text: planetId === "earth" ? "SIMULATED · OFFLINE" : "SIMULATED · ORBITER",
      cls: "simulated",
    };
  }
  if (source === "live_celestrak") {
    return { text: "LIVE · CELESTRAK", cls: "live" };
  }
  return { text: "CACHED · CELESTRAK", cls: "cached" };
}

function formatAltKm(km: number): string {
  if (km >= 1000) {
    return `${Math.round(km).toLocaleString()} km`;
  }
  return `${km.toFixed(1)} km`;
}

/**
 * Collapsible right-side Orbital Objects & Inspector drawer displaying live SGP4
 * CelesTrak telemetry, data provenance, category filters, 3D inspection controls,
 * and Earth surface ground-track toggles.
 */
export class OrbitalDrawer {
  public readonly root: HTMLElement;

  private readonly provenancePill: HTMLSpanElement;
  private readonly updatedText: HTMLSpanElement;
  private readonly provenanceNote: HTMLDivElement;
  private readonly refreshBtn: HTMLButtonElement;

  private readonly satToggleBtn: HTMLButtonElement;
  private readonly gtToggleBtn: HTMLButtonElement;
  private readonly ringsToggleBtn: HTMLButtonElement;

  private readonly filterBar: HTMLDivElement;
  private readonly listContainer: HTMLDivElement;
  private readonly rowEls = new Map<
    string,
    { btn: HTMLButtonElement; altEl: HTMLSpanElement; badgeEl: HTMLSpanElement }
  >();

  // Inspector Card handles
  private readonly inspNameEl: HTMLSpanElement;
  private readonly inspNoradEl: HTMLSpanElement;
  private readonly inspOpEl: HTMLSpanElement;
  private readonly inspCatBadge: HTMLSpanElement;
  private readonly inspSourceBadge: HTMLSpanElement;
  private readonly inspEpochEl: HTMLSpanElement;
  private readonly inspDescEl: HTMLParagraphElement;

  private readonly valAltEl: HTMLSpanElement;
  private readonly valVelEl: HTMLSpanElement;
  private readonly valIncEl: HTMLSpanElement;
  private readonly valPeriodEl: HTMLSpanElement;
  private readonly valApsidesEl: HTMLSpanElement;
  private readonly valLatLonEl: HTMLSpanElement;
  private readonly valRangeEl: HTMLSpanElement;
  private readonly valRegimeEl: HTMLSpanElement;

  private readonly inspectBtn: HTMLButtonElement;
  private readonly mapBtn: HTMLButtonElement;
  private readonly gtQuickBtn: HTMLButtonElement;
  private readonly backBtn: HTMLButtonElement;

  private readonly cb: OrbitalDrawerCallbacks;
  private open = false;
  private activeFilter: CategoryFilter = "all";
  private renderedPlanet: PlanetId | null = null;
  private renderedListKey = "";
  private currentSelectedId = "iss";
  private latestVisibility: OrbitalVisibilityOptions = {
    showSatellites: true,
    showGroundTrack: true,
    showAllOrbitRings: false,
  };

  constructor(callbacks: OrbitalDrawerCallbacks) {
    this.cb = callbacks;
    this.root = el("aside", "drawer-shell drawer-right orbital-drawer");
    this.root.setAttribute("aria-label", "Orbital Objects and Satellite Inspector");
    this.root.setAttribute("aria-hidden", "true");

    // --- Header ---
    const header = el("div", "drawer-header");
    const titleWrap = el("div", "drawer-title-wrap");
    titleWrap.append(
      el("span", "drawer-title", "ORBITAL OBJECTS"),
      el("span", "drawer-subtitle", "ISS, live SGP4 satellites, orbital paths & ground tracks")
    );
    const closeBtn = el("button", "ui-btn icon-only", undefined, "Close Orbital Inspector [Esc]");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close Orbital Inspector");
    closeBtn.append(createIcon("close"));
    closeBtn.addEventListener("click", callbacks.onClose);
    header.append(titleWrap, closeBtn);

    const scroll = el("div", "drawer-scroll");

    // --- 1. Data Provenance & Quick Toggles ---
    const provCard = el("section", "orbital-card stagger-card");
    provCard.style.setProperty("--stagger-idx", "0");

    const provTop = el("div", "orbital-prov-top");
    this.provenancePill = el("span", "provenance-pill simulated tabular", "SIMULATED · OFFLINE");
    this.refreshBtn = el(
      "button",
      "ui-btn",
      "Refresh Live",
      "Fetch fresh OMM/GP elements from CelesTrak (2h cache, rate-limited)"
    );
    this.refreshBtn.type = "button";
    this.refreshBtn.addEventListener("click", callbacks.onRefreshLive);
    provTop.append(this.provenancePill, this.refreshBtn);

    this.updatedText = el("span", "choice-meta tabular", "Updated: —");
    this.provenanceNote = el("div", "orbital-prov-note");
    this.provenanceNote.style.display = "none";

    const toggleRow = el("div", "orbital-toggle-row");
    this.satToggleBtn = el("button", "pill-btn active", "Satellites", "Show/hide orbital beacons & 3D meshes");
    this.satToggleBtn.type = "button";
    this.satToggleBtn.addEventListener("click", () =>
      callbacks.onToggleVisibility({ showSatellites: !this.latestVisibility.showSatellites })
    );

    this.gtToggleBtn = el("button", "pill-btn active", "Ground Track", "Show/hide ±1 orbit surface ground track");
    this.gtToggleBtn.type = "button";
    this.gtToggleBtn.addEventListener("click", () =>
      callbacks.onToggleVisibility({ showGroundTrack: !this.latestVisibility.showGroundTrack })
    );

    this.ringsToggleBtn = el("button", "pill-btn", "All Rings", "Show/hide orbital rings for all catalog satellites");
    this.ringsToggleBtn.type = "button";
    this.ringsToggleBtn.addEventListener("click", () =>
      callbacks.onToggleVisibility({ showAllOrbitRings: !this.latestVisibility.showAllOrbitRings })
    );
    toggleRow.append(this.satToggleBtn, this.gtToggleBtn, this.ringsToggleBtn);

    provCard.append(provTop, this.updatedText, this.provenanceNote, toggleRow);

    // --- 2. Category Filter + Catalog List ---
    const listSection = el("section", "config-group stagger-card");
    listSection.style.setProperty("--stagger-idx", "1");
    this.filterBar = el("div", "orbital-filter-bar");
    this.listContainer = el("div", "orbital-list");
    listSection.append(this.filterBar, this.listContainer);

    // --- 3. Selected Object Inspector Card ---
    const inspCard = el("section", "orbital-card inspector-card stagger-card");
    inspCard.style.setProperty("--stagger-idx", "2");

    const inspHead = el("div", "choice-card-top");
    this.inspNameEl = el("span", "inspector-title", "ISS (ZARYA)");
    this.inspCatBadge = el("span", "choice-badge featured", "SPACE STATION");
    inspHead.append(this.inspNameEl, this.inspCatBadge);

    const inspSub = el("div", "inspector-meta-row tabular");
    this.inspNoradEl = el("span", "choice-meta", "NORAD 25544");
    this.inspOpEl = el("span", "choice-meta", "NASA / ESA / JAXA");
    inspSub.append(this.inspNoradEl, this.inspOpEl);

    const inspProvRow = el("div", "inspector-meta-row tabular");
    this.inspSourceBadge = el("span", "provenance-pill simulated", "SIMULATED");
    this.inspEpochEl = el("span", "choice-meta", "Epoch: Approximate Simulated Epoch");
    inspProvRow.append(this.inspSourceBadge, this.inspEpochEl);

    this.inspDescEl = el("p", "inspector-desc", "");

    const telemGrid = el("div", "inspector-telem-grid");
    const makeCell = (label: string) => {
      const cell = el("div", "inspector-cell");
      const val = el("span", "inspector-val tabular", "—");
      cell.append(el("span", "telemetry-label", label), val);
      telemGrid.append(cell);
      return val;
    };
    this.valAltEl = makeCell("ALTITUDE");
    this.valVelEl = makeCell("VELOCITY");
    this.valIncEl = makeCell("INCLINATION");
    this.valPeriodEl = makeCell("PERIOD");
    this.valApsidesEl = makeCell("APOGEE / PERIGEE");
    this.valLatLonEl = makeCell("SUB-SAT LAT / LON");
    this.valRangeEl = makeCell("SITE RANGE");
    this.valRegimeEl = makeCell("ORBIT CLASS");

    const actionGrid = el("div", "inspector-actions");
    this.inspectBtn = el(
      "button",
      "ui-btn primary",
      "Inspect 3D",
      "Fly close-up 3D camera onto this orbital object"
    );
    this.inspectBtn.type = "button";
    this.inspectBtn.addEventListener("click", () => callbacks.onInspectObject(this.currentSelectedId));

    this.mapBtn = el("button", "ui-btn", "Map (F6)", "Frame orbital path & ground track in F6 Map view");
    this.mapBtn.type = "button";
    this.mapBtn.addEventListener("click", () => callbacks.onViewInMap(this.currentSelectedId));

    this.gtQuickBtn = el("button", "ui-btn", "Ground Track", "Toggle Earth surface ground track ribbon");
    this.gtQuickBtn.type = "button";
    this.gtQuickBtn.addEventListener("click", () =>
      callbacks.onToggleVisibility({ showGroundTrack: !this.latestVisibility.showGroundTrack })
    );

    this.backBtn = el("button", "ui-btn", "Back to Vehicle", "Return camera to active launch vehicle");
    this.backBtn.type = "button";
    this.backBtn.addEventListener("click", callbacks.onBackToVehicle);

    actionGrid.append(this.inspectBtn, this.mapBtn, this.gtQuickBtn, this.backBtn);

    inspCard.append(
      inspHead,
      inspSub,
      inspProvRow,
      this.inspDescEl,
      telemGrid,
      actionGrid
    );

    scroll.append(provCard, listSection, inspCard);
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

  private rebuildFilters(planetId: PlanetId): void {
    this.renderedPlanet = planetId;
    this.activeFilter = "all";
    this.filterBar.innerHTML = "";
    const specs = planetId === "earth" ? EARTH_FILTERS : OTHER_FILTERS;
    for (const f of specs) {
      const btn = el("button", "pill-btn", f.label);
      btn.type = "button";
      btn.dataset.filterId = f.id;
      btn.classList.toggle("active", f.id === this.activeFilter);
      btn.addEventListener("click", () => {
        this.activeFilter = f.id;
        this.renderedListKey = "";
        this.syncFilterHighlights();
      });
      this.filterBar.append(btn);
    }
  }

  private syncFilterHighlights(): void {
    for (const child of Array.from(this.filterBar.children)) {
      if (child instanceof HTMLButtonElement) {
        child.classList.toggle("active", child.dataset.filterId === this.activeFilter);
      }
    }
  }

  private rebuildList(objects: readonly SatelliteStateSnapshot[]): void {
    this.listContainer.innerHTML = "";
    this.rowEls.clear();

    for (const obj of objects) {
      const btn = el("button", "orbital-row-btn", undefined, `Select ${obj.name}`);
      btn.type = "button";
      const left = el("div", "orbital-row-left");
      const dot = el("span", "orbital-dot");
      dot.style.backgroundColor = obj.accentHex;
      const nameWrap = el("div", "orbital-row-names");
      const titleEl = el("span", "orbital-row-title", obj.name);
      const badgeEl = el(
        "span",
        "orbital-row-sub tabular",
        obj.noradId ? `NORAD ${obj.noradId}` : "SIMULATED"
      );
      nameWrap.append(titleEl, badgeEl);
      left.append(dot, nameWrap);

      const altEl = el("span", "orbital-row-alt tabular", formatAltKm(obj.altitudeKm));
      btn.append(left, altEl);
      btn.addEventListener("click", () => this.cb.onSelectObject(obj.id));
      this.listContainer.append(btn);
      this.rowEls.set(obj.id, { btn, altEl, badgeEl });
    }
  }

  update(t: SceneTelemetry): void {
    const planetId = t.flight.planetId;
    if (this.renderedPlanet !== planetId) {
      this.rebuildFilters(planetId);
      this.renderedListKey = "";
    }

    this.latestVisibility = t.orbitalVisibility;
    this.currentSelectedId = t.selectedOrbitalId;

    // Provenance card
    const prov = t.orbitalProvenance;
    const pill = formatSourcePill(prov.dataSource, planetId);
    this.provenancePill.textContent = pill.text;
    this.provenancePill.className = `provenance-pill ${pill.cls} tabular`;

    const isEarth = planetId === "earth";
    this.refreshBtn.style.display = isEarth ? "inline-flex" : "none";
    this.refreshBtn.disabled = prov.fetching;
    this.refreshBtn.textContent = prov.fetching ? "Refreshing…" : "Refresh Live";

    this.updatedText.textContent = isEarth
      ? `Updated: ${prov.lastUpdatedUtc} · ${prov.liveCount}/${prov.totalCatalogCount} live NORAD GP`
      : `Simulated planetary orbiters · ${t.orbitalObjects.length} tracked`;

    if (prov.lastError && isEarth) {
      this.provenanceNote.style.display = "block";
      this.provenanceNote.textContent = prov.lastError;
    } else {
      this.provenanceNote.style.display = "none";
    }

    this.satToggleBtn.classList.toggle("active", t.orbitalVisibility.showSatellites);
    this.satToggleBtn.setAttribute("aria-pressed", String(t.orbitalVisibility.showSatellites));
    this.gtToggleBtn.classList.toggle("active", t.orbitalVisibility.showGroundTrack);
    this.gtToggleBtn.setAttribute("aria-pressed", String(t.orbitalVisibility.showGroundTrack));
    this.ringsToggleBtn.classList.toggle("active", t.orbitalVisibility.showAllOrbitRings);
    this.ringsToggleBtn.setAttribute("aria-pressed", String(t.orbitalVisibility.showAllOrbitRings));

    // Filtered catalog list
    const filtered =
      this.activeFilter === "all"
        ? t.orbitalObjects
        : t.orbitalObjects.filter((o) => o.category === this.activeFilter);
    const listKey = `${planetId}|${this.activeFilter}|${filtered.map((o) => o.id).join(",")}`;
    if (listKey !== this.renderedListKey) {
      this.renderedListKey = listKey;
      this.rebuildList(filtered);
    }

    for (const obj of filtered) {
      const row = this.rowEls.get(obj.id);
      if (!row) continue;
      row.btn.classList.toggle("active", obj.id === t.selectedOrbitalId);
      row.altEl.textContent = formatAltKm(obj.altitudeKm);
      const srcTag =
        obj.dataSource === "live_celestrak"
          ? "LIVE"
          : obj.dataSource === "cached_celestrak"
            ? "CACHED"
            : "SIM";
      row.badgeEl.textContent = obj.noradId
        ? `NORAD ${obj.noradId} · ${srcTag}`
        : `DEMO · ${srcTag}`;
    }

    // Selected Inspector Card
    const selected =
      t.orbitalObjects.find((o) => o.id === t.selectedOrbitalId) ?? t.orbitalObjects[0];
    if (!selected) return;

    this.inspNameEl.textContent = selected.name;
    this.inspCatBadge.textContent = formatCategoryLabel(selected.category);
    this.inspNoradEl.textContent = selected.noradId
      ? `NORAD ${selected.noradId}`
      : "DEMO / SIMULATED";
    this.inspOpEl.textContent = selected.operator;

    const itemPill = formatSourcePill(selected.dataSource, selected.planetId);
    this.inspSourceBadge.textContent = itemPill.text;
    this.inspSourceBadge.className = `provenance-pill ${itemPill.cls}`;
    this.inspEpochEl.textContent = `Epoch: ${selected.tleEpochUtc}`;
    this.inspDescEl.textContent = selected.description;

    this.valAltEl.textContent = formatAltKm(selected.altitudeKm);
    this.valVelEl.textContent = `${selected.velocityKms.toFixed(2)} km/s`;
    this.valIncEl.textContent = `${selected.inclinationDeg.toFixed(2)}°`;
    this.valPeriodEl.textContent = `${selected.periodMin.toFixed(1)} min`;
    this.valApsidesEl.textContent = `${Math.round(selected.apogeeKm).toLocaleString()} / ${Math.round(selected.perigeeKm).toLocaleString()} km`;
    this.valLatLonEl.textContent = formatCoordinates(selected.latDeg, selected.lonDeg);
    this.valRangeEl.textContent = `${Math.round(selected.rangeFromSiteKm).toLocaleString()} km`;
    this.valRegimeEl.textContent = classifyOrbitRegime(selected);

    const inspectingThis = t.inspectedOrbitalId === selected.id;
    this.inspectBtn.textContent = inspectingThis ? "Inspecting 3D" : "Inspect 3D";
    this.inspectBtn.classList.toggle("active", inspectingThis);
    this.gtQuickBtn.classList.toggle("active", t.orbitalVisibility.showGroundTrack);
    this.backBtn.classList.toggle("active", t.inspectedOrbitalId !== null);
  }
}
