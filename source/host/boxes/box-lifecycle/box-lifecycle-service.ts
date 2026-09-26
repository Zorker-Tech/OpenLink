/**
 * Rebuilding a box, and knowing when a new image is available.
 *
 * A box runs an image the platform publishes, and when that image is replaced the user is told and may rebuild: whether
 * an update is available is asked of the box, and rebuilding either preserves the box's data or starts it over — with a
 * rebuild that did not start reported with the reason it did not.
 */
export interface BoxLifecycleClient { getBoxRunState(input: {}, options: { signal: AbortSignal }): Promise<{ imageUpdateAvailable: boolean }>; recreateBox(input: { preserveData: boolean; force: boolean }): Promise<{ started: boolean; reason?: string }>; }
export class BoxLifecycleService { constructor(private readonly client: BoxLifecycleClient) {} async fetchImageUpdateAvailable(signal: AbortSignal): Promise<boolean> { return (await this.client.getBoxRunState({}, { signal })).imageUpdateAvailable; } async recreateInBox(options: { readonly preserveData: boolean; readonly force?: boolean }): Promise<{ started: boolean; reason?: string }> { const response = await this.client.recreateBox({ preserveData: options.preserveData, force: options.force === true }); return { started: response.started, ...(response.reason === undefined ? {} : { reason: response.reason }) }; } }
