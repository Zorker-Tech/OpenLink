# Simulated message prompt assembly

Slate's prompt core accepts its own optional git-action instruction, optional multitask instruction, and model profile.
It emits only instructions that have content, preserves the git-action-before-multitask order, and returns text parts; an
unrecognized or incomplete source does not create a placeholder.

The interop adapter alone interprets generated simulated-message reasons and selected git-action variants. It projects
them into the core inputs; the core does not read generated enum or context types. Model-specific task tool naming is
resolved before the multitask instruction is built.
