// Dependency-free SVG elevation profile.
//
//   const profile = new ElevationProfile("profile", { units: "metric" });
//   profile.render(feature);
//
// Input: GeoJSON Feature with a 3D LineString or MultiLineString ([lng, lat, ele]).
// MultiLineString parts are joined end to end (gaps between parts are ignored).
// properties.length: total length in meters (optional, else computed).
// properties.sections: optional [{ id, values: [{ from, to, value }] }], one bar per
// section below the plot, from/to as 0..1 of the line length. For a MultiLineString
// one such array per part ([[...], [...]]), from/to relative to that part; sections
// with the same id are joined into one bar.
// Styling: .section-<id> (bar) and .section-<id>-<value> (segment and badge dot).
// Badge labels: options.locale["<id>.<value>"], else the raw value.
//
// Events (profile.on/off/once), all distances and elevations in meters (feet for imperial):
//   hover, click: { distance, elevation, lngLat, sections }
//   selection (while dragging), selectionend: { start, end, ascent, descent }
//   hoverend, selectionclear: no data
// A click that clears a selection fires selectionclear, not click.
// showHoverAt/hideHover/setSelection/clearSelection fire no events and use the same unit.
// showHoverAt/setSelection have no effect while the container is not rendered (not in the
// DOM or display: none), since the badge can't be measured then.
//
// Needs the elevation profile CSS.

export type UnitSystemName = "metric" | "imperial";

export interface ElevationProfileOptions {
  /** "metric" (default) or "imperial". */
  units: UnitSystemName;
  /**
   * Badge labels for section values, keyed "<section id>.<value>" (raw values from the data).
   * Merged with the defaults, so single entries can be overridden.
   */
  locale: Record<string, string>;
}

export const defaultElevationProfileOptions: ElevationProfileOptions = {
  units: "metric",
  locale: {
    "surface.asphalt": "Asphalt",
    "surface.paved": "Paved",
    "surface.unpaved": "Unpaved",
    "surface.natural": "Natural",
    "surface.alpine": "Alpine",
    "surface.other": "Other",
    "highway.primary": "Primary",
    "highway.street": "Street",
    "highway.road": "Road",
    "highway.motorway": "Motorway",
    "highway.cycleway": "Cycleway",
    "highway.pedestrian": "Pedestrian",
    "highway.path": "Path",
    "highway.hiking": "Hiking",
    "highway.mountain_hiking": "Mountain Hiking",
    "highway.other": "Other",
  },
};

type Position = number[];

export interface SectionValueInput {
  from?: number;
  to?: number;
  value?: string;
}

export interface SectionInput {
  id: string;
  values: SectionValueInput[];
}

export interface ElevationProfileFeature {
  type?: "Feature";
  geometry: { type: "LineString"; coordinates: Position[] } | { type: "MultiLineString"; coordinates: Position[][] };
  properties?: {
    length?: number;
    // Flat for LineString, one array per part for MultiLineString.
    sections?: SectionInput[] | SectionInput[][];
    [key: string]: unknown;
  } | null;
}

/** A point on the profile, distance and elevation in meters (feet for imperial). */
export interface ElevationProfilePoint {
  distance: number;
  /** Nearest sample, like the badge. */
  elevation: number;
  /** Interpolated on the line. */
  lngLat: [number, number];
  /** Raw value per section id, "other" if uncovered. */
  sections: Record<string, string>;
}

/** Selected range in meters (feet for imperial), start <= end. */
export interface ElevationProfileSelection {
  start: number;
  end: number;
  ascent: number;
  descent: number;
}

export interface ElevationProfileEventMap {
  hover: ElevationProfilePoint;
  hoverend: Record<never, never>;
  click: ElevationProfilePoint;
  selection: ElevationProfileSelection;
  selectionend: ElevationProfileSelection;
  selectionclear: Record<never, never>;
}

export type ElevationProfileEventType = keyof ElevationProfileEventMap;

export type ElevationProfileEvent<T extends ElevationProfileEventType = ElevationProfileEventType> = ElevationProfileEventMap[T] & {
  type: T;
  target: ElevationProfile;
  originalEvent: MouseEvent;
};

export type ElevationProfileListener<T extends ElevationProfileEventType> = (event: ElevationProfileEvent<T>) => void;

type Listeners = { [T in ElevationProfileEventType]?: ElevationProfileListener<T>[] };

interface UnitSystem {
  elevation: { factor: number; unit: string };
  distance: { factor: number; unit: string };
}

interface Profile {
  samples: number[];
  distances: number[];
  // [lng, lat] per sample.
  coordinates: Position[];
  distance: number;
}

// A stretch of a section in meters.
interface SectionRun {
  from: number;
  to: number;
  value: string;
}

interface Section {
  id: string;
  runs: SectionRun[];
}

interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface SvgMeta {
  margin: Margin;
  plotW: number;
  plotH: number;
  safeDistance: number;
  distances: number[];
  samples: number[];
  coordinates: Position[];
  yTicks: { min: number; max: number };
  sections: Section[];
  badge: Badge;
}

interface Badge {
  right: number;
  top: number;
  padX: number;
  padY: number;
  radius: number;
  fontSize: number;
  lineHeight: number;
  dotRadius: number;
  dotGap: number;
}

interface Ticks {
  min: number;
  max: number;
  ticks: number[];
}

// In meters, follows the mouse.
interface Selection {
  start: number;
  end: number;
}

// Created by setupInteraction(), used by the public methods.
interface Interaction {
  showHover(meter: number): void;
  hideHover(): void;
  setSelection(selection: Selection): { ascent: number; descent: number };
  clearSelection(): void;
}

export class ElevationProfile {
  // Input is always meters; conversion happens on output only.
  // elevation.factor also converts lengths in events and public methods (m or ft).
  private static readonly UNIT_SYSTEMS: Record<UnitSystemName, UnitSystem> = {
    metric: { elevation: { factor: 1, unit: "m" }, distance: { factor: 1 / 1000, unit: "km" } },
    imperial: { elevation: { factor: 1 / 0.3048, unit: "ft" }, distance: { factor: 1 / 1609.344, unit: "mi" } },
  };

  // Same value as enhance/lib/utils.js distanceFromTo().
  private static readonly EARTH_RADIUS = 6378730;

  // Unique clip path IDs for multiple profiles per page.
  private static instanceCount = 0;

  private readonly container: HTMLElement;
  private readonly unit: UnitSystem;
  private readonly locale: Record<string, string>;
  private readonly clipId: string;

  // Drag selection stays visible until a new drag or a plain click.
  private selection: Selection | null = null;
  // True from mousedown to mouseup, keeps the hover point hidden meanwhile.
  private dragActive = false;
  // True while the hover point is shown by the mouse, so hoverend fires once.
  private hovering = false;
  private interaction: Interaction | null = null;
  private listeners: Listeners = {};
  private onceListeners: Listeners = {};

  // container: element or element id to render into. It may be added to the DOM later.
  constructor(container: HTMLElement | string, options: Partial<ElevationProfileOptions> = {}) {
    const element = typeof container === "string" ? document.getElementById(container) : container;
    if (!element) throw new Error(`Element #${container} nicht gefunden.`);
    this.container = element;
    // Scopes the styles in style.css.
    this.container.classList.add("maptoolkit-elevation-profile");
    const { units } = { ...defaultElevationProfileOptions, ...options };
    const locale = { ...defaultElevationProfileOptions.locale, ...options.locale };
    const unit = ElevationProfile.UNIT_SYSTEMS[units];
    if (!unit) throw new Error(`Unbekanntes Masssystem "${units}".`);
    this.unit = unit;
    this.locale = locale;
    this.clipId = `elevationClip-${++ElevationProfile.instanceCount}`;
  }

  // Renders a 3D GeoJSON Feature, replacing previous content.
  render(feature: ElevationProfileFeature): void {
    const { profile, sections } = ElevationProfile.profileFromFeature(feature);
    const { svg, meta } = this.buildSvg(profile, sections);
    this.container.innerHTML = svg;
    this.selection = null;
    this.dragActive = false;
    this.hovering = false;
    this.interaction = this.setupInteraction(this.container.querySelector<SVGSVGElement>("svg")!, meta);
  }

  on<T extends ElevationProfileEventType>(type: T, listener: ElevationProfileListener<T>): this {
    const list: ElevationProfileListener<T>[] = this.listeners[type] ?? [];
    list.push(listener);
    this.listeners[type] = list as Listeners[T];
    return this;
  }

  off<T extends ElevationProfileEventType>(type: T, listener: ElevationProfileListener<T>): this {
    for (const listeners of [this.listeners, this.onceListeners]) {
      const list = listeners[type];
      if (list) listeners[type] = list.filter((l) => l !== listener) as Listeners[T];
    }
    return this;
  }

  once<T extends ElevationProfileEventType>(type: T, listener: ElevationProfileListener<T>): this {
    const list: ElevationProfileListener<T>[] = this.onceListeners[type] ?? [];
    list.push(listener);
    this.onceListeners[type] = list as Listeners[T];
    return this;
  }

  private fire<T extends ElevationProfileEventType>(type: T, data: ElevationProfileEventMap[T], originalEvent: MouseEvent): void {
    const event = { ...data, type, target: this, originalEvent } as ElevationProfileEvent<T>;
    const listeners = [...(this.listeners[type] ?? []), ...(this.onceListeners[type] ?? [])];
    delete this.onceListeners[type];
    listeners.forEach((listener) => listener(event));
  }

  /** Shows the hover point at a distance in meters (feet for imperial). Ignored while a selection exists or not rendered. */
  showHoverAt(distance: number): void {
    if (!this.isRendered()) return;
    this.interaction?.showHover(distance / this.unit.elevation.factor);
  }

  hideHover(): void {
    this.interaction?.hideHover();
  }

  /**
   * Selects a range in meters (feet for imperial, any order) and returns its ascent/descent.
   * No effect and null before render() or while not rendered.
   */
  setSelection(start: number, end: number): { ascent: number; descent: number } | null {
    if (!this.isRendered()) return null;
    const factor = this.unit.elevation.factor;
    return this.interaction ? this.interaction.setSelection({ start: start / factor, end: end / factor }) : null;
  }

  clearSelection(): void {
    this.interaction?.clearSelection();
  }

  // False if the container is not in the DOM or hidden by display: none; getBBox() returns an empty box then.
  private isRendered(): boolean {
    return this.container.getClientRects().length > 0;
  }

  private formatElevation(meter: number): string {
    return `${Math.round(meter * this.unit.elevation.factor)} ${this.unit.elevation.unit}`;
  }

  // Section ids and values come from the data, so they are reduced to [A-Za-z0-9_-] for class names.
  private static cssName(str: string): string {
    return String(str).replace(/[^A-Za-z0-9_-]/g, "-");
  }

  // Classes of a bar segment and its badge dot. Colors come from .section-<id>-<value> in the CSS.
  private static sectionValueClass(id: string, value: string): string {
    return `section-value section-${ElevationProfile.cssName(id)}-${ElevationProfile.cssName(value)}`;
  }

  // "Nice numbers" axis ticks (Heckbert).
  private static niceNumber(range: number, round: boolean): number {
    const exponent = Math.floor(Math.log10(range));
    const fraction = range / Math.pow(10, exponent);
    let niceFraction: number;
    if (round) {
      niceFraction = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
    } else {
      niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    }
    return niceFraction * Math.pow(10, exponent);
  }

  private static calcTicks(min: number, max: number, targetCount: number): Ticks {
    if (max <= min) max = min + 1;
    const range = ElevationProfile.niceNumber(max - min, false);
    const step = ElevationProfile.niceNumber(range / Math.max(1, targetCount - 1), true);
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
    return { min: niceMin, max: niceMax, ticks };
  }

  // Distance in meters, same formula as enhance/lib/utils.js distanceFromTo().
  private static distanceFromTo(p1: Position, p2: Position): number {
    const rad = Math.PI / 180;
    const lat1 = p1[1] * rad,
      lat2 = p2[1] * rad;
    const a = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos((p2[0] - p1[0]) * rad);
    return ElevationProfile.EARTH_RADIUS * Math.acos(Math.min(a, 1));
  }

  // Returns samples, cumulative distances and sections (runs in meters).
  // Distances are scaled to properties.length if given.
  private static profileFromFeature(feature: ElevationProfileFeature): { profile: Profile; sections: Section[] } {
    const geometry = (feature && feature.geometry) || {};
    const properties = (feature && feature.properties) || {};
    let lines: Position[][];
    if (geometry.type === "LineString") lines = [geometry.coordinates || []];
    else if (geometry.type === "MultiLineString") lines = geometry.coordinates || [];
    else throw new Error(`Nicht unterstützter Geometrie-Typ "${(geometry as { type?: string }).type}".`);
    const samples: number[] = [];
    const coordinates: Position[] = [];
    let distances: number[] = [];
    let distance = 0;
    // Start/end distance of each part, for part-relative section runs.
    const parts: { start: number; end: number }[] = [];
    lines.forEach((line) => {
      const start = distance;
      line.forEach((c, i) => {
        if (typeof c[2] !== "number") throw new Error(`Koordinate ${samples.length} hat keinen Höhenwert.`);
        if (i > 0) distance += ElevationProfile.distanceFromTo(line[i - 1], c);
        samples.push(c[2]);
        coordinates.push([c[0], c[1]]);
        distances.push(distance);
      });
      parts.push({ start, end: distance });
    });
    const length = properties.length;
    if (typeof length === "number" && length > 0) {
      const scale = distance > 0 ? length / distance : 0;
      distances = distances.map((d) => d * scale);
      parts.forEach((part) => {
        part.start *= scale;
        part.end *= scale;
      });
      distance = length;
    }
    // Sections per part (one part for a LineString), joined by id in order of first appearance.
    const input = properties.sections || [];
    const sectionParts = (geometry.type === "MultiLineString" ? input : [input]) as SectionInput[][];
    const sectionsById = new Map<string, SectionRun[]>();
    sectionParts.forEach((partSections, i) => {
      const part = parts[i];
      if (!part || !Array.isArray(partSections)) return;
      const partLength = part.end - part.start;
      partSections.forEach((section) => {
        if (!section || !section.id || !Array.isArray(section.values) || !section.values.length) return;
        const runs = sectionsById.get(section.id) || [];
        section.values.forEach((run) =>
          runs.push({
            from: part.start + (run.from || 0) * partLength,
            to: part.start + (run.to || 0) * partLength,
            value: run.value || "other",
          }),
        );
        sectionsById.set(section.id, runs);
      });
    });
    const sections = Array.from(sectionsById, ([id, runs]) => ({ id, runs }));
    return { profile: { samples, distances, coordinates, distance }, sections };
  }

  // Section value at a distance, "other" if none.
  private static valueAt(runs: SectionRun[], meter: number): string {
    const run = runs.find((r) => meter >= r.from && meter <= r.to);
    return (run && run.value) || "other";
  }

  private buildSvg(profile: Profile, sections: Section[]): { svg: string; meta: SvgMeta } {
    const unit = this.unit;
    // Hover line and selection are clipped to the area under the curve.
    const clipId = this.clipId;
    const { samples, distances, distance } = profile;
    if (!samples.length) throw new Error("Keine Höhen-Samples in der Antwort gefunden.");

    const width = 900,
      height = 320;
    const sectionBar = { height: 10, gap: 4, segmentGap: 2 };
    // One bar per section below the plot, in data order.
    // The plot grows or shrinks by the bars' height, the x labels stay in place.
    const barCount = sections.length;
    const barsHeight = barCount * (sectionBar.gap + sectionBar.height);
    const margin: Margin = { top: 16, right: 20, bottom: 40 + (barCount - 1) * (sectionBar.gap + sectionBar.height), left: 70 };
    // Hover badge, top right in the plot. Sizes in viewBox units, font-size must match the CSS.
    const badge: Badge = {
      right: width - margin.right - 8,
      top: margin.top + 8,
      padX: 10,
      padY: 4,
      radius: 6,
      fontSize: 18,
      lineHeight: 27,
      dotRadius: 8,
      dotGap: 4,
    };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    const elevMin = Math.min(...samples);
    const elevMax = Math.max(...samples);
    const pad = Math.max(10, (elevMax - elevMin) * 0.1);
    // Ticks in display units, scale (yTicks) in meters.
    const elevFactor = unit.elevation.factor;
    const yTicksDisplay = ElevationProfile.calcTicks((elevMin - pad) * elevFactor, (elevMax + pad) * elevFactor, Math.max(2, Math.round(plotH / 45)));
    const yTicks = { min: yTicksDisplay.min / elevFactor, max: yTicksDisplay.max / elevFactor };

    const distFactor = unit.distance.factor;
    const totalDisplay = Math.max(distance * distFactor, 0.001);
    const xTicks = ElevationProfile.calcTicks(0, totalDisplay, Math.max(2, Math.round(plotW / 100)));

    const safeDistance = distance || 1;
    const x = (m: number) => margin.left + (m / safeDistance) * plotW;
    const y = (e: number) => margin.top + plotH - ((e - yTicks.min) / (yTicks.max - yTicks.min)) * plotH;

    const linePoints = samples.map((s, i) => `${x(distances[i]).toFixed(1)},${y(s).toFixed(1)}`);
    const areaPath =
      `M${x(0).toFixed(1)},${(margin.top + plotH).toFixed(1)} ` +
      `L${linePoints.join(" L")} ` +
      `L${x(distance).toFixed(1)},${(margin.top + plotH).toFixed(1)} Z`;
    const linePath = `M${linePoints.join(" L")}`;

    // Start, end and highest point with elevation label, each in a
    // <g class="marker-start|marker-end|marker-max"> for separate styling.
    // The highest point is skipped if it is too close to start or end, so the labels don't overlap.
    const lastIdx = samples.length - 1;
    const maxIdx = samples.indexOf(elevMax);
    const minMarkerDist = 90;
    const maxNearEdge = [0, lastIdx].some((i) => Math.abs(x(distances[i]) - x(distances[maxIdx])) < minMarkerDist);
    const markerPoints = [
      { idx: 0, kind: "start" },
      ...(lastIdx > 0 ? [{ idx: lastIdx, kind: "end" }] : []),
      ...(maxNearEdge ? [] : [{ idx: maxIdx, kind: "max" }]),
    ];
    const markerR = 4,
      markerLabelGap = 6,
      markerFontSize = 16;
    const markers = markerPoints
      .map(({ idx: i, kind }) => {
        const mx = x(distances[i]);
        const my = y(samples[i]);
        // Label above the point, below if it would leave the viewBox.
        const above = my - markerR - markerLabelGap - markerFontSize >= 0;
        const ly = above ? my - markerR - markerLabelGap : my + markerR + markerLabelGap;
        // Keep labels near the edges inside the plot.
        const anchor = mx < margin.left + 30 ? "start" : mx > width - margin.right - 30 ? "end" : "middle";
        return `<g class="marker-${kind}">
    <circle class="marker" cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="${markerR}" />
    <text class="marker-label" x="${mx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="${above ? "auto" : "hanging"}">${this.formatElevation(samples[i])}</text>
  </g>`;
      })
      .join("\n");

    // Section bar: one rect per segment with a small gap in between. Uncovered
    // stretches become "other", touching segments of the same type are merged.
    // Segments not wider than the gap are dropped, they would only leave an empty gap.
    const barRects = (runs: SectionRun[], barY: number, classFor: (value: string) => string): string => {
      const rawSegments: SectionRun[] = [];
      const pushSegment = (from: number, to: number, value: string) => rawSegments.push({ from, to, value });
      let covered = 0;
      (runs || [])
        .map((run) => ({ ...run, from: Math.max(0, Math.min(distance, run.from)), to: Math.max(0, Math.min(distance, run.to)) }))
        .filter((run) => run.to > run.from)
        .sort((a, b) => a.from - b.from)
        .forEach((run) => {
          if (run.from > covered) pushSegment(covered, run.from, "other");
          if (run.to > covered) pushSegment(Math.max(covered, run.from), run.to, run.value);
          covered = Math.max(covered, run.to);
        });
      if (covered < distance || !rawSegments.length) pushSegment(covered, distance, "other");
      const segments: SectionRun[] = [];
      rawSegments
        .filter((seg, _i, all) => all.length === 1 || x(seg.to) - x(seg.from) > sectionBar.segmentGap)
        .forEach((seg) => {
          const last = segments[segments.length - 1];
          if (last && last.value === seg.value) last.to = seg.to;
          else segments.push({ ...seg });
        });
      return segments
        .map((seg, i) => {
          const x1 = x(seg.from) + (i > 0 ? sectionBar.segmentGap / 2 : 0);
          const x2 = x(seg.to) - (i < segments.length - 1 ? sectionBar.segmentGap / 2 : 0);
          if (x2 <= x1) return "";
          return `<rect x="${x1.toFixed(1)}" y="${barY}" width="${(x2 - x1).toFixed(1)}" height="${sectionBar.height}" class="${classFor(seg.value)}" />`;
        })
        .join("\n");
    };
    const sectionBars = sections
      .map((section, i) => {
        const barY = margin.top + plotH + sectionBar.gap + i * (sectionBar.height + sectionBar.gap);
        const rects = barRects(section.runs, barY, (value) => ElevationProfile.sectionValueClass(section.id, value));
        return `<g class="section section-${ElevationProfile.cssName(section.id)}">\n${rects}\n  </g>`;
      })
      .join("\n");

    const gridLinesY = yTicksDisplay.ticks
      .filter((t) => t >= yTicksDisplay.min && t <= yTicksDisplay.max)
      .map((t, i) => {
        const yy = y(t / elevFactor).toFixed(1);
        // The lowest line is the x axis.
        return `<line class="grid-line grid-line-y${i === 0 ? " axis-line axis-line-x" : ""}" x1="${margin.left}" x2="${width - margin.right}" y1="${yy}" y2="${yy}" />
          <text class="axis-label axis-label-y" x="${margin.left - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${Math.round(t)} ${unit.elevation.unit}</text>`;
      })
      .join("\n");

    const gridLinesX = xTicks.ticks
      .filter((t) => t >= 0 && t <= totalDisplay + 1e-6)
      .map((t, i) => {
        const xx = x(t / distFactor).toFixed(1);
        // The line at 0 is the y axis.
        return `<line class="grid-line grid-line-x${i === 0 ? " axis-line axis-line-y" : ""}" x1="${xx}" x2="${xx}" y1="${margin.top}" y2="${margin.top + plotH}" />
          <text class="axis-label axis-label-x" x="${xx}" y="${margin.top + plotH + barsHeight + 7}" text-anchor="middle" dominant-baseline="hanging">${t} ${unit.distance.unit}</text>`;
      })
      .join("\n");

    // Badge lines: elevation plus one per section, at least two for the selection.
    const badgeLineCount = Math.max(2, 1 + sections.length);
    const badgeTspans = Array.from({ length: badgeLineCount }, (_, i) =>
      i === 0
        ? `<tspan x="${badge.right - badge.padX}" y="${badge.top + badge.padY + badge.fontSize}"></tspan>`
        : `<tspan x="${badge.right - badge.padX}" dy="${badge.lineHeight}"></tspan>`,
    ).join("");
    const badgeDots = Array.from({ length: badgeLineCount }, () => `<circle class="hover-badge-dot" r="${badge.dotRadius}" />`).join("\n    ");

    const svg = `
<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="${clipId}">
      <path d="${areaPath}" />
    </clipPath>
  </defs>
  ${gridLinesY}
  ${gridLinesX}
  <path class="area" d="${areaPath}" />
  <path class="line" d="${linePath}" />
  ${sectionBars}
  ${markers}
  <rect class="selection-rect" y="${margin.top}" height="${plotH}" clip-path="url(#${clipId})" />
  <line class="hover-line" x1="0" x2="0" y1="${margin.top}" y2="${margin.top + plotH}" clip-path="url(#${clipId})" />
  <circle class="hover-dot" r="4" />
  <rect class="hover-capture" x="${margin.left}" y="${margin.top}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor: default;" />
  <g class="hover-badge">
    <rect class="hover-badge-bg" rx="${badge.radius}" />
    <!-- No whitespace between the tspans, it would add a trailing space to a line and shift it left. -->
    <text class="hover-badge-text" text-anchor="end">${badgeTspans}</text>
    ${badgeDots}
  </g>
</svg>`;

    // Needed by setupInteraction() to map mouse position to samples.
    const { coordinates } = profile;
    return { svg, meta: { margin, plotW, plotH, safeDistance, distances, samples, coordinates, yTicks, sections, badge } };
  }

  // Binary search for the sample closest to "meter".
  private static nearestSampleIndex(distances: number[], meter: number): number {
    let lo = 0,
      hi = distances.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (distances[mid] < meter) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(distances[lo - 1] - meter) < Math.abs(distances[lo] - meter)) return lo - 1;
    return lo;
  }

  // Sample index at or after "meter" and the fraction t from the previous sample, for linear interpolation.
  private static interpolationAt(distances: number[], meter: number): { hi: number; t: number } {
    // Binary search for the first sample at or after "meter".
    let lo = 0,
      hi = distances.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (distances[mid] < meter) lo = mid + 1;
      else hi = mid;
    }
    if (hi === 0) return { hi, t: 1 };
    const span = distances[hi] - distances[hi - 1];
    return { hi, t: span > 0 ? (meter - distances[hi - 1]) / span : 1 };
  }

  // Elevation on the drawn line at "meter", linear between neighboring samples.
  private static interpolateElevation(distances: number[], samples: number[], meter: number): number {
    const { hi, t } = ElevationProfile.interpolationAt(distances, meter);
    if (hi === 0) return samples[0];
    return samples[hi - 1] + (samples[hi] - samples[hi - 1]) * t;
  }

  // [lng, lat] on the line at "meter". Across MultiLineString part gaps it jumps to the next part.
  private static interpolateLngLat(distances: number[], coordinates: Position[], meter: number): [number, number] {
    const { hi, t } = ElevationProfile.interpolationAt(distances, meter);
    const b = coordinates[hi];
    if (hi === 0) return [b[0], b[1]];
    const a = coordinates[hi - 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  // Raw ascent/descent between two sample indices.
  private static ascentDescentBetween(samples: number[], idxA: number, idxB: number): { ascent: number; descent: number } {
    const lo = Math.min(idxA, idxB),
      hi = Math.max(idxA, idxB);
    let ascent = 0,
      descent = 0;
    for (let i = lo + 1; i <= hi; i++) {
      const diff = samples[i] - samples[i - 1];
      if (diff > 0) ascent += diff;
      else descent -= diff;
    }
    return { ascent, descent };
  }

  private setupInteraction(svgEl: SVGSVGElement, meta: SvgMeta): Interaction {
    const { margin, plotW, plotH, safeDistance, distances, samples, coordinates, yTicks, sections, badge } = meta;
    const capture = svgEl.querySelector<SVGRectElement>(".hover-capture")!;
    const hoverLine = svgEl.querySelector<SVGLineElement>(".hover-line")!;
    const hoverDot = svgEl.querySelector<SVGCircleElement>(".hover-dot")!;
    const selectionRect = svgEl.querySelector<SVGRectElement>(".selection-rect")!;
    const badgeEl = svgEl.querySelector<SVGGElement>(".hover-badge")!;
    const badgeBg = badgeEl.querySelector<SVGRectElement>(".hover-badge-bg")!;
    const badgeText = badgeEl.querySelector<SVGTextElement>(".hover-badge-text")!;
    const badgeLines = Array.from(badgeText.querySelectorAll<SVGTSpanElement>("tspan"));
    const badgeDots = Array.from(badgeEl.querySelectorAll<SVGCircleElement>(".hover-badge-dot"));
    const nearestSampleIndex = ElevationProfile.nearestSampleIndex;

    // Right-aligned lines (one tspan each), each with an optional colored dot after the text.
    // The background is sized to the measured text, so the badge must be visible first.
    const showBadge = (lines: { text: string; dotClass?: string }[]) => {
      const textRight = badge.right - badge.padX;
      badgeLines.forEach((tspan, i) => {
        const line = lines[i];
        tspan.textContent = line ? line.text : "";
        // With a dot, the text ends before it; the dot is right-aligned with the other lines.
        tspan.setAttribute("x", String(line?.dotClass ? textRight - 2 * badge.dotRadius - badge.dotGap : textRight));
        const dot = badgeDots[i];
        if (line?.dotClass) {
          dot.setAttribute("class", `hover-badge-dot ${line.dotClass}`);
          dot.setAttribute("cx", String(textRight - badge.dotRadius));
          dot.setAttribute("cy", String(badge.top + badge.padY + badge.fontSize + i * badge.lineHeight - badge.fontSize * 0.35));
        }
        dot.style.display = line?.dotClass ? "block" : "none";
      });
      badgeEl.style.display = "block";
      let left = textRight;
      let top = badge.top + badge.padY;
      let bottom = top + lines.length * badge.lineHeight;
      try {
        const box = badgeText.getBBox();
        left = box.x;
        top = box.y;
        bottom = box.y + box.height;
      } catch {
        // No layout (e.g. jsdom): keep the fallback size.
      }
      badgeBg.setAttribute("x", String(left - badge.padX));
      badgeBg.setAttribute("y", String(top - badge.padY));
      badgeBg.setAttribute("width", String(badge.right - (left - badge.padX)));
      badgeBg.setAttribute("height", String(bottom - top + 2 * badge.padY));
    };

    const meterAt = (evt: MouseEvent): number => {
      const pt = svgEl.createSVGPoint();
      pt.x = evt.clientX;
      pt.y = evt.clientY;
      const ctm = svgEl.getScreenCTM();
      const loc = ctm ? pt.matrixTransform(ctm.inverse()) : pt;
      return Math.min(safeDistance, Math.max(0, ((loc.x - margin.left) / plotW) * safeDistance));
    };
    const pxAt = (meter: number) => margin.left + (meter / safeDistance) * plotW;

    const hideHoverPoint = () => {
      hoverLine.style.display = "none";
      hoverDot.style.display = "none";
    };

    const clampMeter = (meter: number) => Math.min(safeDistance, Math.max(0, meter));
    // Event and public method values in meters or feet.
    const lengthFactor = this.unit.elevation.factor;

    const pointAt = (meter: number): ElevationProfilePoint => {
      const values: Record<string, string> = {};
      sections.forEach((section) => (values[section.id] = ElevationProfile.valueAt(section.runs, meter)));
      return {
        distance: meter * lengthFactor,
        elevation: samples[nearestSampleIndex(distances, meter)] * lengthFactor,
        lngLat: ElevationProfile.interpolateLngLat(distances, coordinates, meter),
        sections: values,
      };
    };

    const showHoverPoint = (meter: number) => {
      // Line and dot follow the mouse, the badge shows the nearest sample.
      const elevation = samples[nearestSampleIndex(distances, meter)];
      const lineElevation = ElevationProfile.interpolateElevation(distances, samples, meter);
      const px = pxAt(meter);
      const py = margin.top + plotH - ((lineElevation - yTicks.min) / (yTicks.max - yTicks.min)) * plotH;
      hoverLine.setAttribute("x1", String(px));
      hoverLine.setAttribute("x2", String(px));
      hoverLine.style.display = "block";
      hoverDot.setAttribute("cx", String(px));
      hoverDot.setAttribute("cy", String(py));
      hoverDot.style.display = "block";
      const lines: { text: string; dotClass?: string }[] = [{ text: this.formatElevation(elevation) }];
      sections.forEach((section) => {
        const value = ElevationProfile.valueAt(section.runs, meter);
        const text = this.locale[`${section.id}.${value}`] ?? value;
        lines.push({ text, dotClass: ElevationProfile.sectionValueClass(section.id, value) });
      });
      showBadge(lines);
    };

    const renderSelection = (selection: Selection): ElevationProfileSelection => {
      const x1 = pxAt(Math.min(selection.start, selection.end));
      const x2 = pxAt(Math.max(selection.start, selection.end));
      selectionRect.setAttribute("x", String(x1));
      selectionRect.setAttribute("width", String(Math.max(0, x2 - x1)));
      selectionRect.style.display = "block";

      // Ascent/descent from the nearest samples, like the hover badge.
      const { ascent, descent } = ElevationProfile.ascentDescentBetween(
        samples,
        nearestSampleIndex(distances, selection.start),
        nearestSampleIndex(distances, selection.end),
      );
      showBadge([{ text: `+ ${this.formatElevation(ascent)}` }, { text: `- ${this.formatElevation(descent)}` }]);
      return {
        start: Math.min(selection.start, selection.end) * lengthFactor,
        end: Math.max(selection.start, selection.end) * lengthFactor,
        ascent: ascent * lengthFactor,
        descent: descent * lengthFactor,
      };
    };

    const clearSelection = () => {
      this.selection = null;
      selectionRect.style.display = "none";
      badgeEl.style.display = "none";
    };

    // Hides a mouse-driven hover point and fires hoverend once.
    const endHover = (evt: MouseEvent) => {
      if (!this.hovering) return;
      this.hovering = false;
      this.fire("hoverend", {}, evt);
    };

    capture.addEventListener("mousedown", (evt) => {
      if (evt.button !== 0) return;
      evt.preventDefault();
      this.dragActive = true;
      hideHoverPoint();
      endHover(evt);
      const startClientX = evt.clientX,
        startClientY = evt.clientY;
      const start = meterAt(evt);
      let dragging = false;

      const onMove = (moveEvt: MouseEvent) => {
        // Treat as drag only after a few pixels, so a click just clears.
        if (!dragging && Math.hypot(moveEvt.clientX - startClientX, moveEvt.clientY - startClientY) > 3) {
          dragging = true;
        }
        if (!dragging) return;
        this.selection = { start, end: meterAt(moveEvt) };
        this.fire("selection", renderSelection(this.selection), moveEvt);
      };
      const onUp = (upEvt: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        this.dragActive = false;
        if (dragging && this.selection) {
          this.fire("selectionend", renderSelection(this.selection), upEvt);
        } else if (this.selection) {
          clearSelection();
          this.fire("selectionclear", {}, upEvt);
        } else {
          // The hover point is hidden since mousedown, hide its badge too.
          badgeEl.style.display = "none";
          this.fire("click", pointAt(start), upEvt);
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });

    capture.addEventListener("mousemove", (evt) => {
      if (this.selection || this.dragActive) return;
      const meter = meterAt(evt);
      showHoverPoint(meter);
      this.hovering = true;
      this.fire("hover", pointAt(meter), evt);
    });

    capture.addEventListener("mouseleave", (evt) => {
      if (!this.selection && !this.dragActive) {
        hideHoverPoint();
        badgeEl.style.display = "none";
        endHover(evt);
      }
    });

    // Programmatic counterparts, they fire no events.
    return {
      showHover: (meter) => {
        if (this.selection || this.dragActive) return;
        showHoverPoint(clampMeter(meter));
      },
      hideHover: () => {
        this.hovering = false;
        hideHoverPoint();
        if (!this.selection) badgeEl.style.display = "none";
      },
      setSelection: (selection) => {
        this.hovering = false;
        hideHoverPoint();
        this.selection = { start: clampMeter(selection.start), end: clampMeter(selection.end) };
        const { ascent, descent } = renderSelection(this.selection);
        return { ascent, descent };
      },
      clearSelection: () => {
        if (this.selection) clearSelection();
      },
    };
  }
}
