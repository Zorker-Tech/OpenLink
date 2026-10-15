# Zorker OpenLink launch film

This is a separate 71-second launch composition adapted from the supplied ChatGPT launch-video reverse prompt. It follows one illustrative development task from brief through visible work, preview, refinement, and project review.

The production master is 3840×2160 at 120 fps (8,520 frames). A 3840×2160 60 fps delivery copy is provided for playback compatibility. It keeps every other master frame and has exactly 4,260 frames. The film uses procedural sound effects only: no score or voiceover.

## Story and source UI

The eleven-shot storyboard is `src/launch-film/storyboard.json`. The title track, thesis, proof statement, and closer are original OpenLink copy. The ask, work timeline, change card, follow-up composer, split workspace, preview, inspector, diff, and version menu use the existing OpenLink presentation extractions. The source map and adaptations are in `provenance/launch-film-components.json`; the existing extraction manifests remain authoritative for individual dependencies and source hashes.

The Forma site, displayed edits, conversation events, GPT-6 Luna label, and version states are deterministic illustrative fixtures. The product shots retain the small “Illustrative workflow · Time compressed” disclosure. No live provider run, external sharing, Snowflake, Tableau, Teams, or dashboard capability is claimed.

## Reproduce

From this directory, regenerate the SFX-only track with `node scripts/generate-launch-sfx.mjs`. The command writes `public/audio/openlink-launch-sfx-only.wav` and `provenance/launch-film-audio.json`.

Render and sample the 120 fps master with `node scripts/render-launch-film.mjs --video`. It writes the MP4 and QA stills to `/Users/yikewang/Movies/Zorker-OpenLink-Launch-20261012/`.

Create the exact-frame 60 fps compatibility file with `node scripts/create-launch-compat.mjs`. Check an existing delivery without re-encoding it with `node scripts/create-launch-compat.mjs --verify-only`.

The probe report and media hashes are in `provenance/launch-film-render.json`. The original Revision 10 film and its existing uncommitted render-script changes are preserved.
