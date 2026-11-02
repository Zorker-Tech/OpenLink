# 09 — Agent tool registry

Status: binding
Owner: runtime architecture

Project owners may install additional command-line tools inside the Project VM.
Those tools are exposed to agents through a project-scoped registry. The
registry is an explicit capability boundary: it does not mount the VM's PATH,
`/usr/local/bin` or package manager state into agent sandboxes.

## Registry layout

Inside the Project VM:

```text
/var/lib/openlink/agent-tools/
  manifest.tsv
  bin/<name>
  tools/<name>/<entrypoint>
```

The registry is mounted read-only into every T1/T2/E1 Project VM sandbox at:

```text
/openlink/agent-tools
```

`/openlink/agent-tools/bin` is prepended to the sandbox `PATH`. The registry
directory (`/var/lib/openlink/agent-tools`) is the only host path outside the
workspace/session mounts allowed by the OpenSandbox host-path policy.

## Manifest

`manifest.tsv` is tab-separated, one line per tool:

```text
name<TAB>entrypoint<TAB>description<TAB>usage<TAB>sha256
```

Fields contain no tabs or newlines. The SHA-256 is recorded when the tool is
registered. Agents discover the file with:

```bash
cat /openlink/agent-tools/manifest.tsv
```

## Registration

The Project VM contains `/usr/local/bin/openlink-agent-tool`:

```bash
sudo openlink-agent-tool add <name> <absolute-path> "<description>" "<usage>"
sudo openlink-agent-tool remove <name>
openlink-agent-tool list
openlink-agent-tool path
```

Registration copies a regular file into the registry and creates a wrapper in
`bin/`. The wrapper resolves the registry through
`OPENLINK_AGENT_TOOL_REGISTRY`, so the same tool works on the VM host and in a
sandbox. Symlinks are followed to a regular target; directories are rejected in
the current single-file format.

The tool must be self-contained or rely only on files available in the
workspace/session. Tools with external libraries or data should be installed in
the project workspace or added to the agent worker image instead.

## Lifecycle and ownership

- The Project VM owns the registry; it persists with the project disk.
- Agent Host installs the controller and creates the empty registry during
  project provisioning. It does not read or rewrite user tool entries.
- The one-command architecture switch exports `manifest.tsv`, `bin/` and
  `tools/` into `agent-tools.tar`, verifies its size and SHA-256, and replaces
  the target registry only after a complete extraction. The previous target
  registry is retained as `.agent-tools.migration-previous-<timestamp>`.
- Every session receives the registry read-only and an injected `agent-tools`
  skill describing the manifest and command.
- Removing or replacing a tool requires a new session to pick up the change;
  running sandboxes keep their existing read-only view.
- T1/T2 also inject the separate `agent-desktop` bridge for GUI automation.
  E1 uses its per-chat container desktop and does not receive that bridge, but
  still receives the CLI registry.

## Security

- Only the exact registry directory is whitelisted for host bind mounts.
- The registry is read-only in sandboxes; agents cannot modify it.
- Registration requires root inside the Project VM and sanitizes names and
  metadata.
- Tools run with the sandbox workload's existing capabilities and network
  policy; registration does not grant additional privileges.
- Do not put credentials in the registry. A tool is code, not a secrets store.

## Validation

A valid registry satisfies:

1. `openlink-agent-tool add` creates a wrapper and manifest entry.
2. The wrapper succeeds on the Project VM host.
3. A new Project VM sandbox resolves the tool through `PATH` and can read
   `manifest.tsv`.
4. Removing a tool removes its wrapper, bundle and manifest entry.
5. The OpenSandbox host-path policy rejects any unrelated VM path.
