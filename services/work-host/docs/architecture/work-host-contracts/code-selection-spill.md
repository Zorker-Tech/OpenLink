# Code selection spill contract

Selected code stays inline unless spill is enabled and its content exceeds 20,000 characters. A successful spill writes
UTF-8 content below `uploads/` in the project folder when present, otherwise below the first workspace path. The
filename contains a sanitized original stem, line range, selection index, and a usable extension; extensionless names
use `.txt`.

The spill port returns the written path only after the workspace write succeeds. Missing context, a missing write
accessor, or a rejected write returns no path, allowing the renderer to keep the full selection inline. A failed write
is logged. The Slate-owned port supplies a path and bytes; the interop adapter alone builds the remote write request,
copies the byte array, and disables content-after-write responses.

The renderer preserves selection order and emits one prompt block per selection. A spilled block names both the
original source and the saved file; a non-spilled block includes the source path and line range. Notebook selections
are not line-numbered a second time.
