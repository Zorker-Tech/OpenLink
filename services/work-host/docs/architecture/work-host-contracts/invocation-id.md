# Invocation ID contract

An invocation ID distinguishes separate executions of one request. The request's own counter starts at zero and advances
for each run; another request has an independent counter. Each ID also carries a four-character lowercase alphanumeric
suffix so different processes do not depend on the counter alone. The process keeps at most 100,000 request counters in
an LRU cache.

Context consumers use `getInvocationId`. Its default generator returns a UUID, while tests and replay tools can install a
context-local generator for deterministic results.
