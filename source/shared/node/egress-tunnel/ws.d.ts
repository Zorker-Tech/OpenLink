/**
 * The slice of the ws client the egress tunnel speaks to.
 *
 * The runtime provides the real ws client; this declaration names only the surface the tunnel is allowed to touch, so
 * that the TypeScript build agrees with what the package hands over at run time. Every member below is the package's
 * own name — the tunnel may call it, it does not get to rename it.
 */
declare module "ws" {
  /** What a socket is opened with. */
  interface SocketOptions {
    readonly headers?: Record<string, string>;
  }

  /** A socket as the tunnel sees it: its state and buffers, and the five things it may ask of it. */
  interface SocketInstance {
    readonly readyState: number;
    binaryType: string;
    readonly bufferedAmount: number;
    on(event: string, listener: (...args: any[]) => void): this;
    send(data: Buffer, callback?: () => void): void;
    close(): void;
    terminate(): void;
    removeAllListeners(): this;
  }

  /** The constructor the module's default export is. */
  interface SocketConstructor {
    new (url: string, options?: SocketOptions): SocketInstance;
    readonly OPEN: number;
  }

  const WebSocket: SocketConstructor;
  export default WebSocket;
}
