/** A box migration is identified by its own id, and two operations are the same when their ids are. */
export interface BoxMigrationOperationId {
  readonly value: string;
}

export function parseBoxMigrationOperationId(
  value: unknown,
): BoxMigrationOperationId | null {
  return typeof value === "string" && value.length > 0 ? { value } : null;
}

export function isSameBoxMigrationOperation(
  left: BoxMigrationOperationId | null | undefined,
  right: BoxMigrationOperationId | null | undefined,
): boolean {
  return left != null && right != null && left.value === right.value;
}
