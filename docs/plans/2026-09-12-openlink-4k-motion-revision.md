# OpenLink 4K and continuous transitions

User revision: fix every hard cut, use the real current input, deliver native 4K, and optionally use GSAP and Motion. Retain no overhead titles, full top-to-bottom work, native preview, and feature inserts.

## Evidence

The previous `TransitionSeries` contained only sequences, without transitions. `Features` also switched entire views through conditionals. The opening used the older `ChatComposer` snapshot with forced expanded layout, although an initial creation shot should show current `WorkspacePrompt` with agent/local mode, permission, named model and project controls.

## Changes

- Refresh both source presentation trees plus 25 recursive current UI modules and current theme. Home and chat are distinct states; no hand-redrawn control substitutes. Source app and old snapshot stay unchanged.
- Add seven 48-frame main overlaps and three intra-feature overlaps. GSAP paused timeline creates timing curves; Motion samples the spring settle. Curves are immutable frame-indexed data, so no animation runs from wall-clock time during rendering.
- Use lateral masks, upward masks, aperture reveals and a matched-frame dissolve. Do not blur UI or double-expose readable text. Adjacent footage overlaps for 0.8s; 24-frame lead/trail pads preserve the 60s picture duration.
- Render a 3840×2160 composition, with the 1920-unit artboard laid out at CSS zoom 2, not an enlarged MP4. Native DOM/SVG/fonts are rasterized into 4K frames. Scale source canvas paint density for high magnification. Use lossless PNG intermediates and CRF 14 H.264.
- Validate home/chat adapter-to-source pixel parity at identical viewports. Validate transition start/mid/end and out-of-order frames. Review 4K detail samples and encoded clips before whole-file delivery.

## Verification and output

Commands from `video/zorker-openlink-demo`: `node scripts/extract-current-composers.mjs`, `node scripts/build-motion-curves.mjs`, `npx tsc --noEmit`, then `node scripts/render-4k.mjs --video`. Default output `out/4k`; override `FILM_OUTPUT` for delivery. `FRAME_RANGE=396,444` exports a transition test, `FILM_FRAMES` selects QA frames, and `QA_SCALE=1` captures full-resolution stills.

Current extraction has no authentication, real service calls, runtime state mutation, or publication. Closed native menus and inert fixture callbacks preserve structure. Forma remains illustrative website content. Keep all prior exports for comparison. No subjective T0 certification or unperformed listening review is claimed.
