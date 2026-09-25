// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { createRedactedBytes } from "../../../../redaction/create.ts";
import { ListMcpResourcesError, ListMcpResourcesExecArgs, ListMcpResourcesExecResult, ListMcpResourcesExecResult_McpResource, ListMcpResourcesRejected, ListMcpResourcesSuccess, McpArgs, McpImageContent, McpPermissionDenied, McpRejected, McpSuccess, McpTextContent, McpToolResultContentItem, ReadMcpResourceError, ReadMcpResourceExecArgs, ReadMcpResourceExecResult, ReadMcpResourceNotFound, ReadMcpResourceRejected, ReadMcpResourceSuccess } from "../../../../proto/generated/agent/v1/mcp_exec_pb.ts";
import { OutputLocation, SmartModeApproval } from "../../../../proto/generated/agent/v1/utils_pb.ts";
import { fromRedactedOutputLocation, fromRedactedSmartModeApproval, toRedactedOutputLocation, toRedactedSmartModeApproval } from "./utils_redacted.ts";

function toRedactedListMcpResourcesError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedListMcpResourcesError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ListMcpResourcesError({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedListMcpResourcesExecArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    server: msg.server,
  };
}

function fromRedactedListMcpResourcesExecArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ListMcpResourcesExecArgs({
    server: msg.server,
  });
}

function toRedactedListMcpResourcesExecResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedListMcpResourcesSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedListMcpResourcesError(oneof.value, privacyMode) };
    case "rejected":
      return { case: "rejected", value: toRedactedListMcpResourcesRejected(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedListMcpResourcesExecResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedListMcpResourcesSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedListMcpResourcesError(oneof.value, purpose, opts) };
    case "rejected":
      return { case: "rejected", value: fromRedactedListMcpResourcesRejected(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedListMcpResourcesExecResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedListMcpResourcesExecResult_result(msg.result, privacyMode),
  };
}

function fromRedactedListMcpResourcesExecResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ListMcpResourcesExecResult({
    result: fromRedactedListMcpResourcesExecResult_result(msg.result, purpose, opts),
  });
}

function toRedactedListMcpResourcesExecResult_McpResource(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    uri: createRedactedString(msg.uri, DataClassification.PATH, "uri", privacyMode),
    name: msg.name,
    description: msg.description !== void 0 ? createRedactedString(msg.description, DataClassification.CODE, "description", privacyMode) : void 0,
    mimeType: msg.mimeType,
    server: msg.server,
    annotations: new Map(Object.entries(msg.annotations).map(([k2, v2]) => [k2, createRedactedString(v2, DataClassification.CODE, "annotations", privacyMode)])),
  };
}

function fromRedactedListMcpResourcesExecResult_McpResource(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ListMcpResourcesExecResult_McpResource({
    uri: msg.uri.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    name: msg.name,
    description: msg.description?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    mimeType: msg.mimeType,
    server: msg.server,
    annotations: Object.fromEntries(Array.from(msg.annotations.entries()).map(([k2, v2]) => [k2, v2.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing })])),
  });
}

function toRedactedListMcpResourcesRejected(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    reason: createRedactedString(msg.reason, DataClassification.CODE, "reason", privacyMode),
  };
}

function fromRedactedListMcpResourcesRejected(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ListMcpResourcesRejected({
    reason: msg.reason.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedListMcpResourcesSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    resources: msg.resources.map((v2) => toRedactedListMcpResourcesExecResult_McpResource(v2, privacyMode)),
  };
}

function fromRedactedListMcpResourcesSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ListMcpResourcesSuccess({
    resources: msg.resources.map((v2) => fromRedactedListMcpResourcesExecResult_McpResource(v2, purpose, opts)),
  });
}

function toRedactedMcpArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    name: msg.name,
    args: new Map(Object.entries(msg.args).map(([k2, v2]) => [k2, v2])),
    toolCallId: msg.toolCallId,
    providerIdentifier: msg.providerIdentifier,
    toolName: msg.toolName,
    smartModeApproval: msg.smartModeApproval !== void 0 ? toRedactedSmartModeApproval(msg.smartModeApproval, privacyMode) : void 0,
    smartModeApprovalOnly: msg.smartModeApprovalOnly,
    skipApproval: msg.skipApproval,
    serverIdentifier: msg.serverIdentifier,
  };
}

function fromRedactedMcpArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpArgs({
    name: msg.name,
    args: Object.fromEntries(Array.from(msg.args.entries()).map(([k2, v2]) => [k2.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }), v2])),
    toolCallId: msg.toolCallId,
    providerIdentifier: msg.providerIdentifier,
    toolName: msg.toolName,
    smartModeApproval: msg.smartModeApproval !== void 0 ? fromRedactedSmartModeApproval(msg.smartModeApproval, purpose, opts) : void 0,
    smartModeApprovalOnly: msg.smartModeApprovalOnly,
    skipApproval: msg.skipApproval,
    serverIdentifier: msg.serverIdentifier,
  });
}

function toRedactedMcpImageContent(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    data: createRedactedBytes(msg.data, DataClassification.CODE, "data", privacyMode),
    mimeType: msg.mimeType,
  };
}

function fromRedactedMcpImageContent(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpImageContent({
    data: msg.data.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    mimeType: msg.mimeType,
  });
}

function toRedactedMcpPermissionDenied(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
    isReadonly: msg.isReadonly,
  };
}

function fromRedactedMcpPermissionDenied(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpPermissionDenied({
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    isReadonly: msg.isReadonly,
  });
}

function toRedactedMcpRejected(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    reason: createRedactedString(msg.reason, DataClassification.CODE, "reason", privacyMode),
    isReadonly: msg.isReadonly,
  };
}

function fromRedactedMcpRejected(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpRejected({
    reason: msg.reason.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    isReadonly: msg.isReadonly,
  });
}

function toRedactedMcpSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    content: msg.content.map((v2) => toRedactedMcpToolResultContentItem(v2, privacyMode)),
    isError: msg.isError,
    structuredContent: msg.structuredContent,
  };
}

function fromRedactedMcpSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpSuccess({
    content: msg.content.map((v2) => fromRedactedMcpToolResultContentItem(v2, purpose, opts)),
    isError: msg.isError,
    structuredContent: msg.structuredContent,
  });
}

function toRedactedMcpTextContent(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    text: createRedactedString(msg.text, DataClassification.CODE, "text", privacyMode),
    outputLocation: msg.outputLocation !== void 0 ? toRedactedOutputLocation(msg.outputLocation, privacyMode) : void 0,
  };
}

function fromRedactedMcpTextContent(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpTextContent({
    text: msg.text.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    outputLocation: msg.outputLocation !== void 0 ? fromRedactedOutputLocation(msg.outputLocation, purpose, opts) : void 0,
  });
}

function toRedactedMcpToolResultContentItem_content(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "text":
      return { case: "text", value: toRedactedMcpTextContent(oneof.value, privacyMode) };
    case "image":
      return { case: "image", value: toRedactedMcpImageContent(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedMcpToolResultContentItem_content(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "text":
      return { case: "text", value: fromRedactedMcpTextContent(oneof.value, purpose, opts) };
    case "image":
      return { case: "image", value: fromRedactedMcpImageContent(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedMcpToolResultContentItem(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    content: toRedactedMcpToolResultContentItem_content(msg.content, privacyMode),
  };
}

function fromRedactedMcpToolResultContentItem(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpToolResultContentItem({
    content: fromRedactedMcpToolResultContentItem_content(msg.content, purpose, opts),
  });
}

function toRedactedReadMcpResourceError(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    uri: createRedactedString(msg.uri, DataClassification.PATH, "uri", privacyMode),
    error: createRedactedString(msg.error, DataClassification.CODE, "error", privacyMode),
  };
}

function fromRedactedReadMcpResourceError(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReadMcpResourceError({
    uri: msg.uri.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    error: msg.error.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedReadMcpResourceExecArgs(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    server: msg.server,
    uri: createRedactedString(msg.uri, DataClassification.PATH, "uri", privacyMode),
    downloadPath: msg.downloadPath !== void 0 ? createRedactedString(msg.downloadPath, DataClassification.PATH, "download_path", privacyMode) : void 0,
    toolCallId: msg.toolCallId,
    smartModeApproval: msg.smartModeApproval !== void 0 ? toRedactedSmartModeApproval(msg.smartModeApproval, privacyMode) : void 0,
  };
}

function fromRedactedReadMcpResourceExecArgs(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReadMcpResourceExecArgs({
    server: msg.server,
    uri: msg.uri.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    downloadPath: msg.downloadPath?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    toolCallId: msg.toolCallId,
    smartModeApproval: msg.smartModeApproval !== void 0 ? fromRedactedSmartModeApproval(msg.smartModeApproval, purpose, opts) : void 0,
  });
}

function toRedactedReadMcpResourceExecResult_result(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: toRedactedReadMcpResourceSuccess(oneof.value, privacyMode) };
    case "error":
      return { case: "error", value: toRedactedReadMcpResourceError(oneof.value, privacyMode) };
    case "rejected":
      return { case: "rejected", value: toRedactedReadMcpResourceRejected(oneof.value, privacyMode) };
    case "notFound":
      return { case: "notFound", value: toRedactedReadMcpResourceNotFound(oneof.value, privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedReadMcpResourceExecResult_result(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "success":
      return { case: "success", value: fromRedactedReadMcpResourceSuccess(oneof.value, purpose, opts) };
    case "error":
      return { case: "error", value: fromRedactedReadMcpResourceError(oneof.value, purpose, opts) };
    case "rejected":
      return { case: "rejected", value: fromRedactedReadMcpResourceRejected(oneof.value, purpose, opts) };
    case "notFound":
      return { case: "notFound", value: fromRedactedReadMcpResourceNotFound(oneof.value, purpose, opts) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedReadMcpResourceExecResult(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    result: toRedactedReadMcpResourceExecResult_result(msg.result, privacyMode),
  };
}

function fromRedactedReadMcpResourceExecResult(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReadMcpResourceExecResult({
    result: fromRedactedReadMcpResourceExecResult_result(msg.result, purpose, opts),
  });
}

function toRedactedReadMcpResourceNotFound(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    uri: createRedactedString(msg.uri, DataClassification.PATH, "uri", privacyMode),
  };
}

function fromRedactedReadMcpResourceNotFound(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReadMcpResourceNotFound({
    uri: msg.uri.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedReadMcpResourceRejected(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    uri: createRedactedString(msg.uri, DataClassification.PATH, "uri", privacyMode),
    reason: createRedactedString(msg.reason, DataClassification.CODE, "reason", privacyMode),
  };
}

function fromRedactedReadMcpResourceRejected(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReadMcpResourceRejected({
    uri: msg.uri.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    reason: msg.reason.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
  });
}

function toRedactedReadMcpResourceSuccess_content(oneof, privacyMode) {
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "text":
      return { case: "text", value: createRedactedString(oneof.value, DataClassification.CODE, "text", privacyMode) };
    case "blob":
      return { case: "blob", value: createRedactedBytes(oneof.value, DataClassification.CODE, "blob", privacyMode) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function fromRedactedReadMcpResourceSuccess_content(oneof, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  if (oneof === void 0) {
    return { case: void 0, value: void 0 };
  }
  switch (oneof.case) {
    case "text":
      return { case: "text", value: oneof.value.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }) };
    case "blob":
      return { case: "blob", value: oneof.value.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }) };
    default:
      return { case: void 0, value: void 0 };
  }
}

function toRedactedReadMcpResourceSuccess(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    uri: createRedactedString(msg.uri, DataClassification.PATH, "uri", privacyMode),
    name: msg.name,
    description: msg.description !== void 0 ? createRedactedString(msg.description, DataClassification.CODE, "description", privacyMode) : void 0,
    mimeType: msg.mimeType,
    annotations: new Map(Object.entries(msg.annotations).map(([k2, v2]) => [k2, createRedactedString(v2, DataClassification.CODE, "annotations", privacyMode)])),
    downloadPath: msg.downloadPath !== void 0 ? createRedactedString(msg.downloadPath, DataClassification.PATH, "download_path", privacyMode) : void 0,
    outputLocation: msg.outputLocation !== void 0 ? toRedactedOutputLocation(msg.outputLocation, privacyMode) : void 0,
    content: toRedactedReadMcpResourceSuccess_content(msg.content, privacyMode),
  };
}

function fromRedactedReadMcpResourceSuccess(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new ReadMcpResourceSuccess({
    uri: msg.uri.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    name: msg.name,
    description: msg.description?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    mimeType: msg.mimeType,
    annotations: Object.fromEntries(Array.from(msg.annotations.entries()).map(([k2, v2]) => [k2, v2.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing })])),
    downloadPath: msg.downloadPath?.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    outputLocation: msg.outputLocation !== void 0 ? fromRedactedOutputLocation(msg.outputLocation, purpose, opts) : void 0,
    content: fromRedactedReadMcpResourceSuccess_content(msg.content, purpose, opts),
  });
}

export {
  toRedactedListMcpResourcesError,
  fromRedactedListMcpResourcesError,
  toRedactedListMcpResourcesExecArgs,
  fromRedactedListMcpResourcesExecArgs,
  toRedactedListMcpResourcesExecResult,
  fromRedactedListMcpResourcesExecResult,
  toRedactedListMcpResourcesExecResult_result,
  fromRedactedListMcpResourcesExecResult_result,
  toRedactedListMcpResourcesExecResult_McpResource,
  fromRedactedListMcpResourcesExecResult_McpResource,
  toRedactedListMcpResourcesRejected,
  fromRedactedListMcpResourcesRejected,
  toRedactedListMcpResourcesSuccess,
  fromRedactedListMcpResourcesSuccess,
  toRedactedMcpArgs,
  fromRedactedMcpArgs,
  toRedactedMcpImageContent,
  fromRedactedMcpImageContent,
  toRedactedMcpPermissionDenied,
  fromRedactedMcpPermissionDenied,
  toRedactedMcpRejected,
  fromRedactedMcpRejected,
  toRedactedMcpSuccess,
  fromRedactedMcpSuccess,
  toRedactedMcpTextContent,
  fromRedactedMcpTextContent,
  toRedactedMcpToolResultContentItem,
  fromRedactedMcpToolResultContentItem,
  toRedactedMcpToolResultContentItem_content,
  fromRedactedMcpToolResultContentItem_content,
  toRedactedReadMcpResourceError,
  fromRedactedReadMcpResourceError,
  toRedactedReadMcpResourceExecArgs,
  fromRedactedReadMcpResourceExecArgs,
  toRedactedReadMcpResourceExecResult,
  fromRedactedReadMcpResourceExecResult,
  toRedactedReadMcpResourceExecResult_result,
  fromRedactedReadMcpResourceExecResult_result,
  toRedactedReadMcpResourceNotFound,
  fromRedactedReadMcpResourceNotFound,
  toRedactedReadMcpResourceRejected,
  fromRedactedReadMcpResourceRejected,
  toRedactedReadMcpResourceSuccess,
  fromRedactedReadMcpResourceSuccess,
  toRedactedReadMcpResourceSuccess_content,
  fromRedactedReadMcpResourceSuccess_content,
};
