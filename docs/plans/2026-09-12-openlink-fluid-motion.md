# Fluid-motion revision

Keep white background, logo-only opening, source-derived home/chat inputs and preview, complete workflow, no overhead headlines. Prior 120fps H.264 stalled near 35s in the in-app decoder; 60fps compatibility export played to completion. Verify timing rather than treating a frame-rate label as smoothness.

## Scope

1. Audit encoded frame timestamps for gaps; inspect authored holds, layout measurement and transitions.
2. Measure native input geometry once after fonts load; derive typing-front positions from immutable font metrics, avoiding per-frame DOM-to-React camera feedback.
3. Use scoped, paused GSAP timelines for native UI entrances, button hover/press, row staggering, diff expansion, selection and version interactions. Seek from design time and clean up on unmount; no live service callbacks.
4. Author dedicated GSAP camera tracks with gradual residual movement during reading holds. Remove clamped scene-clock freeze handles. Shorten and vary overlaps; replace large empty aperture wipes with continuous camera-led transitions.
5. Animate the illustrative website palette in a single DOM tree, without overlapping two complete previews and their different chat text.
6. Render stable 4K60 as the primary playback delivery. Retain resolution and source fidelity, test clip/whole-film playback, timestamps, random seek, and source geometry. Test alternative 120fps encoding separately only if it improves compatibility.

No app business-logic edits, commits, deployments, or paid generation. Prior exports retained. Source geometry and fixture limitations remain documented.
