# Zorker OpenLink — Reference Film

A new reference-led composition, preserving the earlier `ZorkerOpenLink` video.

## Revision 10 — director's cut, GPT-6 Luna

Re-edited as a concise product film rather than a feature tour. The cut moves from one clear brief, through the completed work and current split workspace, into one revision and its visible result; three distinct capability inserts then land as a short proof run before the brand close. Waiting is explicitly time-compressed, repeated holds are removed, and each interaction keeps a readable beat. The exact timing and cut handles are in `src/reference-film/storyboard-v10.json`.

| Shot | Editorial job | Active time |
| --- | --- | ---: |
| Logo | Recognize the mark; no title card | 1.83s |
| Brief | Type once in the real current homepage composer and send | 4.20s |
| Work | One top-to-bottom scan from activity to completed proof | 5.50s |
| Workspace | Re-establish the current full split layout | 3.80s |
| Refine | Show GPT-6 Luna and one compact follow-up | 3.50s |
| Result | Let the visible site change register | 3.00s |
| Capability proof | Inspect, source diff, then version switch | 5.50s |
| Brand close | Return to the mark and finish clean | 2.50s |

Total: 1,790 frames / 29.83s at 60 fps, with 7 directional overlaps of 15–25 frames. The GPT-6 Luna selection and all Forma/site/agent events are deterministic demo fixtures; the film does not make a live-provider execution or availability claim. Current session headers, preview, timeline and composers remain extracted from the Sep 23 OpenLink source. Nothing in the OpenLink app source was edited for this revision. Run `node scripts/verify-reference.mjs` for layout, extraction hashes, model label, title/audio rules, and timing checks.

Revision 9's 56-second export is preserved as a historical deliverable and was not overwritten. Earlier revision notes below describe previous states; where they differ, Revision 10's storyboard, audio report and current extraction manifests above supersede them.

## Deliverable

- Composition: `OpenLinkReferenceFilm`
- Primary playback delivery: 3840 × 2160, 60 fps, 1,790 frames / 29.83 seconds
- Director's cut export: `/Users/yikewang/Movies/OpenLink-Reference-20260923/revision-10-paced-gpt6-luna/OpenLink-4K60-Paced-GPT-6-Luna.mp4`
- Export: H.264, YUV 4:2:0, CRF 14, lossless PNG intermediates; AAC stereo, 48 kHz
- Language: English
- Direction: pure white negative space, logo-only opening, native light-theme UI, tracked input, no overhead explanatory titles, clear brand end hold. Opening decorative spheres are removed.
- Sound effects only: clicks, frame-synchronized keyboard strokes and transition air sounds. No background music, harmonic bed, bass pulses, melody or voiceover (revision 8 audio update). Keyboard events follow each newly visible character in both input scenes.

## Edit and render

Run in `video/zorker-openlink-demo` from the OpenLink checkout:

```sh
npx remotion studio --no-open --port=3117
# Open http://localhost:3117/OpenLinkReferenceFilm

npx tsc --noEmit
node scripts/verify-fluid.mjs
FILM_OUTPUT="/Users/yikewang/Movies/OpenLink-Reference-20260923/revision-10-paced-gpt6-luna" FILM_QA_OUTPUT="/Volumes/Net/OpenLink/video/zorker-openlink-demo/out/revision-10-qa" node scripts/render-fluid.mjs --video
```

`FILM_OUTPUT` selects the movie directory and `FILM_QA_OUTPUT` can place high-resolution QA stills on a separate volume; the film and cue scheduler both read the storyboard JSON. QA samples every shot and transition, checks deterministic seeks and frame-to-frame movement, and captures four 4K detail stills. `FILM_FRAMES` can override the general sample list; `QA_SCALE=1` makes all QA frames full resolution. `FRAME_RANGE=start,end` makes an interaction/transition test; `--only-video` skips still rendering. All versions are locked, including GSAP 3.15.0 and Motion 12.43.0. Earlier render/remux scripts describe historical exports.

## Revision 6: fluid motion

Frame timestamp audits of both previous exports found no missing timestamps. Authored stop/starts and live DOM measurement feedback were nevertheless pacing risks, and the old 120fps H.264 failed in-app decoding near 35s. The primary delivery therefore uses directly rendered 4K60, not a down-conversion of a 120fps export.

Eight dedicated GSAP camera/actor tracks replace generic stop-and-hold motion. Scene clocks run through overlap handles instead of being clamped/frozen. Main overlaps vary from 24 to 44 design frames; large empty aperture wipes are replaced with directional move/scale blends. The result and inspector cameras share their transition anchor.

Native UI uses scoped, paused GSAP timelines sought to explicit frame time: home header/form/project stagger; submit hover/press/rebound; read/edit/build row arrivals and completion-icon emphasis; reply entrance; smooth Git-card height expansion and code reveal; inspector tool press and selection-label reveal; diff entrance; staggered version rows, hover and press feedback; selected-version highlighting. Cursors follow curved paths and clicks have restrained expanding-ring feedback. These are presentation effects; callbacks remain inert.

Input geometry is measured once after fonts are ready, using layout coordinates and precomputed glyph widths. Per-frame camera feedback through `getBoundingClientRect()` is removed. The website palette changes on one DOM tree through CSS variables, without overlaying two full previews or different chat text. Source component structure and settled styling remain intact.

Revision 5 removes the four seconds previously occupied by opening sphere material. The remaining 3-second opening contains only the original dark logo and wordmark on white. The source app's light theme keeps native controls readable. The original score is trimmed by four seconds, preserving later cue alignment. Sequence durations and main transition durations double at 120fps; `ShotClock` maps output frames to fractional 60fps design units. Thus motion is newly rendered every 1/120 second rather than duplicating a 60fps export. Picture duration is 56 seconds; transitions remain 0.8 seconds / 96 output frames.

The 120fps H.264 master passes full software decoding, but the current in-app browser stopped it near 35 seconds during repeated playback tests, including a byte-range-enabled local server. A separate 4K60 compatibility MP4 is included in the delivery directory. Do not claim universal 120fps player compatibility.

The original source-derived input snapshot remains for opening/home composer context. The current chat composer and timeline have also been re-extracted from the latest application source into isolated film modules. Extraction is kept under `src/reference-film/` and `src/source-snapshot/`; it does not overwrite product source files.

Scene source is in `src/reference-film/`; registration is additive in `src/Root.tsx`. `Native.tsx` contains deterministic fixture adapters, not new product UI. `primitives.tsx` holds camera math, original optical artwork, editorial type and brand lockup. Each scene is separately named in Studio.

User revision: all overhead explanatory text has been removed, including the question above the input. Product shots contain source UI, a small workflow disclosure, and no editorial headline. The before/after preview is centered and enlarged. Opening/closing brand identity remains.

Revision 3 extends the timeline segment through completed build, final response and an expanded Git snapshot. The native disclosure remains open as the camera scans down; the result is held before the preview reveal. Actual `ChatTopbar`, `PreviewCanvas`, ready `BrowserWorkbench` wrapper, Chromium inspector overlay, Git version menu and source `ChangeItem` are extracted into `src/reference-film/source/`. Service hooks, socket/iframe runtime and actions are excluded. The illustrated Forma website inside the preview remains the existing demo content, not a live generated customer project. This distinction is intentional and documented in `provenance/reference-preview-extraction.json`.

The new negative-space feature sequence uses those same components: select a component with source location, inspect the actual change card, then choose a Git version and see the corresponding preview. Menu portals are adapted to inert presentation tags retaining the native subtree/styles so they follow the Remotion camera. No product operation is sent.

To refresh the newly extracted preview presentation, run `node scripts/extract-reference-preview.mjs` before the checks. This writes only new film modules and a provenance manifest, not the application or the earlier frozen extraction.

## Storyboard and evidence

Revision 4 corrects the composer context: the opening uses the **current homepage `WorkspacePrompt`**; the refinement and preview sidebar use the **current compact `ChatComposer`**. Their current dependency graph (25 UI modules), original class strings, original SVGs and theme are extracted into `current-ui/` without application writes. Film adapters are compared against those current source presentation trees at identical 1000×400 viewports. This is adapter-to-source-presentation parity, not a claim of an authenticated live-app test.

Seven major cuts now have real 48-frame overlaps, plus three overlaps inside feature inserts. Twenty-four-frame lead/trail holds preserve the 60-second duration. Masked lateral motion, upward reveals, aperture reveals and matched-state dissolves keep text sharp without artificial UI blur. A paused [GSAP timeline](https://gsap.com/docs/v3/GSAP/Timeline/totalTime()/) and [Motion spring generator](https://motion.dev/docs/spring) are sampled offline into immutable frame-indexed curves. No RAF or wall-clock engine drives the exported frames. The input/send camera targets are measured from actual DOM geometry.

The 4K composition uses a 1920-unit layout at CSS zoom 2, with native 4K DOM/SVG rasterization, not an upscale of a 1080p movie. Small source canvas painters use higher backing resolution. The opening's intentional optical blur is applied once to a clipped viewport, avoiding huge per-orb Gaussian surfaces after the macro zoom; product UI remains unblurred.

Full timing, shot purpose, acceptance conditions and boundaries: `../../docs/plans/2026-09-12-openlink-reference-film.md`.

Reference: user-supplied `TwitterSaver.Net_BjNVwhuNqdiLgiDo_1080p.mp4`, measured 1920×1080, 60fps, approximately 45.91s. Extracted frames were visually inspected. The reference's trademark, UI, data, frames and soundtrack are not included in the deliverable.

Native UI is the earlier source-derived baseline from this OpenLink checkout: original session composer, timeline grouping, reducer, file changes, task controls, Geist and SVG assets. `provenance/reference-film.json` records imports, adaptations, snapshot integrity, current source hashes and limitations. `provenance/faithful-manifest.json` retains the original extraction mapping. Forty-five frozen source records pass hash verification.

The current dirty app has evolved after the original extraction. The older `verify-faithful.mjs` comparison against current source fails on an `EditableUserMessage` error-state class. That state is not shown in this film; the baseline is explicitly frozen, not claimed to be the latest complete app. No existing snapshot or application business logic was overwritten.

Forma is a fictional illustrative website. The task events, build result and timing are deterministic demonstration data, not a live provider run or performance benchmark. No production deployment, authorization, external account operation or real user message is shown or triggered.

## QA scope

The renderer outputs `qa/render-report.json`: representative and transition stills, composer parity, browser errors, and repeated-frame determinism. Revision 10's `provenance/revision-10-render.json` records the final MP4 metadata, SHA-256, and full audio/video decode checks; Revision 9's report and export remain preserved. Studio/MP4 playback is a separate check from still-frame inspection.

`provenance/keyboard-sfx-audio.json` records the revision's transition/click/keyboard cue positions, measured peak/RMS, zero clipping and a zero-valued faded tail. These measurements do not claim a subjective listening/mastering review. Do not describe the piece as independently certified “T0”; visual approval remains with the user.

## Rights and safety

Uses user-provided source and brand assets for this requested local production. Font and dependency licenses remain applicable. New optical artwork and synthesized sound are original. No paid media generation, licensed-stock purchase, publishing, pushing, committing, or application-runtime change was performed.
