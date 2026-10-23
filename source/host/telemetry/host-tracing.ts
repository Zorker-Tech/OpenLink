/** The trace this host keeps of itself.

 * Spans are started and ended around the work the host does, with the resourceAttributes that says which build and which machine
 * they came from, and an spanExporter that carries them to wherever the platform collects them — or keeps them in memory
 * when it is asked to. */
import { hostname, platform } from "node:os";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanExporter as OTelSpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { errorLogTag } from "../../shared/errors/summary.ts";
import { SLATE_CLIENT_TYPE } from "../../shared/node/slate-client-metadata.ts";
import { sendTraceSampler } from "./send-trace-sampler.ts";
export { ExportResultCode };
export type SpanExporter = OTelSpanExporter;
export type SpanExporterFactory = (settings: {
  url: string;
  headers: Record<string, string>;
  httpAgentOptions?: { rejectUnauthorized: boolean };
}) => SpanExporter;
export class TokenRefreshingSpanExporter implements SpanExporter {
  private currentExporter: SpanExporter | undefined;
  private currentToken: string | undefined;
  constructor(
    readonly url: string,
    readonly getToken: () => string | null,
    readonly baseHeaders: Record<string, string>,
    readonly insecure = false,
    private readonly createExporter: SpanExporterFactory = ({
      url,
      headers,
      httpAgentOptions,
    }) => new OTLPTraceExporter({
      url,
      headers,
      ...(httpAgentOptions === undefined ? {} : { httpAgentOptions }),
    }),
  ) {}
  resolveDelegate(): SpanExporter | undefined {
    let freshToken: string | null;
    try {
      freshToken = this.getToken();
    } catch {
      freshToken = null;
    }
    if (freshToken == null || freshToken.length === 0) return this.currentExporter;
    if (this.currentExporter === undefined || freshToken !== this.currentToken) {
      const previousExporter = this.currentExporter;
      this.currentExporter = this.createExporter({
        url: this.url,
        headers: { ...this.baseHeaders, authorization: `Bearer ${freshToken}` },
        ...(this.insecure
          ? { httpAgentOptions: { rejectUnauthorized: false } }
          : {}),
      });
      this.currentToken = freshToken;
      if (previousExporter !== undefined)
        void previousExporter
          .shutdown()
          .catch((cause) =>
            console.warn(
              `[slate-tracing] replaced exporter shutdown failed (${errorLogTag(cause)})`,
            ),
          );
    }
    return this.currentExporter;
  }
  export(
    batch: Parameters<SpanExporter["export"]>[0],
    onResult: Parameters<SpanExporter["export"]>[1],
  ): void {
    let currentExporter: SpanExporter | undefined;
    try {
      currentExporter = this.resolveDelegate();
    } catch {
      currentExporter = undefined;
    }
    if (currentExporter === undefined) {
      onResult({ code: ExportResultCode.FAILED });
      return;
    }
    try {
      currentExporter.export(batch, onResult);
    } catch {
      onResult({ code: ExportResultCode.FAILED });
    }
  }
  async shutdown(): Promise<void> {
    try {
      await this.currentExporter?.shutdown();
    } catch {}
  }
  async forceFlush(): Promise<void> {
    try {
      await this.currentExporter?.forceFlush?.();
    } catch {}
  }
}
export interface HostTracing {
  flush(): void;
  dispose(): Promise<void>;
}
export const NOOP_HOST_TRACING: HostTracing = {
  flush: () => {},
  dispose: async () => {},
};
let tracingReady = false,
  activeTracing: HostTracing | undefined;
export function resetHostTracingForTests(): void {
  tracingReady = false;
  activeTracing = undefined;
}
export function initSlateHostTracing(settings: {
  backendUrl: string;
  getToken(): string | null;
  serviceVersion?: string;
  insecure?: boolean;
  createExporter?: SpanExporterFactory;
  createProvider?: (config: {
    exporter: SpanExporter;
    resource: Record<string, string>;
    sampler: ReturnType<typeof sendTraceSampler>;
  }) => {
    register(): void;
    forceFlush(): Promise<void>;
    shutdown(): Promise<void>;
  };
}): HostTracing {
  if (tracingReady) return activeTracing ?? NOOP_HOST_TRACING;
  try {
    const spanExporter = new TokenRefreshingSpanExporter(
      `${settings.backendUrl.replace(/\/+$/, "")}/v1/traces`,
      settings.getToken,
      {
        "x-ghost-mode": "false",
        "x-cursor-client-type": SLATE_CLIENT_TYPE,
        "x-cursor-client-version": "slate-host",
      },
      settings.insecure ?? false,
      settings.createExporter,
    );
    const resourceAttributes = {
      "service.name": "slate-host",
      "service.version": settings.serviceVersion ?? "unknown",
      "host.name": hostname(),
      "os.type": platform(),
      "process.runtime.name": "node",
      "process.runtime.version": process.version,
      "deployment.environment": "box",
    };
    const traceSampler = sendTraceSampler();
    const tracingProvider = settings.createProvider?.({ exporter: spanExporter, resource: resourceAttributes, sampler: traceSampler }) ?? (() => {
      const nodeTracingProvider = new NodeTracerProvider({
        resource: resourceFromAttributes(resourceAttributes),
        sampler: traceSampler,
        spanProcessors: [new BatchSpanProcessor(spanExporter)],
      });
      return {
        register: () => nodeTracingProvider.register(),
        forceFlush: () => nodeTracingProvider.forceFlush(),
        shutdown: () => nodeTracingProvider.shutdown(),
      };
    })();
    if (tracingProvider === undefined) return NOOP_HOST_TRACING;
    tracingProvider.register();
    let shutDown = false;
    const onSignal = () => {
      void handle.dispose();
    };
    const handle: HostTracing = {
      flush: () => {
        try {
          void tracingProvider
            .forceFlush()
            .catch((cause) =>
              console.warn(
                `[slate-tracing] span flush failed (${errorLogTag(cause)})`,
              ),
            );
        } catch {}
      },
      dispose: async () => {
        if (shutDown) return;
        shutDown = true;
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
        process.off("beforeExit", onSignal);
        try {
          await tracingProvider.shutdown();
        } catch {}
      },
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    process.once("beforeExit", onSignal);
    activeTracing = handle;
    tracingReady = true;
    return handle;
  } catch {
    return NOOP_HOST_TRACING;
  }
}
