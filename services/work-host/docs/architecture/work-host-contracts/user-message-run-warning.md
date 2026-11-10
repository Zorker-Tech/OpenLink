# Trailing user-message warning contract

At the start of a turn, the host emits one warning only when the latest message has the user role and more than three
real user messages occur at the end of the conversation without an assistant reply. Summary markers and notification-
only messages do not count toward that threshold. Assistant distance is the number of messages after the nearest
preceding assistant, or `-1` when the history has none.

The warning includes the total real trailing-message count, invocation ID, threshold, and the roles in the last twelve
messages. Within that same window it counts provider message and request IDs, their distinct values, and whether each
kind is duplicated. The host receives those IDs through an interop reader; other provider metadata does not enter the
warning contract.
