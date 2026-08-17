import { format } from "node:util";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import type { Env } from "./env.js";

export interface LogExport {
  /** Restores console and flushes what is buffered. */
  stop(): Promise<void>;
}

const CONSOLE_LEVELS = [
  ["debug", SeverityNumber.DEBUG, "debug"],
  ["log", SeverityNumber.INFO, "info"],
  ["info", SeverityNumber.INFO, "info"],
  ["warn", SeverityNumber.WARN, "warn"],
  ["error", SeverityNumber.ERROR, "error"],
] as const;

/**
 * Ships the server's logs to PostHog over OTLP, or returns null when
 * no key is configured. (The missing key is announced by
 * createAnalytics; it is the same variable, and one line is enough.)
 *
 * This server logs through console, everywhere and on purpose, so the
 * bridge wraps the console methods rather than introducing a logger
 * every call site would have to migrate to. The original method runs
 * first and unconditionally: local output must survive an export
 * outage, and a broken exporter reports itself through the very
 * console it wraps, which is why the wrapper never recurses into it.
 */
export function startLogExport(env: Env): LogExport | null {
  if (!env.POSTHOG_API_KEY) return null;

  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": "bento-server",
      "bento.mode": env.BENTO_MODE,
    }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: `${env.POSTHOG_HOST}/i/v1/logs`,
          headers: { Authorization: `Bearer ${env.POSTHOG_API_KEY}` },
        }),
      }),
    ],
  });
  const logger: Logger = provider.getLogger("bento-server");

  const originals = new Map<string, (...args: unknown[]) => void>();
  for (const [method, severityNumber, severityText] of CONSOLE_LEVELS) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    originals.set(method, original);
    console[method] = (...args: unknown[]) => {
      original(...args);
      try {
        logger.emit({
          severityNumber,
          severityText,
          body: format(...args),
          attributes: { "log.source": "console" },
        });
      } catch {
        // A log record that cannot be built must not take down the
        // code path that was merely logging.
      }
    };
  }

  return {
    async stop(): Promise<void> {
      for (const [method, original] of originals) {
        (console as unknown as Record<string, (...args: unknown[]) => void>)[method] = original;
      }
      await provider.shutdown();
    },
  };
}
