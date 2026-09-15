# Zorker OpenLink English demo implementation plan

**Goal:** Deliver a 60-second, 1920×1080, 30fps English MP4 and editable Remotion source.

**Architecture:** Isolated `video/zorker-openlink-demo` project. Snapshot selected real presentation components and semantic styles, replace service/state coupling with frame props, and compose a single illustrative site-building journey. No application business logic changes, no live provider requests, no publication.

**Tech stack:** Remotion 4.0.521, React, original SVG brand assets, original application CSS tokens, deterministic fixtures.

## Brief and narrative

Brand: Zorker. Full product name: Zorker OpenLink. English throughout. Audience: builders evaluating an agent workspace. Primary action: start a project with a clear prompt. Restrained monochrome editorial direction, electric-blue sample website, stable reading holds, focus-based camera movement. Music-free and voiceover-free; no asset purchases or paid generation.

## Shot plan (half-open frames, 30 fps)

| Frames | Purpose / state | Camera / anchors | On-screen English | Evidence / acceptance |
| --- | --- | --- | --- | --- |
| 0–150 | Brand introduction | Mark and wordmark hold; text reveal | Zorker OpenLink / From an idea. Into a working project. | Original supplied SVGs; title readable |
| 150–450 | Input / submit | Composer close-up into workspace | Start with what you want to build. | `workspace-prompt.tsx` presentation extraction; Local only; explicit demo data |
| 450–780 | Agent feedback | Stable task panel | Follow the work as it happens. | Task/file/command surfaces; synthetic events not benchmark claims |
| 780–1140 | Result / inspection | Pull back to browser, then code | Preview the result. Inspect the changes. | Browser/code views in `chat-workspace.tsx`, `ChangeItem` in timeline; fictional site fixture |
| 1140–1560 | Edit original / resend / result | Focus on original message then return to result | Refine the idea, right where it started. | `EditableUserMessage`; preserve dashed editor, warning, message ID; no file rollback claim |
| 1560–1800 | Product / CTA | Settled brand end card | Your next idea starts here. / Zorker OpenLink | 8-second end hold; no invented domain |

## Implementation and verification

1. Scaffold isolated Remotion project and pin dependencies. Preserve the existing dirty application worktree.
2. Add reproducible presentation extraction script and SHA-256 provenance inventory; retain original component snapshots for comparison. English translation and inert handlers are disclosed adaptations.
3. Implement independently editable intro, journey, ending scenes. Use frame-only state and deterministic typing. All visible completion and result data is a fixture.
4. Run isolated typecheck and focused state/provenance tests; render static representative frames and transition boundaries. Compare re-rendered out-of-order frames.
5. Render MP4, inspect representative rendered images and media metadata, and preview full playback when available. Distinguish sampled QA from full playback review.
6. Deliver video, composition ID, reproducible commands, storyboard, provenance and verification record. No staging or commits of unrelated user files.
