// src/otel.ts
// Optional-dependency wrapper. Safe to import without @opentelemetry/*
// installed; init({enabled:false}) is a no-op that pulls nothing.
// init({enabled:true}) dynamically imports the SDK and returns helpers that
// wrap it. If the SDK can't be loaded the proxy continues without telemetry
// (a warning is logged once).

import type { Config } from "./types.ts";

export interface OtelSpan {
  end(): void;
}

export interface OtelHandle {
  enabled: boolean;
  startProxySpan?(name: string, attrs: Record<string, string | number>): OtelSpan | null;
  incrementCounter?(name: string, n: number, attrs?: Record<string, string | number>): void;
  shutdown?(): Promise<void>;
}

const NOOP_HANDLE: OtelHandle = {
  enabled: false,
  startProxySpan: () => null,
  incrementCounter: () => {
    /* no-op */
  },
  shutdown: async () => {
    /* no-op */
  },
};

export async function init(cfg: NonNullable<Config["otel"]>): Promise<OtelHandle> {
  if (!cfg.enabled) return NOOP_HANDLE;
  try {
    // Dynamic imports — typed as `any` because the static surface of this
    // file MUST type-check without the optional packages on disk.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const api = (await import("@opentelemetry/api" as string)) as any;
    const sdkNode = (await import("@opentelemetry/sdk-node" as string)) as any;
    const traceExp = (await import("@opentelemetry/exporter-trace-otlp-http" as string)) as any;
    const metricExp = (await import("@opentelemetry/exporter-metrics-otlp-http" as string)) as any;
    const sdkMetrics = (await import("@opentelemetry/sdk-metrics" as string)) as any;
    const resources = (await import("@opentelemetry/resources" as string)) as any;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const serviceName = cfg.serviceName ?? "stoke";
    const endpoint = cfg.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

    const sdk = new sdkNode.NodeSDK({
      resource: new resources.Resource({ "service.name": serviceName }),
      traceExporter: new traceExp.OTLPTraceExporter(endpoint ? { url: `${endpoint}/v1/traces` } : {}),
      metricReader: new sdkMetrics.PeriodicExportingMetricReader({
        exporter: new metricExp.OTLPMetricExporter(endpoint ? { url: `${endpoint}/v1/metrics` } : {}),
        exportIntervalMillis: 30_000,
      }),
    });
    sdk.start();

    const tracer = api.trace.getTracer("stoke");
    const meter = api.metrics.getMeter("stoke");
    const counters = new Map<string, ReturnType<typeof meter.createCounter>>();

    return {
      enabled: true,
      startProxySpan(name, attrs) {
        const span = tracer.startSpan(name, { attributes: attrs });
        return { end: () => span.end() };
      },
      incrementCounter(name, n, attrs) {
        let c = counters.get(name);
        if (!c) {
          c = meter.createCounter(name);
          counters.set(name, c);
        }
        c.add(n, attrs ?? {});
      },
      async shutdown() {
        await sdk.shutdown();
      },
    };
  } catch (err) {
    try {
      process.stderr.write(
        `stoke: OTel init failed (${(err as Error).message}); continuing without telemetry\n`,
      );
    } catch {
      /* best-effort */
    }
    return NOOP_HANDLE;
  }
}
