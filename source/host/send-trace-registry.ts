import type { TraceFactory } from "./send-trace-contracts.ts";

let installedFactory: TraceFactory | undefined;

export function setHostTraceFactory(factory: TraceFactory): void {
  installedFactory = factory;
}

export function currentHostTraceFactory(): TraceFactory | undefined {
  return installedFactory;
}
