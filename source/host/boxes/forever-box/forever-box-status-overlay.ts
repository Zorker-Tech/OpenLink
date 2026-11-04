/** Temporarily hides a desktop while a box migration is in progress. */
import type { ExpiryPolicy } from "../../extensions/scheduling.ts";
import type { BoxStatus } from "./host-box.ts";

export class ForeverBoxStatusOverlay {
  private migrating = false;
  private expiry: { dispose(): void } | undefined;

  constructor(private readonly expiryPolicy: ExpiryPolicy) {}

  setMigrating(value: boolean): void {
    this.migrating = value;
    this.expiry?.dispose();
    this.expiry = value
      ? this.expiryPolicy.arm("migration", () => {
          this.migrating = false;
          this.expiry = undefined;
        })
      : undefined;
  }

  decorate(status: BoxStatus): BoxStatus {
    return this.migrating ? { ...status, vncUrl: null, pull: { percent: 0 } } : status;
  }

  dispose(): void {
    this.expiry?.dispose();
    this.expiry = undefined;
  }
}
