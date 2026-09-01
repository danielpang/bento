import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_GUIDANCE } from "./credentials.js";
import {
  checkAgentPairing,
  mergeCatalogs,
  modelStringFor,
  providerForProfile,
  providersForCli,
} from "./models.js";

test("a prefixed model string names its own provider", () => {
  assert.equal(providerForProfile("opencode", "anthropic/claude-sonnet-5")?.id, "anthropic");
  assert.equal(providerForProfile("pi", "google/gemini-3-pro")?.id, "google");
});

test("pi and opencode offer current native DeepSeek models", () => {
  for (const cli of ["pi", "opencode"]) {
    const deepseek = providersForCli(cli).find((provider) => provider.id === "deepseek");
    assert.ok(deepseek, `${cli} does not offer DeepSeek`);
    assert.deepEqual(deepseek.env, ["DEEPSEEK_API_KEY"]);
    assert.notEqual(deepseek.logo, "", "DeepSeek needs a provider mark in the picker");
    assert.deepEqual(deepseek.models.map((model) => model.id), ["deepseek-v4-pro", "deepseek-v4-flash"]);
    assert.equal(providerForProfile(cli, "deepseek/deepseek-v4-pro")?.id, "deepseek");
    assert.equal(checkAgentPairing(cli, "deepseek/deepseek-v4-pro").status, "ok");
  }
  assert.equal(providerForProfile("pi", "openrouter/deepseek/deepseek-v4-pro")?.id, "openrouter");
});

test("dsh only offers DeepSeek and requires its bare model ids", () => {
  assert.deepEqual(providersForCli("dsh").map((provider) => provider.id), ["deepseek"]);
  assert.equal(modelStringFor("dsh", "deepseek", "deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(providerForProfile("dsh", "deepseek-v4-pro")?.id, "deepseek");
  assert.equal(checkAgentPairing("dsh", "deepseek-v4-pro").status, "ok");
  assert.deepEqual(checkAgentPairing("dsh", "deepseek/deepseek-v4-pro"), {
    status: "impossible",
    detail: "DeepSeek Harness takes a bare model id, for example deepseek-v4-pro, without a provider prefix.",
  });
});

test("a bare model id is resolved against the tool's own providers", () => {
  assert.equal(providerForProfile("claude-code", "claude-sonnet-5")?.id, "anthropic");
});

/**
 * The catalog snapshot trails the tools it describes, so a tool's own
 * default can be absent from it. codex ships gpt-5-codex, which is
 * OpenAI's regardless, and it is the model most codex profiles carry.
 */
test("a tool's default model resolves even when the snapshot lacks it", () => {
  for (const tool of MODEL_GUIDANCE) {
    const resolved = providerForProfile(tool.cli, tool.defaultModel);
    if (tool.cli === "fake") {
      assert.equal(resolved, undefined);
      continue;
    }
    assert.ok(resolved, `${tool.cli}'s default ${tool.defaultModel} resolved to no provider`);
  }
});

/**
 * Round trip against the function that composed the string, for every
 * tool and its own providers. This is the property that matters: a
 * profile created through the console must resolve back to the provider
 * whose logo was shown when it was created.
 */
test("every string modelStringFor composes resolves back to its provider", () => {
  for (const cli of ["claude-code", "codex", "cursor", "opencode", "pi", "dsh"]) {
    for (const provider of providersForCli(cli)) {
      const model = provider.models[0];
      if (!model) continue;
      const composed = modelStringFor(cli, provider.id, model.id);
      const resolved = providerForProfile(cli, composed);
      // A bare id served by more than one of the tool's providers can
      // only resolve to the first that serves it, which is the same
      // choice the picker offers first.
      const ambiguous = providersForCli(cli).filter((p) => p.models.some((m) => m.id === model.id));
      const acceptable = ambiguous.length > 1 ? ambiguous.map((p) => p.id) : [provider.id];
      assert.ok(
        acceptable.includes(resolved?.id ?? ""),
        `${cli} + ${composed} resolved to ${resolved?.id}, expected one of ${acceptable.join(", ")}`,
      );
    }
  }
});

/**
 * The case that decides whether a logo can be trusted. Every tool can
 * reach several providers, so an unrecognised id must not be attributed
 * to one of them: "opencode running GLM" is not Anthropic's, and a mark
 * saying otherwise would misstate who is being billed.
 */
test("an unrecognised model is attributed to nobody", () => {
  assert.equal(providerForProfile("claude-code", "some-unreleased-model"), undefined);
  assert.equal(providerForProfile("opencode", "GLM-5.2"), undefined);
});

/**
 * Cursor bills every model it runs through the Cursor plan, so its
 * picker is not limited to the companies Bento holds a key for. These
 * are the ids that were typeable but unlisted before.
 */
test("Cursor reaches the models that are only its own", () => {
  assert.equal(providerForProfile("cursor", "composer-1")?.id, "cursor");
  assert.equal(providerForProfile("cursor", "composer-2")?.id, "cursor");
  assert.equal(providerForProfile("cursor", "composer-2.5")?.id, "cursor");
  assert.equal(providerForProfile("cursor", "grok-4.5")?.id, "xai");
  assert.equal(checkAgentPairing("cursor", "composer-1").status, "ok");
  assert.equal(checkAgentPairing("cursor", "composer-2").status, "ok");
  assert.equal(checkAgentPairing("cursor", "composer-2.5").status, "ok");
  assert.equal(checkAgentPairing("cursor", "grok-4.5").status, "ok");
  // And still reaches the two it always did.
  assert.equal(providerForProfile("cursor", "claude-sonnet-5")?.id, "anthropic");
  assert.equal(providerForProfile("cursor", "gpt-5.4")?.id, "openai");
});

/**
 * The Cursor provider list is hand maintained and has gone stale
 * before: Composer 2 and 2.5 shipped, the picker still offered 1.
 * Assert the ids the CLI actually takes so a missing one is a test
 * failure rather than a blank dropdown.
 */
test("Cursor's picker lists Composer 2 and Composer 2.5", () => {
  const cursor = providersForCli("cursor").find((p) => p.id === "cursor");
  const ids = cursor?.models.map((m) => m.id) ?? [];
  for (const id of ["composer-2.5", "composer-2.5-fast", "composer-2", "composer-2-fast", "composer-1"]) {
    assert.ok(ids.includes(id), `Cursor picker is missing ${id}`);
  }
});

/**
 * Grok for Cursor is generated from models.dev, billed through the
 * Cursor key, not a hand list that misses grok-4.6 the way Composer 2
 * was missed. Image and video Grok models are not agent models.
 */
test("Cursor's xAI list comes from models.dev and bills through Cursor", () => {
  const xai = providersForCli("cursor").find((p) => p.id === "xai");
  assert.ok(xai, "Cursor CLI should offer the xAI provider");
  assert.deepEqual(xai.env, ["CURSOR_API_KEY"]);
  const ids = xai.models.map((m) => m.id);
  assert.ok(ids.includes("grok-4.6"), "xAI picker is missing grok-4.6");
  assert.ok(ids.includes("grok-4.5"), "xAI picker is missing grok-4.5");
  assert.ok(
    ids.every((id) => !id.includes("imagine")),
    `xAI picker still lists an Imagine model: ${ids.filter((id) => id.includes("imagine")).join(", ")}`,
  );
});

/**
 * Manual ids fill gaps on a generated provider rather than replacing it,
 * so Composer stays listed if models.dev later grows a Cursor provider.
 */
test("manual catalog ids append onto a generated provider of the same id", () => {
  const merged = mergeCatalogs(
    [{ id: "cursor", name: "Cursor", env: ["CURSOR_API_KEY"], logo: "", models: [{ id: "composer-2.5", name: "Composer 2.5" }] }],
    [
      {
        id: "cursor",
        name: "Cursor",
        env: ["CURSOR_API_KEY"],
        logo: "",
        models: [
          { id: "composer-2.5", name: "ignored duplicate" },
          { id: "auto", name: "Auto (Cursor picks per request)" },
        ],
      },
    ],
  );
  assert.equal(merged.length, 1);
  assert.deepEqual(
    merged[0]!.models.map((m) => m.id),
    ["composer-2.5", "auto"],
  );
});

/**
 * The other half of listing them: a provider in the catalog is a
 * provider every tool is checked against, so Composer is now refused
 * where it could only have failed inside a sandbox before.
 */
test("a Cursor only model is impossible for the other tools", () => {
  const verdict = checkAgentPairing("claude-code", "composer-1");
  assert.equal(verdict.status, "impossible");
  assert.match(verdict.detail, /cannot run Cursor models/);
  assert.equal(checkAgentPairing("claude-code", "composer-2.5").status, "impossible");
  assert.equal(checkAgentPairing("codex", "grok-4.5").status, "impossible");
});

test("the fake agent has no provider", () => {
  assert.equal(providerForProfile("fake", "fake-1"), undefined);
});

/**
 * The pairing check. Picking the tool first narrows the models on offer,
 * which is what stops a bad pairing being chosen; this is the backstop
 * for the paths that bypass the picker, namely a hand typed model and
 * the API.
 */
test("a tool paired with its own provider's model is fine", () => {
  assert.equal(checkAgentPairing("claude-code", "claude-opus-5").status, "ok");
  assert.equal(checkAgentPairing("claude-code", "claude-sonnet-5").status, "ok");
  // Added by hand until the models.dev snapshot carries it.
  assert.equal(checkAgentPairing("claude-code", "claude-fable-5-1").status, "ok");
  assert.equal(providerForProfile("claude-code", "claude-fable-5-1")?.id, "anthropic");
  assert.equal(providerForProfile("cursor", "claude-fable-5-1")?.id, "anthropic");
  assert.equal(checkAgentPairing("opencode", "anthropic/claude-opus-5").status, "ok");
  assert.equal(checkAgentPairing("opencode", "openai/gpt-5-pro").status, "ok");
});

test("a model the tool cannot reach is impossible", () => {
  const verdict = checkAgentPairing("claude-code", "gpt-5-pro");
  assert.equal(verdict.status, "impossible");
  assert.match(verdict.detail, /cannot run OpenAI models/);
  // The prefixed form is refused for the same reason.
  assert.equal(checkAgentPairing("claude-code", "google/gemini-3-pro").status, "impossible");
});

test("OpenRouter through a single provider tool is allowed but needs its base URL", () => {
  const verdict = checkAgentPairing("claude-code", "openrouter/auto");
  assert.equal(verdict.status, "routed");
  assert.equal(verdict.credential, "ANTHROPIC_BASE_URL");
});

test("OpenRouter through a provider naming tool needs no base URL", () => {
  assert.equal(checkAgentPairing("opencode", "openrouter/auto").status, "ok");
});

/**
 * The catalog trails the tools, so an unrecognised model must not be
 * called impossible: that would block a model released this week.
 */
test("an unrecognised model is unprovable, not impossible", () => {
  assert.equal(checkAgentPairing("claude-code", "claude-opus-9").status, "unknown");
  assert.equal(checkAgentPairing("opencode", "GLM-5.2").status, "unknown");
});

test("the fake agent accepts anything, because it calls nothing", () => {
  assert.equal(checkAgentPairing("fake", "fake-1").status, "ok");
});

/** Nothing the picker can offer may be refused by the check. */
test("every pairing the pickers offer passes", () => {
  for (const tool of MODEL_GUIDANCE) {
    for (const provider of providersForCli(tool.cli)) {
      for (const model of provider.models.slice(0, 3)) {
        const composed = modelStringFor(tool.cli, provider.id, model.id);
        const verdict = checkAgentPairing(tool.cli, composed);
        assert.notEqual(
          verdict.status,
          "impossible",
          `${tool.cli} + ${composed} is offered by the picker but refused: ${verdict.detail}`,
        );
      }
    }
    assert.notEqual(checkAgentPairing(tool.cli, tool.defaultModel).status, "impossible");
  }
});

/**
 * pool reaches one provider, and the id it takes carries the vendor
 * prefix, so the same string is both what the picker composes and what
 * Poolside's inference API accepts.
 */
test("pool resolves Poolside's own prefixed ids", () => {
  assert.equal(providerForProfile("pool", "poolside/laguna-s-2.1")?.id, "poolside");
  assert.equal(modelStringFor("pool", "poolside", "poolside/laguna-s-2.1"), "poolside/laguna-s-2.1");
  assert.equal(checkAgentPairing("pool", "poolside/laguna-s-2.1").status, "ok");
  assert.match(checkAgentPairing("pool", "poolside/laguna-s-2.1").detail, /Runs on Poolside/);
});

test("pool cannot run another company's model, and an unlisted Laguna is unprovable", () => {
  const verdict = checkAgentPairing("pool", "claude-sonnet-5");
  assert.equal(verdict.status, "impossible");
  assert.match(verdict.detail, /cannot run Anthropic models/);
  assert.match(verdict.detail, /It reaches Poolside/);
  // The Laguna ids Poolside has not published stay typeable: the
  // catalog carries one because one is documented, not because the
  // others are wrong.
  assert.equal(checkAgentPairing("pool", "poolside/laguna-m.1").status, "ok");
  assert.equal(checkAgentPairing("pool", "laguna-xl-9").status, "unknown");
});

/**
 * The OpenRouter route to the same weights, which this feature does not
 * replace: prefixed with openrouter/ it is that provider's model on a
 * provider naming tool, and pool is not offered it.
 */
test("Laguna through OpenRouter still belongs to pi and opencode", () => {
  assert.equal(checkAgentPairing("pi", "openrouter/poolside/laguna-s-2.1").status, "ok");
  assert.equal(providerForProfile("opencode", "openrouter/poolside/laguna-s-2.1")?.id, "openrouter");
  // Unprefixed, the same string is an OpenRouter id (that is how the
  // snapshot lists these weights), so a provider naming tool is told
  // OpenRouter rather than Poolside. Poolside's own endpoint is
  // reachable through pool, and only through pool.
  assert.equal(providerForProfile("pi", "poolside/laguna-s-2.1")?.id, "openrouter");
  assert.equal(providersForCli("pool").map((p) => p.id).join(), "poolside");
});

/**
 * The other route to the same weights, and the ordering that decides
 * which one a stored profile means.
 *
 * OpenRouter's own catalog namespaces these ids ("deepseek/deepseek-v3.2"),
 * so before pi and opencode reached DeepSeek directly, every
 * `deepseek/...` string on those tools resolved to OpenRouter. Adding
 * the native provider ahead of `openrouter` in BY_CLI flips that: the
 * prefix now names DeepSeek, and the explicit `openrouter/` form is the
 * only way to ask for the OpenRouter route.
 *
 * This is the property BY_CLI's order carries and nothing else states.
 * Move "deepseek" after "openrouter" and pi would bill OpenRouter for a
 * key the organization saved with DeepSeek, wearing OpenRouter's mark,
 * with every other test still green.
 */
test("a deepseek prefixed model is DeepSeek's own, and OpenRouter needs saying so", () => {
  for (const cli of ["pi", "opencode"]) {
    // Ids the OpenRouter snapshot also carries, not only the two the
    // native picker lists.
    for (const id of ["deepseek/deepseek-v3.2", "deepseek/deepseek-r1", "deepseek/deepseek-v4-pro"]) {
      assert.equal(providerForProfile(cli, id)?.id, "deepseek", `${cli} + ${id} is not DeepSeek's own`);
      assert.equal(checkAgentPairing(cli, id).status, "ok");
    }
    assert.equal(providerForProfile(cli, "openrouter/deepseek/deepseek-v3.2")?.id, "openrouter");
    assert.equal(checkAgentPairing(cli, "openrouter/deepseek/deepseek-v3.2").status, "ok");
    // The order is the mechanism, so assert the order itself.
    const ids = providersForCli(cli).map((p) => p.id);
    assert.ok(
      ids.indexOf("deepseek") < ids.indexOf("openrouter"),
      `${cli} lists OpenRouter before DeepSeek, so deepseek/ ids resolve to the wrong provider`,
    );
  }
});

/**
 * The half that stops a DeepSeek model being chosen where it cannot
 * run. Cursor and pool reach neither DeepSeek nor OpenRouter, so a
 * DeepSeek id there is refused where it is picked rather than inside a
 * sandbox.
 */
test("a DeepSeek model is refused by the tools that cannot reach DeepSeek", () => {
  for (const cli of ["cursor", "pool"]) {
    const verdict = checkAgentPairing(cli, "deepseek/deepseek-v4-pro");
    assert.equal(verdict.status, "impossible", `${cli} accepted a DeepSeek model`);
    assert.match(verdict.detail, /cannot run DeepSeek models/);
  }
  // The bare id is refused for the same reason on every tool without
  // the provider, including the two that could only reach it routed.
  for (const cli of ["claude-code", "codex", "cursor", "pool"]) {
    assert.equal(checkAgentPairing(cli, "deepseek-v4-pro").status, "impossible", `${cli} accepted a bare DeepSeek id`);
  }
  // Claude Code and Codex can still be pointed at OpenRouter, which is
  // what the prefixed form means to a tool that names no provider.
  assert.equal(checkAgentPairing("claude-code", "deepseek/deepseek-v4-pro").credential, "ANTHROPIC_BASE_URL");
  assert.equal(checkAgentPairing("codex", "deepseek/deepseek-v4-pro").credential, "OPENAI_BASE_URL");
});
