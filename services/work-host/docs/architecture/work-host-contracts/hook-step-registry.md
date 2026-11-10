# Hook step registry contract

Slate owns the hook step catalogue and the shape produced by hook configuration validation. The catalogue has 21 unique
steps; its validator table is exhaustive, so a new step must choose a response validator before it can compile.

Response validation is selected by step. Steps with the same response behavior share a validator, and an unknown step
received at runtime falls back to checking only that the response is an object. The registry separately identifies
steps that can add conversation context, steps that can refuse an action, and workspace lifecycle steps.

Foreign hook event names and matcher syntax are translated by the interop adapter. The registry and its step names are
Slate-owned and do not reuse the foreign configuration's event catalogue as our internal contract.
