# ADR-0036: Bot runtime control plane on Work-host

## Status

Accepted. Supersedes [ADR-0035](./ADR-0035-bot-work-host-integration.md).

## Context

Code mode is request-driven. A user opens a chat, the BFF leases a Code
session from the Agent Host, the Agent Host materialises an OpenSandbox and a
Pi worker inside the Project VM, and an idle reaper releases that session when
the request window ends. That lifecycle is correct for interactive coding and
must remain unchanged.

Bots are not request-driven. A Bot is a persistent agent that owns standing
orders, routines, event subscriptions, background work and recovery across
user absence. The Work-host domain already owns those concepts: agents,
transcripts, run queues, watchdogs, automations, groups, boxes and recovery.
Its state-ownership rule is explicit: agents, transcripts, automations, rooms,
boxes and gateway lifecycle are persisted in the Host and must not be modelled
as options on a chat session.

The Agent Host does not provide that domain. It has a 30-minute default
session idle TTL, a 15-minute prompt settle bound, a single active prompt per
session, and no durable automation, group fan-out or proactive wake model. A
Bot built on the Code lease therefore inherits Code's passive lifecycle, loses
work while the user is away, and cannot express group or routine semantics.

The shared substrate is still valuable. Both surfaces need the same Ubuntu
Project VM, per-session OpenSandbox isolation, Pi worker image, desktop,
browser, shell and file primitives. The correct boundary is to share the
substrate while keeping the control planes and their protocols separate.

## Decision

1. **Work-host owns the Bot control plane.** Bot identity, profiles, avatars,
   transcript authority, run scheduling, automation triggers, group turns,
   box lifecycle and recovery live in Work-host. The Next.js BFF reaches them
   only through the authenticated Work-host gateway.

2. **Agent Host remains the Code control plane.** Code mode keeps its existing
   session lease, prompt/event stream, idle reaper, desktop gateway and
   transcript projection. No Bot-specific branch is added to that path.

3. **The execution substrate is shared; the protocol is not.** A Bot and a
   Code chat may run in the same Ubuntu Project VM and use the same
   OpenSandbox control plane and Pi worker image. They do not share session
   identity, lease/event protocol, idle cleanup policy, transcript authority or
   turn scheduling. A Bot session is never represented as a hidden Code chat
   session.

4. **One Bot, one OpenSandbox.** Work-host exposes a `BotBoxProvider` port. For
   a Bot turn it ensures exactly one OpenSandbox keyed by the Bot's stable
   identity inside the Project VM, maps that sandbox's desktop to the Bot
   computer surface, and releases it only under Work-host's own lifecycle
   policy. A group has no box of its own; each member Bot uses its own box.

5. **Pi remains the in-VM agent.** Work-host exposes a `PiBotRunner` adapter
   that implements the Host runner contract but executes turns through Pi RPC
   inside the Bot's OpenSandbox. Work-host retains its run queue, watchdog,
   transcript settlement, automation wakes and group orchestration above that
   adapter.

6. **Bot turns enter through Work-host.** The Bot prompt route persists the
   user entry, calls the Work-host gateway's `sendPrompt`, and projects the
   resulting events into the Bot timeline. It does not call the Agent Host
   lease or the Code event handler.

7. **Legacy Bot sessions are migration input only.** Existing
   `surface = 'bot'` chat sessions and their event logs may be read to seed a
   Bot transcript and recover historical state. New Bots do not create them,
   and Bot execution never depends on them after migration.

8. **Isolation and authority are per Bot.** A Bot sandbox, capability token,
   transcript, run queue and routine namespace are scoped to one Bot and one
   workspace. A group turn may read its members' group-visible replies but may
   not read their private DM timelines. Service tokens never reach the browser.

9. **Recovery is durable and idempotent.** Work-host persists accepted turns,
   delivery state, automation fires and group turn progress before dispatch.
   A restarted Host reattaches or recreates the Bot sandbox, resumes pending
   work, and never reports a turn as complete without a settled Pi result.
   Prompt acceptance is idempotent by client nonce; retries are bounded and
   observable.

## Implementation

- **Bot runtime key.** A Bot's execution identity is `bot-<botId>`, derived
  from the durable `openlink.bots` row. New Bots never create a
  `chat_sessions` row. A legacy `runtime_session_id` is read only to seed the
  Work-host transcript during migration.
- **Substrate boundary.** The shared execution layer exposes
  `POST /v1/substrate/bots/:key/ensure`, `POST /v1/substrate/bots/:key/desktop`
  and `DELETE /v1/substrate/bots/:key`. These routes accept only an opaque Bot
  key, never a Code session, and are authorized by a separate
  `OPENLINK_SUBSTRATE_API_TOKEN`. The Code control-plane token is not given to
  Work-host.
- **Bot box provider.** Work-host's `BotBoxProvider` owns the Bot binding
  (`bot-runtime.json` beside the agent store), ensures one OpenSandbox per Bot,
  keeps worker credentials on the host, and returns only a desktop capability.
  The binding is recoverable by calling `ensureBotBox` again; a corrupt or
  missing file is treated as absent.
- **Pi runner.** Work-host selects `PiBotRunner` for an agent with a Bot
  binding. It uses the host's run queue, acceptance ledger and transcript
  settlement, but executes the turn through the shared Pi worker's
  `/v1/events` stream. Streamed text is an outline preview; the turn is
  delivered as one `send-message` with the final assistant text. Pi dialogs
  become durable `bot-question` widgets and are answered through
  `respondBotExtensionUi`, which reaches the waiting worker directly.
- **Bot prompt stream.** `POST /api/bot/sendPrompt` accepts the turn durably in
  Work-host and streams only that Bot's transcript, outline, turn-lifecycle and
  group-lifecycle frames. A client disconnect stops the projection, not the
  turn.
- **BFF projection.** The Bot page warms through `ensureBotBox`, reads its
  computer through the Bot box status, prompts through the Bot stream, and
  answers questions through the Bot extension command. It does not call the
  Code lease, prompt handler or desktop endpoint.

## Failure and recovery

- If the Project VM is unavailable, the Bot row and transcript remain valid.
  Work-host marks the run retryable and retries provisioning with bounded
  backoff; it does not synthesise a reply or a desktop.
- If a Bot sandbox is lost, Work-host recreates it from the Bot identity and
  the durable transcript, then resumes pending work. Group membership and
  routines are unaffected.
- If one group member fails, that member's turn is recorded as failed or
  passed and the remaining members continue. A group turn never blocks on a
  dead member.
- If Work-host restarts, the gateway stream reconnects from the last durable
  cursor and the transcript remains the recovery source. A partially delivered
  assistant message is reconciled from the settled turn, not duplicated.
- If a Bot binding is stale after a substrate or Work-host restart, the BFF
  re-ensures the box before every prompt and before opening the computer. The
  ensure is idempotent: it reattaches the existing sandbox or recreates it
  under the same Bot key, then refreshes the binding.
- If Work-host is unavailable, Bot reads surface a retryable error and writes
  are rejected before durable acceptance. Deletion remains idempotent.

## Consequences

- Code mode and Bot mode can evolve their lifecycle independently without
  forking the VM image or the Pi worker.
- Work-host becomes the authority for Bot liveness, automation and groups;
  the BFF is a projection and authorization layer.
- A Bot keeps working while no browser is connected, subject to Work-host's
  own resource policy rather than Code's idle timer.
- The Bot computer is a first-class Work-host box backed by an OpenSandbox,
  not a Code desktop lease borrowed through a hidden session.

## Alternatives considered

- **Keep Agent Host as the Bot control plane.** Rejected: its request-scoped
  lease, idle reaper and single-prompt session model cannot express proactive,
  group or long-running Bot work without duplicating Work-host.
- **Give every Bot a separate VM.** Rejected: it multiplies provisioning and
  recovery cost and prevents sharing the Project VM substrate the product
  already operates.
- **Run Work-host's loopback in-box computer for Bots.** Rejected: it does not
  provide per-Bot OpenSandbox isolation or the shared Ubuntu desktop contract.
- **Share one Bot session protocol with Code.** Rejected: it couples passive
  chat cleanup to proactive agent life and makes a Code change a Bot outage.
