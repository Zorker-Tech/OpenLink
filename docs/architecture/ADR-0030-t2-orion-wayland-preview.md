# ADR-0030 — T2-Orion Wayland preview architecture

Status: accepted
Date: 2026-11-02
Related: [ADR-0029](./ADR-0029-project-computer-t1-e1-modes.md),
[release versioning](./standards/08-release-versioning.md)

## Decision

Add T2 as the preview Project computer architecture on the latest Ubuntu
userspace (26.10) and GNOME 51. T2 is selected with `-t2`/`--arch=t2`; T1
remains the default and stable architecture.

T2 keeps one Project VM per project but changes the desktop transport route:

```text
GNOME Shell 51 headless Wayland
  → GNOME Remote Desktop RDP (loopback)
  → FreeRDP client
  → Xvfb :9
  → x11vnc
  → websockify/noVNC
```

The existing public Desktop Gateway remains unchanged. T2 uses a separate
Project VM state root and base artifact so it cannot overwrite T1 state.

## Rationale

- GNOME 51 no longer provides an X11 backend; T1's Xvfb/x11vnc path cannot
  render it.
- T2 exercises the latest Ubuntu/GNOME Wayland stack and the GNOME-supported
  remote desktop protocol.
- Keeping the RDP-to-VNC bridge preserves the existing Desktop Gateway and
  browser surface during the preview.
- T1 remains the stable path with the broadest compatibility and LTS support.

## Consequences

- T2 is resource-heavier and has more moving parts (Mutter, PipeWire, GNOME
  Remote Desktop, FreeRDP, Xvfb, x11vnc, websockify).
- T2 runs without Xwayland because GNOME Shell 51 headless Xwayland exits on
  the virtual GPU; X11 applications are not supported.
- Ubuntu Shell extensions that assume a GDM seat are disabled; T2 presents
  vanilla GNOME Shell.
- T2 is a preview channel with no stability SLA; the one-command migration
  supports T1↔T2 data transfer.
- Release naming is `T1-Crab-0.0.1` (stable) and `T2-Orion-0.0.1` (preview),
  sharing the version number.
