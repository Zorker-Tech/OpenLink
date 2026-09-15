# OpenLink Reference Film Implementation Plan

**Goal:** Deliver a 46-second, 1920×1080, 60fps OpenLink promotional MP4 and editable Remotion composition inspired by the supplied reference.

**Architecture:** Add a composition inside the existing video project without replacing previous compositions. Reuse the frozen source-derived composer and timeline, original Geist font and Zorker SVGs. New deterministic camera, glass-like vector artwork and editorial output surround those components; no business logic changes or live actions.

**Tech Stack:** React 19.2.3, Remotion 4.0.521, TypeScript, local font/SVGs, Node PCM synthesis, bundled FFmpeg.

## Direction and alternatives

Selected: reference-led dark macro product film. The alternatives are a whitespace typography brand film (less reference fidelity), or continuous screen capture (less camera/art direction). English, 16:9, 60fps follow the reference and existing brand convention. No distribution, paid generation, performance claims or borrowed soundtrack.

## Shot list / storyboard

| Seconds / frames (half-open) | Purpose / subject | Camera and entry/exit anchors | Copy / sound | Evidence / acceptance |
| --- | --- | --- | --- | --- |
| 0–7 / 0–420 | Potential coalesces into identity. Procedural spectral spheres, original logo. | Seed at center, staggered orbit/vertical gathering, macro pass through color into logo. | Low pulse, glass harmonics. Zorker OpenLink. | Reference 0–7s; original generated vector art, no copied brand/media. Mark readable for >1s. |
| 7–15 / 420–900 | An idea becomes input. Native SessionComposer. | Wide negative space; deliberate 2D focus-camera push; track typing; settle on send. | Build a landing page for Forma. A subdued send click. | Extracted ChatComposer JSX. Stable control geometry; typed message readable. |
| 15–21 / 900–1260 | Intent becomes visible work. Native SourceTimeline. | Send-anchor match cut to active timeline, macro scan from tool to file/build. | From a thought. Into motion. Subtle tick events. | Existing event reducer + deterministic fictional events. No actual execution claim. |
| 21–27 / 1260–1620 | Show the artifact. Preview and source UI. | Pull back to designed work surface; expand illustrative Forma output. | Made to be made real. Harmonic lift. | Existing SampleSite is explicitly an illustrative output, not shipped template or recorded generation. |
| 27–34 / 1620–2040 | Creative control. Native composer edit prompt. | Close-up type tracking, push to send, same screen direction. | Make it electric blue. Keep the layout. | Same source composer; no invented controls. Preserve readable hold and last glyph. |
| 34–40 / 2040–2400 | Refinement changes expression, not intent. | Palette sweeps over same sample layout; return to timeline evidence. | Your vision. Still yours. Final pulse resolves. | Demonstration color change; no invented speed or deployment success. |
| 40–46 / 2400–2760 | Brand / invitation. | Geometric line-to-logo match; retreat into quiet centered brand lockup. | Zorker OpenLink. From intent to something real. | Original mark + approved product name. End is fully visible, no black tail. |

## Implementation / verification

1. Add `src/reference-film/` shared graphics, each scene in its own file, composition and shot timings. Register `OpenLinkReferenceFilm`, retain old IDs. Check with `npx tsc --noEmit`.
2. Generate original PCM audio with `node scripts/reference-audio.mjs`; record peak/RMS/tail checks. This is not a licensed stock track and makes no audio-reference-copy claim.
3. Add `scripts/render-reference.mjs`: bundle once, use pinned renderer, render representative frames plus seam−1/seam/seam+1, compare repeat frames in reverse order, capture browser errors, render H.264 and AAC.
4. Build a labeled contact sheet and inspect actual output. Run source snapshot hash verification, document any source drift since extraction; do not overwrite the old extraction.
5. Render and inspect full-duration media metadata. Launch a local Studio preview for user editing. Record visual sampling vs complete playback and audio listening honestly.

## Scope and provenance

Working tree is already heavily modified. Only this plan, new film files/scripts and additive Root/package entries are in scope. No reset, source app refactor, commit, push, deployment, or new task. Prior video snapshot is a source-derived baseline, not a claim that it matches every current dirty app edit. Brand/font user rights are assumed for this requested local deliverable; dependency licenses remain applicable. Reference MP4 is used only for analysis; neither its soundtrack nor frames are included in the final video.

## User revision — authoritative override

Remove every overhead explanatory headline and the input's introductory question. This overrides the editorial captions in the storyboard table above. Keep source-UI text and opening/closing brand identity; no replacement title cards. Product previews are recentered and enlarged after title removal. The small lower-left illustrative-workflow disclosure remains for truthfulness, not as a narrative headline. `verify-reference.mjs` guards against reintroducing a Caption layer into any product scene.

## Revision 3 — complete work, native preview, distinctive features

The latest user asks for the Forma execution to progress from top to bottom through its end, the website preview to use genuine components, and additional negative-space feature demonstrations. Keep the no-overhead-title rule.

New timing is 60 seconds: 0–7 genesis; 7–15 intent; 15–26 complete execution; 26–32 native preview; 32–38 refinement; 38–42 updated preview; 42–46 native component inspector; 46–50 source Git diff; 50–54 native version menu with historical preview feedback; 54–60 brand close. Output: 3,600 frames at 60fps.

Use `components/chat-workspace.tsx` (`ChatTopbar`, `ToolbarButton`, `PreviewCanvas`), `components/browser/browser-workbench.tsx` ready-state structure, `components/browser/chromium-stream-surface.tsx` selection overlay, and the previously captured timeline `ChangeItem`. Extract presentation only into a new film source folder. Keep source classes/assets; remove actions and service dependencies. Preserve the old snapshots and app files. The runtime iframe is replaced at its data/transport boundary by the existing illustrative Forma React child, not by screenshots or a live external frame; do not claim the Forma website is a real generated project.

Acceptance: the final reply, source file and full visible patch must be readable before moving to preview; tasks must not auto-collapse on completion; the preview toolbar/canvas must be traceable to application source; inspector selection bounds must use actual DOM geometry; choosing a version must show a corresponding preview; all feature inserts remain title-free and have sufficient negative space. Verify static states, every boundary, six reverse-order repeat frames, whole-file decoding and browser playback.
