import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  ElevationProfile,
  type ElevationProfileEventType,
  type ElevationProfileFeature,
  type ElevationProfileListener,
  type ElevationProfileOptions,
} from "../src/ElevationProfile";

// jsdom has no SVG layout. With an identity screen CTM, clientX equals the viewBox x,
// so the plot (viewBox 900 wide, margin left 70 / right 20) spans clientX 70..880.
const PLOT_LEFT = 70;
const PLOT_WIDTH = 810;
const FT = 0.3048;

type SvgProto = { createSVGPoint?: unknown; getScreenCTM?: unknown };

// jsdom always returns no client rects. Like a browser: none if detached or inside display: none.
const originalGetClientRects = Element.prototype.getClientRects;
const hidden = (el: Element | null): boolean => !!el && ((el as HTMLElement).style?.display === "none" || hidden(el.parentElement));
function getClientRects(this: Element) {
  const rendered = this.isConnected && !hidden(this);
  return (rendered ? [new DOMRect(0, 0, 900, 320)] : []) as unknown as DOMRectList;
}

beforeAll(() => {
  Element.prototype.getClientRects = getClientRects;
  const proto = SVGSVGElement.prototype as unknown as SvgProto;
  proto.createSVGPoint = () => ({
    x: 0,
    y: 0,
    matrixTransform() {
      return this;
    },
  });
  proto.getScreenCTM = () => ({
    inverse() {
      return this;
    },
  });
});

afterAll(() => {
  Element.prototype.getClientRects = originalGetClientRects;
  const proto = SVGSVGElement.prototype as unknown as SvgProto;
  delete proto.createSVGPoint;
  delete proto.getScreenCTM;
});

beforeEach(() => {
  document.body.innerHTML = '<div id="profile"></div>';
});

// Five samples on the equator, scaled to 1000 m: distances 0, 250, 500, 750, 1000.
// Elevations 100, 150, 120, 180, 160: total ascent 110, descent 50.
const coordinates = [
  [0, 0, 100],
  [0.1, 0, 150],
  [0.2, 0, 120],
  [0.3, 0, 180],
  [0.4, 0, 160],
];

function lineFeature(properties: ElevationProfileFeature["properties"] = {}): ElevationProfileFeature {
  return { type: "Feature", geometry: { type: "LineString", coordinates }, properties: { length: 1000, ...properties } };
}

function create(options: Partial<ElevationProfileOptions> = {}, feature = lineFeature()): ElevationProfile {
  const profile = new ElevationProfile("profile", options);
  profile.render(feature);
  return profile;
}

const $ = <T extends Element = SVGElement>(selector: string) => document.querySelector<T>(`#profile ${selector}`)!;
const $$ = <T extends Element = SVGElement>(selector: string) => Array.from(document.querySelectorAll<T>(`#profile ${selector}`));
const texts = (selector: string) => $$(selector).map((el) => el.textContent);
const badgeLines = () => texts(".hover-badge-text tspan");

// clientX for a distance in meters on a 1000 m profile.
const clientX = (meter: number) => PLOT_LEFT + (meter / 1000) * PLOT_WIDTH;

function mouse(target: EventTarget, type: string, meter: number, clientY = 50): MouseEvent {
  const evt = new MouseEvent(type, { clientX: clientX(meter), clientY, button: 0, bubbles: true, cancelable: true });
  target.dispatchEvent(evt);
  return evt;
}

const hover = (meter: number) => mouse($(".hover-capture"), "mousemove", meter);

function click(meter: number) {
  mouse($(".hover-capture"), "mousedown", meter);
  mouse(window, "mouseup", meter);
}

function drag(from: number, to: number) {
  mouse($(".hover-capture"), "mousedown", from);
  mouse(window, "mousemove", to);
  mouse(window, "mouseup", to);
}

const ALL_EVENTS = ["hover", "hoverend", "click", "selection", "selectionend", "selectionclear"] as const;

function spyAll(profile: ElevationProfile) {
  const spy = <T extends ElevationProfileEventType>(type: T): Mock<ElevationProfileListener<T>> => {
    const listener = vi.fn<ElevationProfileListener<T>>();
    profile.on(type, listener);
    return listener;
  };
  return {
    hover: spy("hover"),
    hoverend: spy("hoverend"),
    click: spy("click"),
    selection: spy("selection"),
    selectionend: spy("selectionend"),
    selectionclear: spy("selectionclear"),
  };
}

describe("constructor", () => {
  it("adds the scope class to the container", () => {
    new ElevationProfile("profile");
    expect(document.getElementById("profile")!.classList.contains("maptoolkit-elevation-profile")).toBe(true);
  });

  it("throws for an unknown element", () => {
    expect(() => new ElevationProfile("missing")).toThrow(/#missing nicht gefunden/);
  });

  it("throws for unknown units", () => {
    expect(() => new ElevationProfile("profile", { units: "nautical" as never })).toThrow(/Masssystem "nautical"/);
  });

  it("accepts an element", () => {
    const element = document.getElementById("profile")!;
    new ElevationProfile(element).render(lineFeature());
    expect(element.classList.contains("maptoolkit-elevation-profile")).toBe(true);
    expect(element.querySelector("svg")).not.toBeNull();
  });
});

describe("not rendered container", () => {
  it("renders into a detached element that is added later", () => {
    const element = document.createElement("div");
    const profile = new ElevationProfile(element);
    profile.render(lineFeature());
    document.body.replaceChildren(element);
    element.id = "profile";
    expect(profile.setSelection(250, 750)).toEqual({ ascent: 60, descent: 30 });
    const listener = vi.fn();
    profile.on("hover", listener);
    profile.clearSelection();
    hover(300);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ignores showHoverAt and setSelection while detached", () => {
    const element = document.createElement("div");
    const profile = new ElevationProfile(element);
    profile.render(lineFeature());
    profile.showHoverAt(300);
    expect(element.querySelector<SVGLineElement>(".hover-line")!.style.display).not.toBe("block");
    expect(profile.setSelection(250, 750)).toBeNull();
    expect(element.querySelector<SVGRectElement>(".selection-rect")!.style.display).not.toBe("block");
  });

  it("ignores showHoverAt and setSelection inside display: none", () => {
    document.body.innerHTML = '<div style="display: none"><div id="profile"></div></div>';
    const profile = create();
    profile.showHoverAt(300);
    expect($<SVGLineElement>(".hover-line").style.display).not.toBe("block");
    expect(profile.setSelection(250, 750)).toBeNull();
    expect($<SVGRectElement>(".selection-rect").style.display).not.toBe("block");
  });

  it("keeps a selection made while visible and allows clearing it while hidden", () => {
    const profile = create();
    profile.setSelection(250, 750);
    const element = document.getElementById("profile")!;
    element.style.display = "none";
    expect($<SVGRectElement>(".selection-rect").style.display).toBe("block");
    profile.clearSelection();
    expect($<SVGRectElement>(".selection-rect").style.display).toBe("none");
  });
});

describe("render", () => {
  it("throws for unsupported geometry, missing elevation and empty lines", () => {
    const profile = new ElevationProfile("profile");
    expect(() => profile.render({ geometry: { type: "Point" } } as never)).toThrow(/Geometrie-Typ "Point"/);
    expect(() => profile.render({ geometry: { type: "LineString", coordinates: [[0, 0]] } })).toThrow(/keinen Höhenwert/);
    expect(() => profile.render({ geometry: { type: "LineString", coordinates: [] } })).toThrow(/Keine Höhen-Samples/);
  });

  it("renders metric axis labels", () => {
    create();
    expect(texts(".axis-label-y").every((t) => / m$/.test(t!))).toBe(true);
    expect(texts(".axis-label-x").every((t) => / km$/.test(t!))).toBe(true);
    expect(texts(".axis-label-x")[0]).toBe("0 km");
  });

  it("renders imperial axis labels", () => {
    create({ units: "imperial" });
    expect(texts(".axis-label-y").every((t) => / ft$/.test(t!))).toBe(true);
    expect(texts(".axis-label-x").every((t) => / mi$/.test(t!))).toBe(true);
  });

  it("renders start, end and max markers", () => {
    create();
    expect(texts(".marker-start .marker-label")).toEqual(["100 m"]);
    expect(texts(".marker-end .marker-label")).toEqual(["160 m"]);
    expect(texts(".marker-max .marker-label")).toEqual(["180 m"]);
  });

  it("skips the max marker next to start or end", () => {
    const coords = coordinates.map(([lng, lat], i) => [lng, lat, i === 4 ? 200 : 100]);
    create({}, { geometry: { type: "LineString", coordinates: coords }, properties: { length: 1000 } });
    expect($$(".marker-max")).toHaveLength(0);
    expect(texts(".marker-end .marker-label")).toEqual(["200 m"]);
  });

  it("replaces previous content", () => {
    const profile = create();
    profile.render(lineFeature());
    expect($$("svg")).toHaveLength(1);
  });

  it("uses a unique clip path per instance", () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>';
    new ElevationProfile("a").render(lineFeature());
    new ElevationProfile("b").render(lineFeature());
    const ids = Array.from(document.querySelectorAll("clipPath")).map((el) => el.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("sections", () => {
  const segmentClasses = (id: string) => $$(`.section-${id} rect`).map((el) => el.getAttribute("class"));

  it("renders one bar per section id", () => {
    create(
      {},
      lineFeature({
        sections: [
          { id: "surface", values: [{ from: 0, to: 1, value: "asphalt" }] },
          { id: "highway", values: [{ from: 0, to: 1, value: "path" }] },
        ],
      }),
    );
    expect($$(".section")).toHaveLength(2);
    expect(segmentClasses("surface")).toEqual(["section-value section-surface-asphalt"]);
    expect(segmentClasses("highway")).toEqual(["section-value section-highway-path"]);
  });

  it("fills gaps with other", () => {
    create(
      {},
      lineFeature({
        sections: [
          {
            id: "surface",
            values: [
              { from: 0, to: 0.4, value: "asphalt" },
              { from: 0.6, to: 1, value: "asphalt" },
            ],
          },
        ],
      }),
    );
    expect(segmentClasses("surface")).toEqual([
      "section-value section-surface-asphalt",
      "section-value section-surface-other",
      "section-value section-surface-asphalt",
    ]);
  });

  it("merges touching segments with the same value", () => {
    create(
      {},
      lineFeature({
        sections: [
          {
            id: "surface",
            values: [
              { from: 0, to: 0.3, value: "asphalt" },
              { from: 0.3, to: 0.5, value: "asphalt" },
              { from: 0.5, to: 1, value: "gravel" },
            ],
          },
        ],
      }),
    );
    expect(segmentClasses("surface")).toEqual(["section-value section-surface-asphalt", "section-value section-surface-gravel"]);
  });

  it("maps ids and values to CSS-safe class names", () => {
    create({}, lineFeature({ sections: [{ id: "road type", values: [{ from: 0, to: 1, value: "a/b" }] }] }));
    expect($$(".section-road-type")).toHaveLength(1);
    expect(segmentClasses("road-type")).toEqual(["section-value section-road-type-a-b"]);
  });

  it("joins MultiLineString parts by id, relative to each part", () => {
    // Two parts of equal length: 0..500 m and 500..1000 m.
    const profile = create(
      {},
      {
        geometry: {
          type: "MultiLineString",
          coordinates: [
            [
              [0, 0, 100],
              [0.2, 0, 110],
            ],
            [
              [1, 0, 120],
              [1.2, 0, 130],
            ],
          ],
        },
        properties: {
          length: 1000,
          sections: [
            [{ id: "surface", values: [{ from: 0, to: 1, value: "asphalt" }] }],
            [{ id: "surface", values: [{ from: 0.5, to: 1, value: "gravel" }] }],
          ] as never,
        },
      },
    );
    expect($$(".section")).toHaveLength(1);
    expect(segmentClasses("surface")).toEqual([
      "section-value section-surface-asphalt",
      "section-value section-surface-other",
      "section-value section-surface-gravel",
    ]);
    const values: string[] = [];
    profile.on("hover", (e) => values.push(e.sections.surface));
    [400, 600, 900].forEach(hover);
    expect(values).toEqual(["asphalt", "other", "gravel"]);
  });
});

describe("hover badge", () => {
  const sectioned = () =>
    lineFeature({
      sections: [
        {
          id: "surface",
          values: [
            { from: 0, to: 0.5, value: "asphalt" },
            { from: 0.5, to: 1, value: "gravel" },
          ],
        },
      ],
    });

  it("shows the nearest elevation and locale labels", () => {
    const profile = create({ locale: { "surface.gravel": "Schotter" } }, sectioned());
    profile.showHoverAt(300);
    expect(badgeLines()).toEqual(["150 m", "Asphalt"]);
    profile.showHoverAt(800);
    expect(badgeLines()).toEqual(["180 m", "Schotter"]);
  });

  it("shows raw values without a locale entry", () => {
    const profile = create({}, sectioned());
    profile.showHoverAt(800);
    expect(badgeLines()).toEqual(["180 m", "gravel"]);
  });

  it("shows a dot with section classes for section lines only", () => {
    const profile = create({}, sectioned());
    profile.showHoverAt(300);
    const dots = $$<SVGCircleElement>(".hover-badge-dot");
    expect(dots[0].style.display).toBe("none");
    expect(dots[1].style.display).toBe("block");
    expect(dots[1].getAttribute("class")).toBe("hover-badge-dot section-value section-surface-asphalt");
  });

  it("shows ascent and descent for a selection", () => {
    const profile = create();
    profile.setSelection(250, 750);
    expect(badgeLines()).toEqual(["+ 60 m", "- 30 m"]);
  });
});

describe("events", () => {
  it("fires hover with distance, nearest elevation, interpolated lngLat and sections", () => {
    const profile = create({}, lineFeature({ sections: [{ id: "surface", values: [{ from: 0, to: 1, value: "asphalt" }] }] }));
    const listener = vi.fn();
    profile.on("hover", listener);
    const evt = hover(300);
    const e = listener.mock.calls[0][0];
    expect(e.type).toBe("hover");
    expect(e.target).toBe(profile);
    expect(e.originalEvent).toBe(evt);
    expect(e.distance).toBeCloseTo(300, 6);
    expect(e.elevation).toBe(150);
    expect(e.lngLat[0]).toBeCloseTo(0.12, 6);
    expect(e.lngLat[1]).toBeCloseTo(0, 6);
    expect(e.sections).toEqual({ surface: "asphalt" });
  });

  it("fires hoverend once", () => {
    const profile = create();
    const spies = spyAll(profile);
    mouse($(".hover-capture"), "mouseleave", 0);
    expect(spies.hoverend).not.toHaveBeenCalled();
    hover(300);
    mouse($(".hover-capture"), "mouseleave", 0);
    mouse($(".hover-capture"), "mouseleave", 0);
    expect(spies.hoverend).toHaveBeenCalledTimes(1);
  });

  it("fires click without a selection", () => {
    const profile = create();
    const spies = spyAll(profile);
    click(500);
    expect(spies.click).toHaveBeenCalledTimes(1);
    expect(spies.click.mock.calls[0][0].distance).toBeCloseTo(500, 6);
    expect(spies.click.mock.calls[0][0].elevation).toBe(120);
    expect(spies.selectionclear).not.toHaveBeenCalled();
  });

  it("fires selection and selectionend while dragging", () => {
    const profile = create();
    const spies = spyAll(profile);
    drag(250, 750);
    expect(spies.selection).toHaveBeenCalledTimes(1);
    expect(spies.selectionend).toHaveBeenCalledTimes(1);
    expect(spies.click).not.toHaveBeenCalled();
    const e = spies.selectionend.mock.calls[0][0];
    expect(e.start).toBeCloseTo(250, 6);
    expect(e.end).toBeCloseTo(750, 6);
    expect(e.ascent).toBe(60);
    expect(e.descent).toBe(30);
  });

  it("orders start and end when dragging to the left", () => {
    const profile = create();
    const listener = vi.fn();
    profile.on("selectionend", listener);
    drag(750, 250);
    expect(listener.mock.calls[0][0].start).toBeCloseTo(250, 6);
    expect(listener.mock.calls[0][0].end).toBeCloseTo(750, 6);
  });

  it("treats a move of up to 3 px as a click", () => {
    const profile = create();
    const spies = spyAll(profile);
    mouse($(".hover-capture"), "mousedown", 500);
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: clientX(500) + 2, clientY: 51 }));
    mouse(window, "mouseup", 500);
    expect(spies.selection).not.toHaveBeenCalled();
    expect(spies.click).toHaveBeenCalledTimes(1);
  });

  it("fires selectionclear instead of click when a selection exists", () => {
    const profile = create();
    drag(250, 750);
    const spies = spyAll(profile);
    click(500);
    expect(spies.selectionclear).toHaveBeenCalledTimes(1);
    expect(spies.click).not.toHaveBeenCalled();
    click(500);
    expect(spies.click).toHaveBeenCalledTimes(1);
  });

  it("does not fire hover while a selection exists", () => {
    const profile = create();
    drag(250, 750);
    const spies = spyAll(profile);
    hover(300);
    expect(spies.hover).not.toHaveBeenCalled();
  });

  it("supports once and off", () => {
    const profile = create();
    const onceListener = vi.fn();
    const listener = vi.fn();
    profile.once("hover", onceListener);
    profile.on("hover", listener);
    hover(300);
    hover(400);
    expect(onceListener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(2);
    profile.off("hover", listener);
    hover(500);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("off removes a once listener", () => {
    const profile = create();
    const listener = vi.fn();
    profile.once("hover", listener);
    profile.off("hover", listener);
    hover(300);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("methods", () => {
  it("setSelection returns null before render", () => {
    expect(new ElevationProfile("profile").setSelection(0, 100)).toBeNull();
  });

  it("setSelection returns ascent and descent and shows the selection", () => {
    const profile = create();
    expect(profile.setSelection(750, 250)).toEqual({ ascent: 60, descent: 30 });
    expect($<SVGRectElement>(".selection-rect").style.display).toBe("block");
  });

  it("setSelection clamps to the profile", () => {
    const profile = create();
    expect(profile.setSelection(-100, 5000)).toEqual({ ascent: 110, descent: 50 });
  });

  it("showHoverAt shows the hover point, hideHover hides it", () => {
    const profile = create();
    profile.showHoverAt(300);
    expect($<SVGLineElement>(".hover-line").style.display).toBe("block");
    expect($<SVGGElement>(".hover-badge").style.display).toBe("block");
    profile.hideHover();
    expect($<SVGLineElement>(".hover-line").style.display).toBe("none");
    expect($<SVGGElement>(".hover-badge").style.display).toBe("none");
  });

  it("showHoverAt is ignored while a selection exists", () => {
    const profile = create();
    profile.setSelection(250, 750);
    profile.showHoverAt(300);
    expect($<SVGLineElement>(".hover-line").style.display).toBe("none");
    expect(badgeLines()).toEqual(["+ 60 m", "- 30 m"]);
  });

  it("clearSelection removes the selection, a click then fires click", () => {
    const profile = create();
    profile.setSelection(250, 750);
    profile.clearSelection();
    expect($<SVGRectElement>(".selection-rect").style.display).toBe("none");
    const spies = spyAll(profile);
    click(500);
    expect(spies.click).toHaveBeenCalledTimes(1);
    expect(spies.selectionclear).not.toHaveBeenCalled();
  });

  it("render clears the selection", () => {
    const profile = create();
    profile.setSelection(250, 750);
    profile.render(lineFeature());
    const spies = spyAll(profile);
    click(500);
    expect(spies.click).toHaveBeenCalledTimes(1);
    expect(spies.selectionclear).not.toHaveBeenCalled();
  });

  it("fire no events", () => {
    const profile = create();
    const spies = spyAll(profile);
    profile.showHoverAt(300);
    profile.hideHover();
    profile.setSelection(250, 750);
    profile.clearSelection();
    ALL_EVENTS.forEach((type) => expect(spies[type]).not.toHaveBeenCalled());
  });
});

describe("imperial", () => {
  it("fires hover and click values in feet", () => {
    const profile = create({ units: "imperial" });
    const spies = spyAll(profile);
    hover(300);
    click(500);
    expect(spies.hover.mock.calls[0][0].distance).toBeCloseTo(300 / FT, 6);
    expect(spies.hover.mock.calls[0][0].elevation).toBeCloseTo(150 / FT, 6);
    expect(spies.click.mock.calls[0][0].distance).toBeCloseTo(500 / FT, 6);
    expect(spies.click.mock.calls[0][0].elevation).toBeCloseTo(120 / FT, 6);
  });

  it("fires selection values in feet", () => {
    const profile = create({ units: "imperial" });
    const listener = vi.fn();
    profile.on("selectionend", listener);
    drag(250, 750);
    const e = listener.mock.calls[0][0];
    expect(e.start).toBeCloseTo(250 / FT, 6);
    expect(e.end).toBeCloseTo(750 / FT, 6);
    expect(e.ascent).toBeCloseTo(60 / FT, 6);
    expect(e.descent).toBeCloseTo(30 / FT, 6);
  });

  it("takes and returns feet in the methods", () => {
    const profile = create({ units: "imperial" });
    profile.showHoverAt(300 / FT);
    expect(badgeLines()[0]).toBe("492 ft");
    const result = profile.setSelection(250 / FT, 750 / FT)!;
    expect(result.ascent).toBeCloseTo(60 / FT, 6);
    expect(result.descent).toBeCloseTo(30 / FT, 6);
    expect(badgeLines()).toEqual(["+ 197 ft", "- 98 ft"]);
  });

  it("round-trips a selectionend into setSelection", () => {
    const profile = create({ units: "imperial" });
    const listener = vi.fn();
    profile.on("selectionend", listener);
    drag(250, 750);
    const e = listener.mock.calls[0][0];
    const result = profile.setSelection(e.start, e.end)!;
    expect(result.ascent).toBeCloseTo(e.ascent, 9);
    expect(result.descent).toBeCloseTo(e.descent, 9);
  });

  it("formats marker labels in feet", () => {
    create({ units: "imperial" });
    expect(texts(".marker-start .marker-label")).toEqual(["328 ft"]);
  });
});
