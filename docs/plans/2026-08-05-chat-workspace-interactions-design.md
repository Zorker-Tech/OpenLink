# Chat Workspace Interactions Design

## Scope

Extend the authenticated chat workspace without changing the visual language established by Figma nodes `3:10307`, `3:10576`, `3:13035`, and `40:688`.

## Interaction model

### Chat panel

Use the shadcn Resizable primitives backed by `react-resizable-panels`. The chat panel starts at exactly 390px, cannot expand beyond 50% of the workspace content, and collapses when dragged below its 390px minimum. The toolbar comment button and the panel's imperative collapse/expand API share the same state, so both direct toggling and handle dragging stay synchronized. When expanded after a button toggle, the panel returns to 390px rather than an arbitrary previous width.

On screens below the existing desktop preview breakpoint, retain the current responsive contract: the preview is hidden and the chat panel occupies the available width. Resizing is only exposed when both chat and preview are visible.

### Preview mode

Keep the current phone frame as the initial state. The device toolbar button toggles between:

- `mobile`: centered 391px × up-to-835px preview with 12px radius and the existing border/shadow.
- `browser`: preview fills the available panel with no artificial device frame, matching Figma node `40:688`.

Reuse the installed AI Elements `WebPreview` and `WebPreviewBody` behavior while overriding their presentation with the existing OpenLink tokens and exact Figma geometry. The toolbar styling and address bar remain unchanged.

### Composer

The single-line state remains the exact 373px × 42px structure from node `3:10576`: 6px padding, a 20px text line, then 28/28/48/28px controls.

When the textarea content wraps or contains a newline, transition the same PromptInput into the node `3:13035` structure: column layout, 12px padding, at least 108px total height, a minimum 54px text area, and a bottom action row. The textarea can continue growing naturally up to the existing 330px content limit. Clearing or submitting returns it to the compact state.

## Considered approaches

1. **shadcn Resizable (selected):** accessible, keyboard-operable, supports imperative collapse and min/max constraints.
2. **Custom pointer handlers:** fewer dependencies, but requires rebuilding accessibility, keyboard behavior, and drag edge cases.
3. **CSS `resize`:** smallest implementation, but cannot coordinate toolbar state or reliably enforce collapse and 50% limits.

## Verification

- Compare compact and expanded composer dimensions against the two Figma screenshots.
- Verify comment-button collapse, handle collapse, 390px restore, and 50% maximum.
- Verify device mode toggles without changing toolbar geometry.
- Verify desktop and sub-`lg` responsive layouts.
- Run production build, diff whitespace checks, browser console checks, and interaction tests.
