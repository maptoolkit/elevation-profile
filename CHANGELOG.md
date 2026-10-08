# @maptoolkit/elevation-profile

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
