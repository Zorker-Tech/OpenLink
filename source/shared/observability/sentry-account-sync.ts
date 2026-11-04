interface SyncRequest {
  readonly sequence: number;
}

/** Discard stale asynchronous account/privacy reads when a newer auth change starts. */
export class SlateSentryAccountPrivacySync {
  private sequence = 0;
  private authId: string | undefined;

  begin(authId?: string): { sequence: number; reset: boolean; identityChanged: boolean } {
    const identityChanged = this.authId !== undefined && authId !== this.authId;
    const reset = authId === undefined || authId !== this.authId;
    this.authId = authId;
    return { sequence: ++this.sequence, reset, identityChanged };
  }

  isCurrent(request: SyncRequest): boolean {
    return request.sequence === this.sequence;
  }

  finish<T>(request: SyncRequest, value: T): T | undefined {
    return this.isCurrent(request) ? value : undefined;
  }
}
