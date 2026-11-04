import type { SlateSupervisorUpgradeCommand, SupervisorUpgradeInput } from "./host-bundle-upgrade-contracts.ts";

/** Add the supervisor fields in its serialized order, leaving absent values out. */
export function buildSlateSupervisorCommand(input: SupervisorUpgradeInput): SlateSupervisorUpgradeCommand {
  const command: SlateSupervisorUpgradeCommand = {
    id: input.id,
    kind: input.kind,
    issuedAtMs: input.nowMs,
  };
  if (input.reason !== undefined) command.reason = input.reason;
  if (input.mode !== undefined) command.mode = input.mode;
  if (input.version !== undefined) command.version = input.version;
  if (input.bundlePath !== undefined) command.bundlePath = input.bundlePath;
  if (input.forceNow === true) command.forceNow = true;
  return command;
}

export function serializeSlateSupervisorCommand(command: SlateSupervisorUpgradeCommand): string {
  return JSON.stringify(command);
}
