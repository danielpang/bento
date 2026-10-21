import assert from "node:assert/strict";
import test from "node:test";
import { isBillable, provisionFault } from "./run-fault.js";
import { SandboxProvisionError } from "./sandbox-provision.js";

test("a run is billed unless its failure path named Bento or the sandbox", () => {
  assert.equal(isBillable({ ok: true }), true);
  assert.equal(isBillable({ ok: true, fault: "sandbox" }), true, "a run that succeeded is billed whatever was said");
  assert.equal(isBillable({ ok: false }), true, "an unclassified failure is the work's");
  assert.equal(isBillable({ ok: false, fault: "sandbox" }), false);
  assert.equal(isBillable({ ok: false, fault: "bento" }), false);
});

test("a provision is the sandbox's failure only when the provider loop blamed the provider", () => {
  const refused = new Error("fatal: repository not found");
  assert.equal(provisionFault(new SandboxProvisionError("provider", [], new Error("APIError: down"))), "sandbox");
  assert.equal(provisionFault(new SandboxProvisionError("project", [], refused)), undefined);
  assert.equal(
    provisionFault(new Error("Repository app cannot be reached at https://github.com/acme/app.git (no answer).")),
    undefined,
    "a refusal before any provider was asked is the project's or GitHub's",
  );
});
