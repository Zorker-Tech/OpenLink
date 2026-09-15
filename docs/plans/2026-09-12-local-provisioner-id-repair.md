# Local provisioner repair and acceptance

Scope: local OpenLink only. Preserve the complete composer parity matrix. The user authorizes real conversation tests with `deepseek-v4.1-flash`; do not substitute an unapproved model.

1. Preserve valid identities; normalize invalid legacy identities deterministically with SHA-256 and an alphabetic prefix. Generate new supervisor identity seeds as hex. Match queue validation to the existing database constraint without weakening it.
2. Add regression coverage for invalid prefixes, underscores, length, restart stability, execution-mode separation, and the actual claim payload. Avoid logging database row details containing lease material.
3. Build/test Agent Host, restart only the local supervisor, and observe the real Draft move beyond queued with a committed attempt and Project VM startup. Do not force readiness or reset project data.
4. Continue the original local end-to-end matrix using the existing signed-in workspace and user-authorized model. Component tests do not prove full runtime acceptance.

## Verified progress

- Host identity repair is live. The original Draft moved from `queued / 0` to `starting_vm / 1`, then successfully booted its VM and project database. No manual ready projection or queue reset was used.
- Startup then failed on six absent runtime image archives. Restored only the missing archives via same-volume clones from the existing local qualification release, validating each source against its inventory SHA-256. Preserved the newer September 9 Agent Worker archive. Restored dependencies are older packaged artifacts and are not proof of current source/image parity.
- Attempt 3 reached `starting_agent_services` with a live lease and observed `podman load`/SCP processes. Full project readiness and real conversation acceptance remain unproven.
- Fresh validation: root 292 tests (291 pass, 1 privileged Linux skip), Host 115/115, provisioner 11/11, Storybook 32/32 (serial worker run). Two story timing races were fixed by waiting for the real menu-close and input-clear states before the next interaction.
- The local signed-in account already has `deepseek-v4.1-flash` enabled under `opencode-go`; it is selected in the browser. No prompt has yet been sent in this resumed run.

## Capacity gate

During real image import the host volume fell from about 6 GiB free to under 500 MiB. The guest `/var` still had ample logical space, but its sparse disk consumes the nearly full host volume as layers are written. This is a separate host-capacity constraint, not the repaired scheduler identity failure. The local supervisor was sent SIGTERM and the scoped Project VM was asked to power off; after the SSH shutdown did not finish promptly, its verified vfkit process was sent SIGTERM to prevent further volume exhaustion. Project disks and user files were not deleted. Complete runtime/real-dialog acceptance requires additional host capacity; do not mark the goal complete or force ready state. No real model request has been sent yet.
