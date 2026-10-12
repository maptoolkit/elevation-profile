# @maptoolkit/elevation-profile

## 1.3.0

### Minor Changes

- 86b733e: Replace `lngLat` in the `hover` and `click` events with `geometry`, a GeoJSON `Point`. Its coordinates are `[lng, lat, ele]`, so use `e.geometry.coordinates.slice(0, 2)` instead of `e.lngLat`.

  Add `geometry` to the `selection` and `selectionend` events: the selected stretch of the line as `LineString` or `MultiLineString`, like the input geometry. Coordinates are `[lng, lat, ele]` with `ele` in meters, interpolated on the line.

## 1.2.0

### Minor Changes

- 1afe3b5: Add a `selection-line` element to style the part of the line within the selection
- 1afe3b5: Add `width` and `height` options to set the SVG viewBox size and aspect ratio

### Patch Changes

- 1afe3b5: Error messages are in English
- 1afe3b5: Increase the padding around the plot so larger label font sizes are not clipped

## 1.1.0

### Minor Changes

- 3adcc3d: Prefix all CSS classes, ids and custom properties with `maptoolkit-elevation-profile-`, so they don't collide with the styles of the host page. Custom CSS has to use the new names, e.g. `.maptoolkit-elevation-profile-line` instead of `.line` and `--maptoolkit-elevation-profile-text` instead of `--text`.
