# Subagent type and state boundary

Subagent lookup uses Slate-owned normalized names: casing and separators do not matter, one recognized type suffix is
removed, and the historical media-review name remains searchable as video review.

The generated subagent type union is interpreted only by the interop adapter. It maps supported variants to Slate's
names, merges the two shell variants, and identifies both media-review and video-watch variants as one capability
family. The generated conversation state also stays at that boundary: a caller's state is not inherited implicitly;
the adapter returns a fresh empty state unless the config supplies a mapper.
