# 08 — Release versioning

Status: binding
Owner: runtime architecture

OpenLink has one product version, two codename release channels (stable and
preview), and the E1 compatibility line. The version number is shared; the
architecture and codename identify the channel and support contract.

## Format

For the stable and preview T1/T2 architectures:

```text
<architecture>-<codename>-<semver>
```

Examples for the current product version `0.0.1`:

| Architecture | Channel | Codename | Release |
| --- | --- | --- | --- |
| T1 | stable | Crab | `T1-Crab-0.0.1` |
| T2 | preview | Orion | `T2-Orion-0.0.1` |
| E1 | compatibility | none | `E1-0.0.1` |

E1 is the retained legacy isolation architecture. It is not part of the
T1/T2 stable/preview pair and does not receive a Crab/Orion codename.

## Source of truth

- `VERSION` contains the shared semantic version.
- `release-version.json` contains the architecture/channel/codename/release
  mapping.
- `scripts/lib/release-version.mjs` is the programmatic accessor used by tests
  and tooling.
- `package.json` version must equal `VERSION`.

Changing a version requires updating all of the above in one change.

## Rules

1. T1 and T2 share `major.minor.patch`. There is no independent T2 version.
2. A version bump is released for both channels in the same release train;
   T2 may ship additional preview-only features, but its version number still
   matches T1.
3. The codename identifies the channel contract, not the version:
   - `Crab` is the stable, default T1 line;
   - `Orion` is the preview T2 line;
   - E1 remains the compatibility line.
4. `T1-Crab-0.0.1` and `T2-Orion-0.0.1` are the canonical display names. Use
   them in status output, artifacts and operator documentation.
5. Preview T2 has no stability or migration SLA; data migration is supported
   by the one-command switch but preview behavior may change between versions.
6. A release is not valid unless `runtime:architecture:test` passes and the
   release metadata is committed atomically.
