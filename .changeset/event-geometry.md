---
"@maptoolkit/elevation-profile": minor
---

Replace `lngLat` in the `hover` and `click` events with `geometry`, a GeoJSON `Point`. Its coordinates are `[lng, lat, ele]`, so use `e.geometry.coordinates.slice(0, 2)` instead of `e.lngLat`.

Add `geometry` to the `selection` and `selectionend` events: the selected stretch of the line as `LineString` or `MultiLineString`, like the input geometry. Coordinates are `[lng, lat, ele]` with `ele` in meters, interpolated on the line.
