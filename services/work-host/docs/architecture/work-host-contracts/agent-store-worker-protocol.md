# Agent store worker contract

## Scope

This is Slate's private message contract between the host thread and its own agent-store worker. It is a typed local
protocol; it does not import or mirror the remote protobuf schema. Both ends use the same command and reply definitions,
and malformed messages are rejected at the thread boundary.

## Observable behavior

- A worker is keyed by its blob database path. Repeated calls for that store share one worker.
- Every command has a positive, increasing `callId`. Replies carry the same id, so concurrent calls may complete in any
  order without receiving each other's result.
- Unknown operations remain unanswered and leave the worker listener available. A recognized operation with an invalid
  envelope is answered as a failure when it carries a usable call id.
- Commands cover worker identity, blob read/write/clear, latest-root lookup, checkpoint pruning, garbage collection,
  legacy-retirement verification, flush, and close. A success reply echoes the operation; a failure keeps the error
  message, name, and string code.
- A worker exit rejects every request still waiting on that worker and removes it from the pool. The next store operation
  creates a new connection.
- An active operation retains its worker until it settles, including rejection. Capacity eviction and idle sweeping only
  close unretained workers; the least recently active worker is evicted first. An infinite idle timeout creates no timer.
- Close asks the worker to close its store and then terminates the thread. A worker that is already dead needs no close
  request.
- Forwarded output is line-bounded, flushes a final partial line, ignores empty lines, and does not propagate stream errors.

The host's contract tests exercise these cases with controllable workers; the worker integration tests exercise the real
thread and its store lifecycle.
