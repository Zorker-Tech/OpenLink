# Local exec

The local execution daemon contract.

Local exec is a **separate process** with its own lifecycle, identity and readiness record. It
is not a helper inside the host process, because Work agents must keep running when a client
exits and must be restartable independently.

Contract requirements: signal-driven drain, generation-stamped process identity (a PID alone
never proves identity), realpath-validated workspace roots, bounded output and timeouts, and
crash handling that records why it died.
