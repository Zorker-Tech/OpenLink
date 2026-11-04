# Hook carrier spec

The hook registry says which Slate steps may add model context. The carrier catalog has exactly one entry per such
step and uses the same Slate event name. If a context-bearing step has no carrier entry, module initialization fails
instead of silently losing the response; the catalog does not contain steps that cannot carry context.
