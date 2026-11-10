/**
 * The carrier the coordinator and the renderer talk over.
 *
 * A message names the channel it belongs to and is turned into the envelope that channel expects, so a caller cannot
 * put an envelope of one kind on the other's channel.
 */
import {
  COORDINATOR_CONTROL_CHANNEL,
  COORDINATOR_MAIN_DATA_CHANNEL,
  asCoordinatorControlEnvelope,
  asCoordinatorMainDataEnvelope,
  parseCoordinatorBootstrap,
  type CoordinatorBootstrap,
  type CoordinatorFrame
} from "../shared/rpc/coordinator-port.ts";

export const BOOTSTRAP_FLAG = "--bootstrap=";

export interface PortLike {
  postMessage(channelValue: unknown): void;
  on(portEvent: "message" | "close", listener: (portEvent: { readonly data?: unknown; readonly ports?: readonly PortLike[] }) => void): void;
  close?(): void;
  start?(): void;
}

export function isPortLike(channelValue: unknown): channelValue is PortLike {
  if (typeof channelValue !== "object" || channelValue == null) return false;
  const portCandidate = channelValue as Partial<PortLike>;
  return typeof portCandidate.postMessage === "function" && typeof portCandidate.on === "function";
}

export interface CarrierIntakeHandlers {
  readonly onControlFrame: (channelValue: unknown) => void;
  readonly onDataFrame: (channelValue: unknown) => void;
  readonly onMainDataFrame: (channelValue: unknown) => void;
  readonly onClosed: () => void;
}

export interface CoordinatorCarrier {
  readonly kind: "fork-ipc" | "parent-port";
  readonly bootstrap: CoordinatorBootstrap;
  readonly control: { post(frame: CoordinatorFrame): void; close(): void };
  readonly data: { post(channelValue: unknown): void; close(): void };
  readonly mainData: { post(channelValue: unknown): void; close(): void };
  exitProcess(requestedExitCode: number): void;
  bind(handlers: CarrierIntakeHandlers): void;
}

export type CarrierIntake =
  | { readonly adopted: true; readonly carrier: CoordinatorCarrier }
  | { readonly adopted: false; readonly rejection: { readonly detail: string } };

export function adoptForkIpc(argv: readonly string[]): CarrierIntake {
  const bootstrapArgument = argv.find((channelValue) => channelValue.startsWith(BOOTSTRAP_FLAG));
  if (bootstrapArgument == null) return { adopted: false, rejection: { detail: "missing --bootstrap argument" } };
  let parsedBootstrap: unknown;
  try { parsedBootstrap = JSON.parse(bootstrapArgument.slice(BOOTSTRAP_FLAG.length)) as unknown; }
  catch { return { adopted: false, rejection: { detail: "--bootstrap is not valid JSON" } }; }
  const bootstrapIntake = parseCoordinatorBootstrap(parsedBootstrap);
  if (!bootstrapIntake.accepted) return { adopted: false, rejection: { detail: bootstrapIntake.rejection.detail } };
  const ipcSender = process.send?.bind(process);
  if (ipcSender == null) return { adopted: false, rejection: { detail: "no renderer data channel was transferred" } };
  let isChannelClosed = false;
  const closeIpcChannel = () => {
    if (isChannelClosed) return;
    isChannelClosed = true;
    if (process.connected) process.disconnect?.();
  };
  const post = (channelValue: unknown) => {
    try { ipcSender(channelValue, () => {}); }
    catch {}
  };
  let isBound = false;
  return {
    adopted: true,
    carrier: {
      kind: "fork-ipc",
      bootstrap: bootstrapIntake.bootstrap,
      control: { post: (frame) => post({ channel: COORDINATOR_CONTROL_CHANNEL, frame }), close: closeIpcChannel },
      data: { post, close: closeIpcChannel },
      mainData: { post: (frame) => post({ channel: COORDINATOR_MAIN_DATA_CHANNEL, frame }), close: closeIpcChannel },
      exitProcess(requestedExitCode) { process.exitCode = requestedExitCode; },
      bind(carrierHandlers) {
        if (isBound) return;
        isBound = true;
        process.on("message", (channelValue) => {
          const controlEnvelope = asCoordinatorControlEnvelope(channelValue);
          if (controlEnvelope != null) { carrierHandlers.onControlFrame(controlEnvelope.frame); return; }
          const mainDataEnvelope = asCoordinatorMainDataEnvelope(channelValue);
          if (mainDataEnvelope != null) { carrierHandlers.onMainDataFrame(mainDataEnvelope.frame); return; }
          carrierHandlers.onDataFrame(channelValue);
        });
        process.on("disconnect", () => { isChannelClosed = true; carrierHandlers.onClosed(); });
      }
    }
  };
}

export function adoptParentPort(_parentPort: PortLike, parentHandoff: { readonly data: unknown; readonly ports: readonly PortLike[] }): CarrierIntake {
  const handoffBody = parentHandoff.data;
  const bootstrapCandidate = typeof handoffBody === "object" && handoffBody != null && "bootstrap" in handoffBody
    ? (handoffBody as { readonly bootstrap: unknown }).bootstrap
    : null;
  const bootstrapIntake = parseCoordinatorBootstrap(bootstrapCandidate);
  if (!bootstrapIntake.accepted) return { adopted: false, rejection: { detail: bootstrapIntake.rejection.detail } };
  const [controlChannelPort, dataPort, mainChannelPort] = parentHandoff.ports;
  if (!isPortLike(controlChannelPort) || !isPortLike(dataPort) || !isPortLike(mainChannelPort)) {
    return { adopted: false, rejection: { detail: "parent handoff did not transfer three message ports" } };
  }
  const closedChannels = { control: false, data: false, mainData: false };
  const closeChannel = (port: PortLike, channelKey: keyof typeof closedChannels) => {
    if (closedChannels[channelKey]) return;
    closedChannels[channelKey] = true;
    port.close?.();
  };
  const postOnChannel = (port: PortLike, channelKey: keyof typeof closedChannels, channelValue: unknown) => {
    if (closedChannels[channelKey]) return;
    try { port.postMessage(channelValue); }
    catch {}
  };
  let isBound = false;
  return {
    adopted: true,
    carrier: {
      kind: "parent-port",
      bootstrap: bootstrapIntake.bootstrap,
      control: { post: (frame) => postOnChannel(controlChannelPort, "control", frame), close: () => closeChannel(controlChannelPort, "control") },
      data: { post: (channelValue) => postOnChannel(dataPort, "data", channelValue), close: () => closeChannel(dataPort, "data") },
      mainData: { post: (channelValue) => postOnChannel(mainChannelPort, "mainData", channelValue), close: () => closeChannel(mainChannelPort, "mainData") },
      exitProcess(requestedExitCode) { process.exitCode = requestedExitCode; process.exit(requestedExitCode); },
      bind(carrierHandlers) {
        if (isBound) return;
        isBound = true;
        controlChannelPort.on("message", (portEvent) => carrierHandlers.onControlFrame(portEvent.data));
        controlChannelPort.on("close", () => { closedChannels.control = true; carrierHandlers.onClosed(); });
        dataPort.on("message", (portEvent) => carrierHandlers.onDataFrame(portEvent.data));
        dataPort.on("close", () => { closedChannels.data = true; carrierHandlers.onClosed(); });
        mainChannelPort.on("message", (portEvent) => carrierHandlers.onMainDataFrame(portEvent.data));
        mainChannelPort.on("close", () => { closedChannels.mainData = true; carrierHandlers.onClosed(); });
        controlChannelPort.start?.();
        dataPort.start?.();
        mainChannelPort.start?.();
      }
    }
  };
}

export function adoptCarrier(): Promise<CarrierIntake> {
  const rendererPort = (process as NodeJS.Process & { readonly parentPort?: unknown }).parentPort;
  if (rendererPort != null && isPortLike(rendererPort)) {
    return new Promise((adoptResolved) => {
      rendererPort.on("message", (portEvent) => adoptResolved(adoptParentPort(rendererPort, { data: portEvent.data, ports: portEvent.ports ?? [] })));
      rendererPort.start?.();
    });
  }
  return Promise.resolve(adoptForkIpc(process.argv));
}
