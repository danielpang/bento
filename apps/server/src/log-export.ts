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

type ConsoleMethod = (typeof CONSOLE_LEVELS)[number][0];
type ConsoleFn = (...args: unknown[]) => void;

/**
 * One export per process. startServer is not a singleton (the embedded
 * TUI and the e2e suite boot repeatedly in one process), and nested
 * console wrappers cannot be restored in any order without one of them
 * clobbering the other, so a second start while one is live is refused
 * rather than stacked.
 */
let active = false;

/**
 * How long stop() may spend flushing. The exporter's own timeout plus
 * retries can exceed the process's ten second shutdown deadline; a
 * flush that slow forfeits its records rather than the clean exit.
 */
const STOP_BUDGET_MS = 3000;

/**
 * Ships the server's logs to PostHog over OTLP, or returns null when
 * no key is configured. (The missing key is announced by server.ts;
 * it is the same variable, and one line is enough.)
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
  if (active) return null;
  active = true;

  // posthog-node strips a trailing slash from the same variable; a
  // host that works for analytics must not silently 404 every log.
  const host = env.POSTHOG_HOST.replace(/\/+$/, "");
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      "service.name": "bento-server",
      "bento.mode": env.BENTO_MODE,
      // The same name and values the events carry, so one filter works
      // across metrics, errors, and logs.
      environment: env.BENTO_ENVIRONMENT,
    }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: `${host}/i/v1/logs`,
          headers: { Authorization: `Bearer ${env.POSTHOG_API_KEY}` },
        }),
      }),
    ],
  });
  const logger: Logger = provider.getLogger("bento-server");

  /**
   * Plain references, not bound copies: restore must hand back the
   * exact function objects Node installed, or console.info stops
   * aliasing console.log after a correct stop() and anything comparing
   * them concludes the console is still patched.
   */
  const wrapped: Array<{ method: ConsoleMethod; original: ConsoleFn; wrapper: ConsoleFn }> = [];
  for (const [method, severityNumber, severityText] of CONSOLE_LEVELS) {
    const original = console[method] as ConsoleFn;
    const wrapper: ConsoleFn = (...args: unknown[]) => {
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
    wrapped.push({ method, original, wrapper });
    console[method] = wrapper;
  }

  return {
    async stop(): Promise<void> {
      for (const { method, original, wrapper } of wrapped) {
        // Only restore what is still ours: if someone else wrapped on
        // top of this wrapper, blind assignment would tear their layer
        // off along with this one.
        if (console[method] === wrapper) console[method] = original;
      }
      active = false;
      await Promise.race([
        provider.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, STOP_BUDGET_MS).unref()),
      ]);
    },
  };
}
