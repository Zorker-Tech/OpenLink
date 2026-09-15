# Inline message editing implementation plan

**Goal:** Click the original user message to edit and resend in place, with a centered floating dashed-border editor; keep session commands exclusively in slash suggestions.

**Architecture:** Preserve message identity with append-only revision receipts. Project revisions into the active conversation by replacing the target turn and its descendants. Under the existing session lease, confirm native context rewind before accepting a revision. Fail closed when the native target is ambiguous or unavailable. Never roll back workspace files.

**Tech Stack:** React, Next.js route handlers, existing Supabase event journal, Codex/Pi runtime controls.

1. Update `components/chat-timeline.tsx` with click/keyboard activation, local draft, cancel/error/pending states and an in-place editor. Remove the independent edit button and composer-copy event listener.
2. Remove the redundant session-control row in `components/chat-workspace.tsx`; retain slash-command dispatch and status/error feedback.
3. Add revision projection and tests, wire `editMessageId` through the existing submission endpoint, validate the durable target under the lease, and invoke native rewind before the durable replacement receipt.
4. Add native rewind control to Host/Worker, with unambiguous native user-message lookup and no fallback to ordinary submission.
5. Run targeted tests/type checks; verify click, dashed centered editor, cancel, slash suggestions and resend/readback in the user's browser session. Report runtime deployment limitations separately from source/test results.

Existing uncommitted work must be preserved. No automatic commits or database deletions.
