import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

// Resolve the exact transitive dependency electron-builder uses. Test its
// installed patch with the real promise-retry and stapler output parser.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const packagerRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const entry = packagerRequire.resolve("@electron/notarize");
const notarizeRequire = createRequire(entry);
const promiseRetry = notarizeRequire("promise-retry");
const spawn = notarizeRequire("./spawn");
const lostConnection = 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';

function harness(t, results, submissionError) {
  let submissions = 0;
  let attempts = 0;
  const warnings = [];
  const info = [];
  const errors = [];
  t.mock.method(spawn, "spawn", async (command, args) => {
    assert.equal(command, "xcrun");
    assert.deepEqual(args, ["stapler", "staple", "-v", "Bento.app"]);
    return results[Math.min(attempts++, results.length - 1)];
  });
  const exports = {};
  vm.runInNewContext(readFileSync(entry, "utf8"), {
    exports,
    console: {
      info(message) { info.push(message); },
      warn(message) { warnings.push(message); },
      error(message) { errors.push(message); },
    },
    require(name) {
      if (name === "./check-signature") return { checkSignatures: async () => {} };
      if (name === "./notarytool") return {
        isNotaryToolAvailable: async () => true,
        notarizeAndWaitForNotaryTool: async () => {
          submissions++;
          if (submissionError) throw submissionError;
        },
      };
      if (name === "promise-retry") return (fn, options) => {
        assert.equal(options.retries, 3);
        assert.equal(options.factor, 2);
        assert.equal(options.minTimeout, 15000);
        assert.equal(options.maxTimeout, 60000);
        // Exercise the real retry implementation without waiting 105 seconds.
        return promiseRetry(fn, { ...options, minTimeout: 1, maxTimeout: 1 });
      };
      return notarizeRequire(name);
    },
  }, { filename: entry });
  return {
    run: () => exports.notarize({ appPath: "/tmp/Bento.app" }),
    counts: () => ({ submissions, attempts }), warnings, info, errors,
  };
}

test("a lost ticket connection retries stapling without submitting again", async (t) => {
  const h = harness(t, [{ code: 68, output: lostConnection }, { code: 0, output: "ok" }]);
  await h.run();
  assert.deepEqual(h.counts(), { submissions: 1, attempts: 2 });
  assert.match(h.warnings[0], /attempt 1\/4.*15s/);
  assert.match(h.warnings[0], /Code=-1005/);
  assert.ok(h.info.some(line => /Notarization accepted/.test(line)));
  assert.ok(h.info.some(line => /attempt 2\/4 succeeded after \d+ms: \/tmp\/Bento.app/.test(line)));
  assert.deepEqual(h.errors, []);
});

test("persistent network failures stop after four attempts and preserve the error", async (t) => {
  const h = harness(t, [{ code: 68, output: lostConnection }]);
  await assert.rejects(h.run(), /Failed to staple.*68[\s\S]*Code=-1005/);
  assert.deepEqual(h.counts(), { submissions: 1, attempts: 4 });
  assert.equal(h.warnings.length, 3);
  assert.match(h.errors[0], /attempt 4\/4.*retries exhausted[\s\S]*Code=-1005/);
  for (const [index, seconds] of [15, 30, 60].entries()) {
    assert.ok(h.warnings[index].includes(`retrying in ${seconds}s`));
  }
});

test("permanent stapling errors, including non-network error 68, fail immediately", async (t) => {
  for (const result of [{ code: 68, output: "Ticket invalid" }, { code: 65, output: lostConnection }]) {
    const h = harness(t, [result]);
    await assert.rejects(h.run(), /Failed to staple/);
    assert.deepEqual(h.counts(), { submissions: 1, attempts: 1 });
    assert.equal(h.warnings.length, 0);
    assert.match(h.errors[0], /not retryable/);
    t.mock.restoreAll();
  }
});

test("a rejected notarization never reaches stapling or retries submission", async (t) => {
  const h = harness(t, [], new Error("Notarization rejected"));
  await assert.rejects(h.run(), /Notarization rejected/);
  assert.deepEqual(h.counts(), { submissions: 1, attempts: 0 });
  assert.match(h.errors[0], /Notarization submission failed after \d+ms: \/tmp\/Bento.app/);
  assert.ok(!h.info.some(line => /accepted|Stapling attempt/.test(line)));
});

test("Apple response logs identify the submission and status without credentials", async (t) => {
  const info = [];
  t.mock.method(spawn, "spawn", async (command, args) => {
    if (command === "ditto") return { code: 0, output: "" };
    assert.equal(command, "xcrun");
    if (args[1] === "submit") return {
      code: 0, output: JSON.stringify({ id: "submission-123", status: "Accepted" }),
    };
    assert.equal(args[1], "log");
    return { code: 0, output: "{}" };
  });
  const exports = {};
  vm.runInNewContext(readFileSync(notarizeRequire.resolve("./notarytool"), "utf8"), {
    exports, require: notarizeRequire, console: { info(message) { info.push(message); } },
  });
  await exports.notarizeAndWaitForNotaryTool({
    appPath: "/tmp/Bento.app", appleId: "private@example.test",
    appleIdPassword: "secret-password", teamId: "secret-team",
  });
  assert.deepEqual(info, [
    "Apple notarization response: app=/tmp/Bento.app submission=submission-123 status=Accepted exitCode=0",
  ]);
});
