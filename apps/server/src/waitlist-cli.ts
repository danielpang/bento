/**
 * Operator commands for the hosted waitlist. Loads the same cloud
 * module as the server, with the same database, mailer, and notify
 * function, but does not start HTTP or queue workers.
 *
 *   pnpm --filter @bento/server waitlist:invite -- --count 25 --operator ada
 *   pnpm --filter @bento/server waitlist:invite -- --count 25 --operator ada --dry-run
 *   pnpm --filter @bento/server waitlist:status
 *   pnpm --filter @bento/server waitlist:reconcile
 *   pnpm --filter @bento/server waitlist:retain -- --older-than-days 365
 */
import { createDb, createPool } from "@bento/db";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMailer, noticeMessage } from "./mail.js";
import { loadEnv } from "./env.js";
import type { CloudRegistration, WaitlistOperator } from "./cloud-contract.js";

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function printStatus(status: Awaited<ReturnType<WaitlistOperator["status"]>>): void {
  console.log(`pending ${status.pending}`);
  console.log(`oldest pending age hours ${status.oldestPendingAgeHours ?? "none"}`);
  console.log(`active claims ${status.claimed}`);
  console.log(`invites sent (unexpired) ${status.invited}`);
  console.log(`expired invites ${status.expired}`);
  console.log(`joined ${status.joined}`);
  console.log(`suppressed ${status.suppressed}`);
  console.log(`stale claims ${status.staleClaims}`);
  for (const alert of status.alerts) console.log(`alert: ${alert}`);
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const env = loadEnv();
  if (!env.BENTO_CLOUD_MODULE || env.BENTO_MODE !== "multi") {
    console.error("waitlist commands need BENTO_MODE=multi and BENTO_CLOUD_MODULE");
    return 1;
  }

  const pool = createPool(env.DATABASE_URL);
  const db = createDb(pool);
  const mailer = createMailer(env);
  const name = env.BENTO_CLOUD_MODULE;
  const specifier = name.startsWith(".") || name.startsWith("/") ? pathToFileURL(path.resolve(name)).href : name;

  try {
    const mod = (await import(specifier)) as {
      registerCloud?: (host: {
        db: typeof db;
        mailer: typeof mailer;
        notify(message: Omit<import("./mail.js").NoticeEmailInput, "appUrl">): Promise<void>;
        appUrl: string;
        rawEnv: Record<string, string | undefined>;
        identify(): Promise<null>;
      }) => Promise<CloudRegistration>;
    };
    if (typeof mod.registerCloud !== "function") {
      console.error(`BENTO_CLOUD_MODULE ${name} does not export registerCloud`);
      return 1;
    }
    const registered = await mod.registerCloud({
      db,
      mailer,
      notify: (message) =>
        mailer.send(noticeMessage({ ...message, appUrl: env.BETTER_AUTH_URL.replace(/\/$/, "") })),
      appUrl: env.BETTER_AUTH_URL,
      rawEnv: process.env,
      async identify() {
        return null;
      },
    });
    const operator = registered.waitlistOperator;
    if (!operator) {
      console.error("the cloud module does not expose a waitlist operator");
      return 1;
    }

    if (command === "status") {
      printStatus(await operator.status());
      return 0;
    }

    if (command === "reconcile") {
      const result = await operator.reconcile();
      console.log(`marked joined ${result.markedJoined}`);
      return 0;
    }

    if (command === "retain") {
      const days = Number(argValue(argv, "--older-than-days"));
      if (!Number.isInteger(days) || days < 1) {
        console.error("waitlist:retain needs --older-than-days N (a period product and legal have approved)");
        return 1;
      }
      const result = await operator.retain({ olderThanDays: days });
      console.log(`deleted ${result.deleted}`);
      return 0;
    }

    if (command === "invite") {
      const count = Number(argValue(argv, "--count"));
      const operatorName = argValue(argv, "--operator") ?? "";
      if (!Number.isInteger(count) || count < 1 || count > 1000) {
        console.error("waitlist:invite needs --count N (1 to 1000)");
        return 1;
      }
      if (hasFlag(argv, "--dry-run")) {
        const result = await operator.dryRun({ count });
        console.log(`eligible ${result.eligible}`);
        console.log(`would claim ${result.wouldClaim}`);
        return 0;
      }
      if (!operatorName.trim()) {
        console.error("waitlist:invite needs --operator NAME");
        return 1;
      }
      const result = await operator.inviteWave({ count, operator: operatorName });
      console.log(`wave ${result.waveId}`);
      console.log(`requested ${result.requested}`);
      console.log(`claimed ${result.claimed}`);
      console.log(`sent ${result.sent}`);
      console.log(`failed ${result.failed}`);
      console.log(`reclaimed ${result.reclaimed}`);
      return result.failed > 0 ? 1 : 0;
    }

    console.error("usage: waitlist:invite|status|reconcile|retain");
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

const argv = process.argv.slice(2);
main(argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
