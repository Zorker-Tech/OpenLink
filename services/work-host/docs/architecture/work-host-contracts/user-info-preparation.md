# User-info preparation

## Rebuild decision

The first user message is the authority for what the model saw. User info is rebuilt only when that message is a user message containing the user-info block and a relevant session surface changed: force refresh, available subagent descriptions, dynamic tool snapshot, or generated user-rule content. Reflowed whitespace alone does not invalidate generated rules.

## Persisted metadata

The first user-info block carries context completeness, summarization epoch, cloud-worker omission and cloud-testing placement. Readers reject malformed or incomplete metadata rather than guessing. A summary marker is searched across all messages. The mode used for the multitask-reminder migration is projected from the wire enum at the interop boundary into Slate-owned booleans.

## Multitask reminder migration

The reminder moves into user info only when a non-system conversation stayed in multitask mode across turns, a summary carrier exists, the first user-info block exists, and that block does not already contain the reminder.

## Verification

`tests/packages/agent-user-info-refresh-plan.test.ts` covers refresh and reminder planning; `agent-action-handlers.test.ts` covers persisted metadata reads and handler integration.
