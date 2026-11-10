# Box supervisor contract

The box supervisor and host share a Slate-owned filesystem layout under `/tmp/slate-supervisor`. Command and staged
bundle writes use a sibling `.part` path; status, acknowledgement, desktop-health, agent-data, and host-version paths
are declared alongside it so each process uses the same values.

Every command carries its ID, kind, issue time, and optional reason. Only upgrade commands may carry mode, version,
bundle path, or `forceNow: true`; absent values are omitted from serialized JSON. A target version is available only
when it is present, nonempty, and different from the running version. The host may defer the upgrade for up to six
hours before it is no longer optional.
