import { Hono } from "hono";
import { AGENT_CREDENTIALS, MODEL_CATALOG, MODEL_GUIDANCE, modelStringFor, providersForCli } from "@bento/core";

/**
 * The provider and model choices, served rather than bundled.
 *
 * The desktop app compiles a single TypeScript file with the native
 * toolchain and never reads node_modules, so it cannot import the
 * catalog from @bento/core the way the console and the CLI do. Serving
 * it keeps one source of truth: refreshing the snapshot updates every
 * client at once.
 *
 * Public on purpose. This is a list of model names, identical for every
 * tenant, and holding it behind auth would only mean a sign-in before a
 * person can see which models exist.
 */
export function catalogRoutes() {
  return new Hono()
    .get("/models", (c) => c.json(MODEL_CATALOG))
    /**
     * Line format, for clients that parse bytes rather than JSON:
     *   provider|<id>|<name>
     *   model|<providerId>|<modelId>|<modelString>|<modelName>
     * Filter to one tool with ?cli=claude-code, which is the same
     * narrowing the console and the CLI apply.
     *
     * modelString is what actually goes in an agent profile, which is
     * not always the model id: the provider agnostic tools want
     * provider/model. Resolving it here means a client that cannot
     * import @bento/core does not have to know that rule. Without a
     * ?cli it is the bare id, since the answer depends on the tool.
     */
    .get("/models/plain", (c) => {
      const cli = c.req.query("cli");
      const providers = cli ? providersForCli(cli) : MODEL_CATALOG;
      const lines: string[] = [];
      for (const provider of providers) {
        lines.push(`provider|${provider.id}|${provider.name}`);
        for (const model of provider.models) {
          const modelString = cli ? modelStringFor(cli, provider.id, model.id) : model.id;
          lines.push(`model|${provider.id}|${model.id}|${modelString}|${model.name}`);
        }
      }
      return c.text(lines.join("\n"));
    })
    /**
     * The tools a stage can run, and the credentials an organization can
     * store for them. Same reason as the model catalog: these live in
     * @bento/core, which the desktop app cannot import.
     *
     *   tool|<cli>|<defaultModel>|<label>
     *   credential|<name>|<1 secret, 0 plain>|<label>
     */
    .get("/tools/plain", (c) =>
      c.text(MODEL_GUIDANCE.map((tool) => `tool|${tool.cli}|${tool.defaultModel}|${tool.label}`).join("\n")),
    )
    .get("/credentials/plain", (c) =>
      c.text(
        AGENT_CREDENTIALS.map(
          (cred) =>
            // help is last: it is prose and may contain anything.
            `credential|${cred.name}|${cred.secret ? "1" : "0"}|${cred.label}|${cred.help.replaceAll("|", " ")}`,
        ).join("\n"),
      ),
    );
}
