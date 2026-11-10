# Hook configuration interop boundary

The normalized hook configuration (`HookConfig` and `HookScript`) is Slate-owned. Foreign hook event names, matchers,
and script shapes are read and converted only by the interop adapter; the hooks package surface exposes no foreign
parser or event catalogue.

The normalized result keeps Slate's versioned `hooks` map, uses Slate `HookStep` names, and records only command or
prompt scripts with Slate defaults. Callers that read external hook files import the interop adapter directly.
