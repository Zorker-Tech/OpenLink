/** Slate's box host entry point for the isolated transport and protocol adapter. */

export {
  BoxRemoteExecManager,
  classifyPingFailure,
  createBoxAuthorizationInterceptor,
  createBoxRemoteResourceAccessor,
  createBoxRemoteResourceAccessorFromTransport,
  createBoxTransport,
  pingBox,
  pingBoxClassified,
  pingBoxTransport,
  pingBoxTransportClassified,
} from "../../adapters/interop/agent/box-remote-exec-accessor-adapter.ts"
export type {
  BoxControlClientFactory,
  BoxEndpoint,
  BoxPingControlClient,
  BoxPingOutcome,
  BoxRemoteExecClient,
  BoxRemoteExecControlMessage,
  BoxRemoteExecEnvelope,
  BoxRemoteResourceConstructionPorts,
  BoxTransportFactory,
  BoxTransportHeader,
  BoxTransportInterceptor,
  BoxTransportNext,
  BoxTransportOptions,
  BoxTransportRequest,
} from "../../adapters/interop/agent/box-remote-exec-accessor-adapter.ts"
