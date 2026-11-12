# @zorker/avatar

The OpenLink UI package for procedural Bot avatars. It is the product-facing
integration of `git@git.haokir:hydite/openlink/avatar-editor` and keeps the
upstream render engines unchanged.

```tsx
import { AgentAvatar, COLORS, SHAPES } from '@zorker/avatar'

<AgentAvatar
  renderer="complete"
  shape="blob"
  color="orange"
  state="idle"
  theme="auto"
  size={32}
/>
```

## Renderer contract

- `complete` is the default product form. Bot rows, headers and transcripts
  use it so the same identity is visible everywhere in the workspace.
- `3d` is the selection/display form. It shares the complete flat/stem core
  and adds yaw/pitch view rotation, drag inertia and view presets.
- `25d` and `svg` remain available for tooling, previews and small surfaces.

The avatar identity is `(shape, color)`. State, expression and view are
presentation inputs, not persisted Bot identity. `getPngDataUrl()` renders a
static complete-form image for Work-host avatar storage; the UI continues to
render the live complete form from `(shape, color)` so a lost avatar blob never
breaks the Bot surface.

## Upstream

See [`UPSTREAM.md`](./UPSTREAM.md) for the imported commit and the exact
upstream paths. The engines are dependency-free SVG renderers; no WebGL,
network access or runtime asset download is required.
