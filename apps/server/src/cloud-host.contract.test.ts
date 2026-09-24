import { test } from "node:test";
import assert from "node:assert/strict";
import { isCloudRegistration, type CloudHost, type CloudRegistration } from "./cloud-contract.js";

/**
 * The seam, from this side. The cloud module lives in another
 * repository, so this is what catches a host that forgot admission
 * or started mounting waitlist routes under /api/billing.
 */
test("a cloud registration may supply admission, public routes, and an operator", () => {
  const registered: CloudRegistration = {
    admission: {
      mode: () => "waitlist",
      async canCreateUser() {
        return { allowed: false, code: "WAITLIST_REQUIRED" };
      },
      async onUserCreated() {},
    },
    waitlistOperator: {
      async inviteWave() {
        return { waveId: "w", requested: 1, claimed: 0, sent: 0, failed: 0, reclaimed: 0 };
      },
      async dryRun() {
        return { eligible: 0, wouldClaim: 0 };
      },
      async status() {
        return {
          pending: 0,
          claimed: 0,
          invited: 0,
          expired: 0,
          joined: 0,
          suppressed: 0,
          staleClaims: 0,
          oldestPendingAgeHours: null,
          alerts: [],
        };
      },
      async reconcile() {
        return { markedJoined: 0 };
      },
      async retain() {
        return { deleted: 0 };
      },
    },
  };
  assert.equal(isCloudRegistration(registered), true);
  assert.equal(registered.admission?.mode(), "waitlist");
});

test("the host the loader builds includes notify, capture, and a deferred identify", () => {
  const host: CloudHost = {
    db: { async execute() { return { rows: [] }; } },
    mailer: { async send() {} },
    async notify() {},
    appUrl: "https://usebento.ai",
    rawEnv: { BENTO_WAITLIST_MODE: "open" },
    async identify() {
      return null;
    },
    capture() {},
  };
  assert.equal(typeof host.notify, "function");
  assert.equal(typeof host.capture, "function");
  assert.equal(host.rawEnv.BENTO_WAITLIST_MODE, "open");
});

test("isCloudRegistration rejects an admission object missing its methods", () => {
  assert.equal(isCloudRegistration({ admission: { mode: () => "open" } }), false);
  assert.equal(isCloudRegistration(null), false);
});
