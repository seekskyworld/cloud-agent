/** Trace 只收协议标识和安全错误码，不记录提示词、凭据、输入或结果。 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ROOT_CONTEXT,
  trace,
  SpanStatusCode,
  type Span,
  type SpanContext,
  type Attributes,
} from "@opentelemetry/api";
import {
  NodeTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
export class Telemetry {
  private context = new AsyncLocalStorage<Span>();
  private provider?: NodeTracerProvider;
  constructor(exporter?: SpanExporter) {
    if (exporter)
      this.provider = new NodeTracerProvider({
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });
  }
  current(): SpanContext | undefined {
    return this.context.getStore()?.spanContext();
  }
  async run<T>(
    name: string,
    attributes: Attributes,
    action: () => Promise<T>,
    parent?: SpanContext,
  ): Promise<T> {
    if (!this.provider) return action();
    const previous = this.context.getStore();
    const context = previous
      ? trace.setSpan(ROOT_CONTEXT, previous)
      : parent
        ? trace.setSpanContext(ROOT_CONTEXT, parent)
        : ROOT_CONTEXT;
    const span = this.provider
      .getTracer("cloud-agent")
      .startSpan(name, { attributes }, context);
    return this.context.run(span, async () => {
      try {
        const value = await action();
        span.setStatus({ code: SpanStatusCode.OK });
        return value;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
  async close() {
    await this.provider?.shutdown();
  }
}
export function otlpTelemetry(endpoint?: string) {
  return new Telemetry(
    endpoint
      ? new OTLPTraceExporter({ url: endpoint, timeoutMillis: 5000 })
      : undefined,
  );
}
