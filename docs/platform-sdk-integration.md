# Cloud VTSLX Computer and Pi integration

OpenLink Cloud uses `@vtslx/platform-sdk@0.2.6` to connect a user's linked
Hydite Studio account to the selected Studio project's Computer. OpenLink Host
owns chat sessions and Pi RPC; the SDK supplies the project-authorized
Computer stream, terminal transport, heartbeat, event stream, cancellation and
checkpoint recovery.

## Request path

1. The authenticated OpenLink BFF verifies the Cloud connection and the
   OpenLink-to-Studio project link, checks the user's Studio project access,
   and obtains a short-lived token with `computer:read` and `computer:write`.
2. The loopback-only Cloud Computer Host verifies the Studio subject with
   `userinfo`, then opens or resumes the Computer stream and the Pi RPC session
   for that OpenLink chat session. The token is sent only to this local Host;
   it is not sent to the browser or stored in chat history.
3. Pi JSONL records pass through the existing chat event adapter. OpenLink
   stores the normalized events and Pi session snapshot in the Cloud Supabase
   project. The Host keeps the Computer session warm and stores encrypted,
   user/project/session-bound reconnect checkpoints on disk.
4. Cloud chat creation selects Pi and obtains model choices from the Computer's
   Pi RPC. Cloud mode does not require a Local provider configuration or route
   a request to the Local Agent Host. The Local path remains unchanged.

The Cloud Computer Host is started by `scripts/dev-browser.mjs` only for the
Cloud profile. It binds to loopback and does not start Local Agent workers,
Browser services, Podman, or Project VMs. Local mode does not start or contact
this Host.

## Package and configuration

The root dependency and lockfile pin `@vtslx/platform-sdk@0.2.6`. The downloaded
Nexus artifact is recorded in `packages/platform-sdk/manifest.json` with
SHA-256 `2faddf8bc54c881295c6b612fa5e7d167b93aa067a00357196087cdd50387589`
and its registry-matching SHA-512 integrity. The LAN OAuth callback patch is
kept version-specific at
`patches/@vtslx__platform-sdk@0.2.6.patch`.

Cloud startup provisions a protected internal Host token and a 32-byte
checkpoint encryption key in the local OpenLink state directory when the
corresponding environment values are empty. Deployments must provide stable
shared key material and durable checkpoint storage if Host processes can move
between machines. The Host URL must remain loopback for the source-checkout
supervisor.

## Runtime requirements and limits

- The VTSLX Worker must grant the selected project the `terminal` capability
  for Pi RPC. This is currently feature-gated on the Worker; publishing the
  SDK does not enable it.
- File and image attachments also require the Worker `files` capability. The
  current SDK limits one Workspace write to 32 KiB, so larger binary
  attachments are rejected with a visible chat error until chunked file upload
  is supported end to end.
- Cloud Pi currently supports status, interrupt, steer, follow-up through the
  authenticated session control endpoint, model selection, and reconnect. Local-only execution modes,
  rewind/edit, and controls without a Pi RPC equivalent are not silently
  mapped to different Cloud behavior.
- The source integration has not had a full browser-to-Worker runtime smoke in
  this change. Automated tests, production build, and Worker capability
  enablement were not run here.

Never fall back from a Cloud Computer error to Local execution, and never pass
Studio OAuth credentials to browser code or a global SDK token store.
