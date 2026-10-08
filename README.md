# elevation-profile

[![License](https://img.shields.io/npm/l/@maptoolkit/elevation-profile?style=plastic)](LICENSE)
[![Version](https://img.shields.io/npm/v/@maptoolkit/elevation-profile?style=plastic)](https://www.npmjs.com/package/@maptoolkit/elevation-profile)
[![Downloads](https://img.shields.io/npm/dm/@maptoolkit/elevation-profile?style=plastic)](https://www.npmjs.com/package/@maptoolkit/elevation-profile)

A dependency-free SVG elevation profile for 3D GeoJSON lines, with hover, drag selection (ascent/descent) and optional section bars (e.g. surface or road type) below the plot. It is map-independent; events carry coordinates so it can be wired to any map.

**[Live demo](https://maptoolkit.github.io/elevation-profile/)**

## Install

```bash
npm install @maptoolkit/elevation-profile
```

## Usage

```js
import { ElevationProfile } from "@maptoolkit/elevation-profile";
import "@maptoolkit/elevation-profile/style.css";

const profile = new ElevationProfile("profile", { units: "metric" });
profile.render(feature);
```

The first argument is the container element or its id. The element may be added to the DOM after `render()`. The profile fills the container's width; its height follows from the aspect ratio of the SVG (`width` × `height`, default 900 × 320). Calling `render()` again replaces the profile and clears any selection.

### Without a bundler

The package is ESM-only (no UMD/CJS build) and has no dependencies, so it can be imported straight from a CDN:

```html
<link href="https://unpkg.com/@maptoolkit/elevation-profile@^1.0.0/dist/elevation-profile.css" rel="stylesheet" />

<div id="profile"></div>

<script type="module">
  import { ElevationProfile } from "https://unpkg.com/@maptoolkit/elevation-profile@^1.0.0/dist/elevation-profile.js";

  new ElevationProfile("profile").render(feature);
</script>
```

## Input data

A GeoJSON `Feature` with a `LineString` or `MultiLineString` geometry. Every coordinate needs an elevation in meters: `[lng, lat, ele]`. The parts of a `MultiLineString` are joined end to end; gaps between parts don't count towards the distance.

| Property              | Type                                   | Description                                                                                   |
| --------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `properties.length`   | `number`                               | Total length in meters. Optional; if set, the computed distances are scaled to it.            |
| `properties.sections` | `SectionInput[]` \| `SectionInput[][]` | Optional section bars below the plot, see below. For a `MultiLineString`, one array per part. |

### Sections

Each section becomes one bar below the plot. `from` and `to` are fractions (0..1) of the line length, like linear referencing:

```json
{
  "type": "Feature",
  "geometry": { "type": "LineString", "coordinates": [[13.67, 47.38, 963], "..."] },
  "properties": {
    "sections": [
      {
        "id": "surface",
        "values": [
          { "from": 0, "to": 0.4, "value": "asphalt" },
          { "from": 0.4, "to": 1, "value": "unpaved" }
        ]
      }
    ]
  }
}
```

- Stretches not covered by any value are shown as `other`.
- Touching segments with the same value are merged; segments too small to show are dropped.
- For a `MultiLineString`, `sections` holds one array per part (`[[...], [...]]`), with `from`/`to` relative to that part. Sections with the same `id` are joined into one bar.
- The data carries raw values only. Labels come from the `locale` option, colors from CSS (see [Styling](#styling)).

### With the Maptoolkit API

Maptoolkit customers can get the elevations and surface/highway types of a route from the [Route Enhancement API](https://docs.maptoolkit.com/route-enhancement-api/api-reference/) and pass the result straight to the profile. For example, for a KML file:

```js
const params = new URLSearchParams({
  api_key: "YOUR_API_KEY",
  kml: "https://example.com/track.kml",
  elevation: "1",
  surface: "1",
});
const response = await fetch(`https://enhance.maptoolkit.net/route?${params}`);
const route = await response.json();

profile.render({
  type: "Feature",
  geometry: route.geometry, // MultiLineString with elevations
  properties: {
    // One array of { from, to, surface, highway } per part.
    sections: (route.surface ?? []).map((part) => [
      { id: "surface", values: part.map(({ from, to, surface }) => ({ from, to, value: surface })) },
      { id: "highway", values: part.map(({ from, to, highway }) => ({ from, to, value: highway })) },
    ]),
  },
});
```

## Options

| Option   | Type                       | Default    | Description                                                                                                                                                                 |
| -------- | -------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `units`  | `"metric"` \| `"imperial"` | `"metric"` | Axis labels in m/km or ft/mi. With `"imperial"`, all lengths in events and methods are in feet instead of meters.                                                           |
| `locale` | `Record<string, string>`   | see below  | Hover badge labels for section values, keyed `"<section id>.<value>"` with the raw values from the data. Merged with the defaults. Values without an entry are shown as is. |
| `width`  | `number`                   | `900`      | Width of the SVG viewBox. Together with `height` it sets the aspect ratio. Fonts and margins are in viewBox units, so a smaller viewBox makes the text relatively larger.   |
| `height` | `number`                   | `320`      | Height of the SVG viewBox.                                                                                                                                                  |

The default `locale` has English labels for `surface.*` (`asphalt`, `paved`, `unpaved`, `natural`, `alpine`, `other`) and `highway.*` values, see `defaultElevationProfileOptions` in `src/ElevationProfile.ts`:

```js
new ElevationProfile("profile", {
  locale: {
    "surface.asphalt": "Asphalt",
    "surface.unpaved": "Schotter",
  },
});
```

## Events

```js
profile.on("hover", (e) => marker.setLngLat(e.lngLat));
profile.on("hoverend", () => marker.remove());
profile.on("selectionend", (e) => console.log(e.start, e.end, e.ascent, e.descent));
```

`on(type, listener)`, `once(type, listener)` and `off(type, listener)` work like in MapLibre and return the profile. Every event has `type`, `target` (the profile) and `originalEvent` (the `MouseEvent`).

| Event            | Data                                        | Fired when                                                             |
| ---------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| `hover`          | `{ distance, elevation, lngLat, sections }` | The mouse moves over the plot, while there is no selection.            |
| `hoverend`       | —                                           | The mouse leaves the plot or a drag starts, once per hover.            |
| `click`          | `{ distance, elevation, lngLat, sections }` | Click without drag, while there is no selection.                       |
| `selection`      | `{ start, end, ascent, descent }`           | While dragging a selection.                                            |
| `selectionend`   | `{ start, end, ascent, descent }`           | A drag selection ends.                                                 |
| `selectionclear` | —                                           | Click without drag while a selection exists. No `click` is fired then. |

- `distance`, `elevation`, `start`, `end`, `ascent` and `descent` are in meters, or feet with `units: "imperial"`. Values are not rounded.
- `elevation` is the nearest sample (same as the badge); `lngLat` (`[lng, lat]`) is interpolated on the line.
- `sections` maps each section id to its raw value at that point, `"other"` if not covered.
- `start <= end`, regardless of the drag direction.

## Methods

| Method                     | Description                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `render(feature)`          | Renders a feature, replacing the previous profile and selection.                                                                                                            |
| `showHoverAt(distance)`    | Shows the hover point at a distance. Ignored while a selection exists or the profile is not rendered.                                                                       |
| `hideHover()`              | Hides the hover point.                                                                                                                                                      |
| `setSelection(start, end)` | Selects a range (any order, clamped to the line) and returns `{ ascent, descent }`, or `null` (no effect) before the first `render()` or while the profile is not rendered. |
| `clearSelection()`         | Removes the selection.                                                                                                                                                      |

Distances are in meters, or feet with `units: "imperial"`, so values from events can be passed back directly, e.g. `profile.setSelection(e.start, e.end)`. These methods fire no events.

"Not rendered" means the container is not in the DOM or hidden by `display: none` (itself or an ancestor). The hover badge can't be measured then, so `showHoverAt()` and `setSelection()` have no effect; call them again once the profile is visible. A selection made while visible is kept when the profile is hidden.

## Styling

The constructor adds the class `maptoolkit-elevation-profile` to the container; all styles in `style.css` are scoped under it. All classes, ids and CSS custom properties are prefixed with `maptoolkit-elevation-profile-`, so they don't collide with the styles of the page. Colors and font are custom properties:

```css
.maptoolkit-elevation-profile {
  --maptoolkit-elevation-profile-text: #333;
  --maptoolkit-elevation-profile-muted: #666;
  --maptoolkit-elevation-profile-grid: #aaa;
  --maptoolkit-elevation-profile-fill: #002361;
  --maptoolkit-elevation-profile-line: #002361;
  --maptoolkit-elevation-profile-accent: #fa5538;
  --maptoolkit-elevation-profile-badge-bg: none;
  --maptoolkit-elevation-profile-font-family: "Mulish", "Helvetica Neue", Arial, sans-serif;
}
```

Classes, shown without the `maptoolkit-elevation-profile-` prefix:

| Class                                                      | Element                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `line`, `area`                                             | Profile line and the area below it.                                    |
| `grid-line-x`, `grid-line-y`, `axis-line-x`, `axis-line-y` | Grid lines; the first one of each direction is also the axis.          |
| `axis-label-x`, `axis-label-y`                             | Axis labels.                                                           |
| `marker-start`, `marker-end`, `marker-max`                 | Marker groups, each with `marker` and `marker-label`.                  |
| `hover-line`, `hover-dot`                                  | Hover point, following the mouse.                                      |
| `hover-badge`                                              | Badge with `hover-badge-bg`, `hover-badge-text` and `hover-badge-dot`. |
| `selection-rect`                                           | Drag selection.                                                        |
| `selection-line`                                           | The line within the selection, on top of `line`.                       |
| `section-<id>`                                             | One section bar.                                                       |
| `section-value`, `section-<id>-<value>`                    | A bar segment and the matching badge dot.                              |

Section colors are set per value via `--maptoolkit-elevation-profile-section-color`; values without a rule use the fallback `#9e9e9e`. Characters outside `[A-Za-z0-9_-]` in ids and values become `-` in class names.

```css
.maptoolkit-elevation-profile .maptoolkit-elevation-profile-section-surface-gravel {
  --maptoolkit-elevation-profile-section-color: #b9a89b;
}
```

`style.css` includes default colors for `surface` values and some `highway` values.

> **Note:** The badge and marker layout is computed in `ElevationProfile.ts` with fixed sizes (badge font size, dot radius, marker font size). If you change those via CSS, positions and the badge background don't adapt.

## Development

```bash
npm run dev    # demo with demo/example.geojson
npm test       # vitest (jsdom)
npm run lint
npm run build
```

## License

**elevation-profile** is open-source under the [BSD 3-Clause License](LICENSE).
