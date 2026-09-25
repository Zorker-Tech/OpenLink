// @ts-nocheck -- generated runtime: redaction changes a field's type structurally, so the
// declaration pass for these modules is a separate mechanical step.
//
// @generated from this repository's schema and redaction annotations. Do not edit.
//
// Regenerate with `pnpm --filter @slate/work-host redaction:generate`.
// Sensitive fields arrive as RedactedString/RedactedBytes; `fromRedacted*` asks for a purpose.
import { DataClassification } from "../../../../redaction/classification.ts";
import { createRedactedString } from "../../../../redaction/create.ts";
import { McpDescriptor, McpFileSystemOptions, McpInstructions, McpMetaToolOptions, McpToolDefinition, McpToolDescriptor } from "../../../../proto/generated/agent/v1/mcp_pb.ts";

function toRedactedMcpDescriptor(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    serverName: msg.serverName,
    serverIdentifier: msg.serverIdentifier,
    folderPath: createRedactedString(msg.folderPath, DataClassification.PATH, "folder_path", privacyMode),
    serverUseInstructions: createRedactedString(msg.serverUseInstructions, DataClassification.CODE, "server_use_instructions", privacyMode),
    tools: msg.tools.map((v2) => toRedactedMcpToolDescriptor(v2, privacyMode)),
    plugin: msg.plugin,
    marketplace: msg.marketplace,
    pluginDbId: msg.pluginDbId,
    marketplaceId: msg.marketplaceId,
  };
}

function fromRedactedMcpDescriptor(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpDescriptor({
    serverName: msg.serverName,
    serverIdentifier: msg.serverIdentifier,
    folderPath: msg.folderPath.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    serverUseInstructions: msg.serverUseInstructions.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    tools: msg.tools.map((v2) => fromRedactedMcpToolDescriptor(v2, purpose, opts)),
    plugin: msg.plugin,
    marketplace: msg.marketplace,
    pluginDbId: msg.pluginDbId,
    marketplaceId: msg.marketplaceId,
  });
}

function toRedactedMcpFileSystemOptions(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    enabled: msg.enabled,
    workspaceProjectDir: createRedactedString(msg.workspaceProjectDir, DataClassification.PATH, "workspace_project_dir", privacyMode),
    mcpDescriptors: msg.mcpDescriptors.map((v2) => toRedactedMcpDescriptor(v2, privacyMode)),
  };
}

function fromRedactedMcpFileSystemOptions(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpFileSystemOptions({
    enabled: msg.enabled,
    workspaceProjectDir: msg.workspaceProjectDir.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    mcpDescriptors: msg.mcpDescriptors.map((v2) => fromRedactedMcpDescriptor(v2, purpose, opts)),
  });
}

function toRedactedMcpInstructions(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    serverName: msg.serverName,
    instructions: createRedactedString(msg.instructions, DataClassification.CODE, "instructions", privacyMode),
    serverIdentifier: msg.serverIdentifier,
  };
}

function fromRedactedMcpInstructions(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpInstructions({
    serverName: msg.serverName,
    instructions: msg.instructions.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    serverIdentifier: msg.serverIdentifier,
  });
}

function toRedactedMcpMetaToolOptions(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    enabled: msg.enabled,
    mcpDescriptors: msg.mcpDescriptors.map((v2) => toRedactedMcpDescriptor(v2, privacyMode)),
  };
}

function fromRedactedMcpMetaToolOptions(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpMetaToolOptions({
    enabled: msg.enabled,
    mcpDescriptors: msg.mcpDescriptors.map((v2) => fromRedactedMcpDescriptor(v2, purpose, opts)),
  });
}

function toRedactedMcpToolDefinition(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    name: msg.name,
    description: createRedactedString(msg.description, DataClassification.CODE, "description", privacyMode),
    inputSchema: msg.inputSchema,
    providerIdentifier: msg.providerIdentifier,
    toolName: msg.toolName,
    inputSchemaJson: msg.inputSchemaJson,
  };
}

function fromRedactedMcpToolDefinition(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpToolDefinition({
    name: msg.name,
    description: msg.description.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    inputSchema: msg.inputSchema,
    providerIdentifier: msg.providerIdentifier,
    toolName: msg.toolName,
    inputSchemaJson: msg.inputSchemaJson,
  });
}

function toRedactedMcpToolDescriptor(msg, privacyMode) {
  return {
    _privacyMode: privacyMode,
    toolName: msg.toolName,
    definitionPath: createRedactedString(msg.definitionPath, DataClassification.PATH, "definition_path", privacyMode),
    description: msg.description,
    inputSchema: msg.inputSchema,
    inputSchemaJson: msg.inputSchemaJson,
    annotationsJson: msg.annotationsJson,
  };
}

function fromRedactedMcpToolDescriptor(msg, purpose, opts) {
  const redactUnallowedFieldsInsteadOfThrowing = opts?.redactUnallowedFieldsInsteadOfThrowing ?? false;
  const enforcing = opts?.enforcing;
  return new McpToolDescriptor({
    toolName: msg.toolName,
    definitionPath: msg.definitionPath.unwrap(purpose, { redactUnallowedFieldsInsteadOfThrowing, enforcing }),
    description: msg.description,
    inputSchema: msg.inputSchema,
    inputSchemaJson: msg.inputSchemaJson,
    annotationsJson: msg.annotationsJson,
  });
}

export {
  toRedactedMcpDescriptor,
  fromRedactedMcpDescriptor,
  toRedactedMcpFileSystemOptions,
  fromRedactedMcpFileSystemOptions,
  toRedactedMcpInstructions,
  fromRedactedMcpInstructions,
  toRedactedMcpMetaToolOptions,
  fromRedactedMcpMetaToolOptions,
  toRedactedMcpToolDefinition,
  fromRedactedMcpToolDefinition,
  toRedactedMcpToolDescriptor,
  fromRedactedMcpToolDescriptor,
};
