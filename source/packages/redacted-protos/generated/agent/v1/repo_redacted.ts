// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { RepositoryIndexingInfo } from "../../../../proto/generated/agent/v1/repo_pb.ts";

function toRedactedRepositoryIndexingInfo(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    relativeWorkspacePath: createRedactedString(msg.relativeWorkspacePath, DataClassification.PATH, "relative_workspace_path", privacyMode),
    remoteUrls: msg.remoteUrls.map((v2) => createRedactedString(v2, DataClassification.PATH, "remote_urls", privacyMode)),
    remoteNames: msg.remoteNames.map((v2) => createRedactedString(v2, DataClassification.PATH, "remote_names", privacyMode)),
    repoName: createRedactedString(msg.repoName, DataClassification.PATH, "repo_name", privacyMode),
    repoOwner: createRedactedString(msg.repoOwner, DataClassification.PATH, "repo_owner", privacyMode),
    isTracked: msg.isTracked,
    isLocal: msg.isLocal,
    orthogonalTransformSeed: msg.orthogonalTransformSeed,
    workspaceUri: createRedactedString(msg.workspaceUri, DataClassification.PATH, "workspace_uri", privacyMode),
    pathEncryptionKey: createRedactedString(msg.pathEncryptionKey, DataClassification.CREDENTIALS, "path_encryption_key", privacyMode),
  };
}

function fromRedactedRepositoryIndexingInfo(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new RepositoryIndexingInfo({
    relativeWorkspacePath: msg.relativeWorkspacePath.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    remoteUrls: msg.remoteUrls.map((v2) => v2.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing })),
    remoteNames: msg.remoteNames.map((v2) => v2.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing })),
    repoName: msg.repoName.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    repoOwner: msg.repoOwner.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    isTracked: msg.isTracked,
    isLocal: msg.isLocal,
    orthogonalTransformSeed: msg.orthogonalTransformSeed,
    workspaceUri: msg.workspaceUri.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    pathEncryptionKey: msg.pathEncryptionKey.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

export {
  toRedactedRepositoryIndexingInfo,
  fromRedactedRepositoryIndexingInfo,
};
