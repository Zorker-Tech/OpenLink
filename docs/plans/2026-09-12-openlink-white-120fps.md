# White logo-only 4K120 revision

User request: remove opening spheres, use only a logo transition, make the video background white, and target 120fps (at least 60).

- Replace the 7-second sphere opening with a 3-second dark-logo reveal on white; preserve all remaining scenes and their timing. New duration: 56 seconds.
- Use pure white stage/background and the application's existing light theme for native input, timeline and preview surfaces. Use the supplied dark logo asset. No app business logic or source-component JSX changes.
- Render 3840×2160 at 120fps: 6720 frames. Double all sequence/transition output durations, retain 60fps design units through `designFrame=outputFrame*60/fps`, including fractional frames. Major transitions remain 0.8 seconds (96 output frames).
- Trim the original soundtrack's first 4 seconds so existing subsequent sound cues remain aligned.
- Verify source integrity and light-theme parity, logo-only opening, actual frame metadata, native fractional-frame motion (adjacent frames differ rather than duplicating 60fps), transition seams, final frame and playback.
- Keep existing exports. New output folder: `revision-5-white-120fps`. Commands: `npx tsc --noEmit`, `node scripts/verify-white-120.mjs`, `node scripts/render-white-120.mjs --video`.
