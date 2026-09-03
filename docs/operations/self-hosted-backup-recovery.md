# Self-hosted backup and disaster recovery

## Authority and recovery objectives

ZOKERBASE PostgreSQL and Storage are authoritative product data. Project
workspaces and Project VM state are authoritative execution state. Zero is a
projection where its source records remain available, but including it in a
complete backup reduces recovery time. A single-node backup is not disaster
survival until it is copied off-host and off-site under an independent
credential and retention policy.

Deployment owners must set explicit RPO/RTO values. The initial complete backup
implementation is quiesced: it refuses to run while the runtime lock has a live
owner. This prioritizes consistency and yields a maintenance window; it does
not yet claim zero-downtime backup.

## Create and verify a backup

Stop the native service and wait for it to report stopped. Then run:

```sh
/opt/openlink/current/bin/openlinkctl backup \
  --config /etc/openlink/openlink.env \
  --output /var/backups/openlink/openlink-<timestamp>.olb
```

The command captures the state root plus `openlink.env` and `secrets.env`,
excluding the transient runtime lock. The payload is encrypted with AES-256-GCM
using a key derived with scrypt from the protected backup key. Its adjacent JSON
manifest records ciphertext size and SHA-256, salt, nonce and authentication
tag. Success is reported only after the encrypted payload, manifest and parent
directory entries have been fsynced and the payload has been hashed.

The backup key is deliberately not inside the backup. Escrow it separately;
losing it makes recovery impossible, while storing it beside every backup
removes the separation the encryption is meant to provide.

## Clean-root restore

Restore requires empty/nonexistent targets and a separately supplied key:

```sh
openlinkctl restore \
  --archive /secure-restore/openlink-<timestamp>.olb \
  --manifest /secure-restore/openlink-<timestamp>.olb.json \
  --key-file /secure-restore/backup.key \
  --state-root /var/lib/openlink \
  --config /etc/openlink/openlink.env \
  --secrets /etc/openlink/secrets.env
```

Restore checks the ciphertext digest and size, authenticates the complete AEAD
payload, safely extracts only regular files/directories with traversal and
symlink rejection, confirms all required roots exist, then publishes into the
fresh destinations. Any failure removes partial restore outputs.
The restored regular files and directory tree are fsynced before success is
reported, so a successful restore means published state is durable rather than
only present in the page cache.

After restore: install a release compatible with the recorded state schema,
run `preflight`, start the native service, exercise login/project/browser/data
checks, and record the achieved RTO. A scheduled restore drill on a replacement
host is mandatory; an untested backup is not counted as recoverable.

## T0 retention profile

- Keep at least one local operational copy, one off-host copy and one off-site
  immutable copy.
- Use separate credentials and administrative roles for production and backup
  storage.
- Retain the public release trust root, compatible native bundle and backup key
  in an offline recovery kit.
- Alert on missed backups, digest/authentication failure, insufficient space,
  stale recovery drills and clock drift.
- Test loss of the entire host, not only loss of a process or container.

Multi-site replication, quorum databases and automatic traffic failover belong
to the later multi-node control plane. They complement backups; they do not
replace them.
