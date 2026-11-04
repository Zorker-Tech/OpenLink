declare module "ws" {
  interface SocketOptions {
    readonly headers?: Record<string, string>
  }

  interface SocketInstance {
    readonly readyState: number
    binaryType: string
    readonly bufferedAmount: number
    on(event: string, listener: (...args: any[]) => void): this
    send(data: Buffer, callback?: () => void): void
    close(): void
    terminate(): void
    removeAllListeners(): this
  }

  interface SocketConstructor {
    new (url: string, options?: SocketOptions): SocketInstance
    readonly OPEN: number
  }

  const WebSocket: SocketConstructor
  export default WebSocket
}
