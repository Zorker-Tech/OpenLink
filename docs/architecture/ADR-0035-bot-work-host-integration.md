# ADR-0035: Bot domain on Work-host with Code-mode computers

## Status

Accepted

## Context

OpenLink already has a durable Code-mode execution path: a Project owns one
Ubuntu Project VM, each chat session owns an OpenSandbox workload inside that
VM, Pi runs inside the workload, and the Agent Host exposes the session's
desktop through a scoped gateway. The Bot surface needs persistent agent
identity, avatars, transcripts and a computer, but it must not create a second
VM or sandbox lifecycle that diverges from Code mode.

The imported `services/work-host` service already owns the Work domain:
agents, profiles, avatars, transcripts, runs, automations, workflows, rooms,
channels and boxes. It is a local-first Node service with a loopback,
authenticated gateway and per-agent SQLite stores.

## Decision

1. **Work-host is the Bot domain authority.** The Next.js BFF uses the
   loopback Work-host gateway for Bot agent creation, profile updates, avatar
   bytes and transcript reads/writes. The Work-host service token never leaves
   the server trust boundary.

2. **ZOKERBASE is the workspace projection.** `openlink.bots` stores the
   owner, workspace, display metadata, selected model and the durable mapping
   to one Work-host agent and one hidden chat session. `chat_sessions.surface`
   defaults to `code`; Bot sessions use `surface = 'bot'` and are excluded from
   the Code-mode history list.

3. **Code mode remains the execution and computer authority.** A Bot's
   `runtime_session_id` is the same 11-character chat session identity Code
   mode uses. The Agent Host provisions the Project VM, per-session
   OpenSandbox, Pi worker and desktop from that identity. The Bot computer
   pane is the session desktop gateway, not a Work-host box.

4. **Avatar rendering is a UI package.** `@zorker/avatar` vendors the
   avatar-editor engines. The complete form is the default everywhere in the
   workspace; the 3D form is used for selection and the initialization
   turntable. `(shape, color)` is the durable identity, so a missing avatar
   blob falls back to the live complete renderer or the deterministic SVG
   fallback.

5. **Initialization is real.** Creating a Bot first commits the durable
   projection and Work-host agent, then calls the Agent Host lease to
   materialise the Pi worker, OpenSandbox and desktop. The onboarding 3D
   turntable runs until that call succeeds. A failed initialization leaves the
   durable Bot intact, exposes a retry, and never reports a fake ready state.

## Failure and recovery

- Work-host is supervised independently. A crash restarts it against the same
  data root with bounded exponential backoff; a repeated failure fails the
  application closed rather than serving a half-live Bot surface.
- If a Work-host agent store is lost, the BFF recreates the agent from the
  durable `openlink.bots` row and replays the Bot transcript from the
  Code-mode chat event log. The hidden chat session and its OpenSandbox/Pi
  state are not recreated by this repair.
- If Work-host is temporarily unavailable, Bot reads surface a retryable
  error and the projection preview is not allowed to turn a durable message
  into a failed turn. Deletion is idempotent and does not require Work-host to
  be online.
- If the Agent Host or Project VM is unavailable, the Bot row remains valid;
  the next warm/lease or prompt retries provisioning. No fake desktop or
  transcript is synthesized.

## Consequences

- Bot and Code mode share one VM/sandbox lifecycle and one Pi execution path.
- Work-host owns the Bot conversation domain while OpenLink owns workspace
  authorization and the projection. There is exactly one authority for each
  piece of state.
- Work-host's runner/box implementation is not used for Bot execution. The
  Bot computer is the Code-mode session desktop. This keeps Pi as the only
  in-VM agent and avoids a second tool/runtime contract.
- Work-host automations/workflows remain available to future Bot surfaces
  through the same gateway, but the current Bot UI only exposes the existing
  deterministic chat/computer/avatar surface.

## Alternatives considered

- **Run Work-host's own runner and box for Bots.** Rejected: it would create a
  second VM/box lifecycle and a second agent tool contract, diverging from the
  accepted Code-mode Project VM and Pi boundaries.
- **Store the full transcript only in Work-host.** Rejected: a local SQLite
  loss would erase the user-visible history. The Code-mode event log is the
  recovery source.
- **Store Bot state in Next.js.** Rejected: violates the privileged-runtime
  boundary and the requirement that Work-host own the Work domain.
