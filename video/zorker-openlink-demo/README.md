# Zorker OpenLink — English native-UI film

Composition: `ZorkerOpenLink`. 1920×1080, 30 fps, 1800 frames / 60 seconds. Music-free.

The current revision follows the user's explicit correction: no outer frame, chapter titles, captions, page numbers, progress bar or slide treatment. Three-second brand opening, 54 seconds of continuous full-screen native workspace framing, three-second brand ending. Camera bounds never leave the workspace canvas.

## Reproduce

Use the existing installation (video packages are locked; source UI dependencies resolve from OpenLink's existing root installation):

```sh
node scripts/extract-faithful.mjs
npx tsc --noEmit
node scripts/verify-faithful.mjs
node scripts/render-faithful.mjs --video
```

Default output: `/Users/yikewang/Movies/Zorker-OpenLink-20260907/Zorker-OpenLink-EN-v2.mp4`. Set `FILM_OUTPUT` to another output directory. Outputs go to local disk because the project volume is nearly full. Set `FILM_FRAMES=300,650,1260` for a smaller still-only QA run. Without that override, all listed transition seams are sampled at -1/0/+1.

## Source fidelity

- `src/source-snapshot/components/chat-timeline.js`: actual ChatTimeline reducer, conversation-round projection, Working/Worked group, nested task groups/rows, message and Git-change presentation. Extracted from the user's current working tree, not redrawn.
- `src/source-snapshot/components/film-session-composer.js`: actual ChatComposer PromptInput subtree from chat-workspace.tsx, including the session variant, 42px compact state, expanded state, AgentPromptTextarea and original model/send controls. No WorkspacePrompt substitution.
- `src/adapters`: explicit frame state, inert service actions, static scrolling container with the original stable scrollbar gutters, and the actual ThinkingOrb canvas painter driven by frame time.
- `provenance/faithful-manifest.json`: current source/output hashes and adaptation inventory. This supersedes the earlier manifest for the active composition. The original browser/header/code shell remains a film presentation adaptation, not an exact extraction; the preview is a fictional website fixture.
- `SourceReference` and `FilmParity`: unmodified source timeline and adapted timeline rendered at the same 430×604 viewport, settled state, theme and font. The QA script requires identical PNG hashes. Both share the extracted composer, so this comparison proves timeline parity, not an independent pixel comparison of the composer.

The reference project Tibo-Please was inspected as motion source: glyph relay and focused camera transitions. Its branding and input UI were not substituted for OpenLink.

## Verification scope

Typecheck covers authored TS/TSX adapters and compositions; generated JS snapshots retain source provenance and are verified through explicit structure tests and renders, not an independent typecheck of the whole source application. The verification script checks snapshot hashes, 50 original timeline class attributes, original session composer markers, clock-free timeline adaptation and absence of the slide wrapper.

The render script writes representative/seam images, three out-of-order matching-frame hashes, a zero-browser-error check, and source parity evidence to `qa/report.json` next to the MP4. Still inspection does not establish full-playback pacing approval. No live provider run, deployment or performance claim is made. This is an illustrative, time-compressed workflow.

Earlier files (`source-ui.tsx`, `Intro.tsx`, `extract-source.mjs`, old output) are retained for recovery but are no longer used by the active film.
