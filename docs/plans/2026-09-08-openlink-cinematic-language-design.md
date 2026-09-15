# OpenLink cinematic language revision

## Direction

This revision supersedes the 54-second continuous product walkthrough. The film remains a 60-second, 1920x1080, 30 fps English brand piece, but the interface is source material rather than a static demonstration surface.

Core grammar: **real UI as material, typography as narration, camera as storyteller**.

## Shot structure

| Frames | Purpose | Visual language | Acceptance |
| --- | --- | --- | --- |
| 0-90 | Brand ignition | Existing Zorker glyph relay; white portal into the composer | No presentation frame; motion exits through a spatial match |
| 90-600 | Intent is written | Real message composer; 4x macro camera tracks the typing front, including smooth line returns | Camera visibly advances throughout typing; no fixed wait for completion |
| 510-930 | Text leaves the interface | Composer border becomes a typographic baseline; large negative-space statement: “Ideas should move.” | UI and typography overlap in one transition rather than cut to a title card |
| 720-1320 | Intent becomes structure | Real timeline, task rows, and source thinking orb are cropped, scaled, and reorganized as a moving system | Recognizably authentic UI, never held as a complete workflow step |
| 1080-1530 | Structure becomes a product | Large type and UI fragments converge toward their native positions | Abstract layout has a spatial path back to the product |
| 1380-1710 | Source revealed | Pull back from timeline detail to the complete real workspace | Full UI is brief and functions as proof/source, not a walkthrough |
| 1710-1800 | Brand resolve | Existing Zorker OpenLink ending | Clean, music-free finish with the existing disclosure |

## Implementation notes

- Preserve the extracted `ChatTimeline`, session composer, and frame-driven thinking orb. No business logic changes.
- Derive typed text and camera target only from the current Remotion frame. Use fixed historical samples for deterministic smoothing.
- Measure the typing front from the real composer's own typesetting: a hidden per-character probe mirrors the textarea's computed font, width, and origin in a layout effect, so camera focus and caret always land on the true text front. On wrap, ease the camera horizontally back while moving down to the new line.
- Use only the real UI tree for interface imagery. Typography and layout masks are film language, not replacement product controls.
- Verify source parity separately from cinematic framing. Sample the typing run densely, inspect transition boundaries, render out of order, then watch the full MP4.

