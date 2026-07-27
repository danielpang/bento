import { ApiError, unwrapError } from "@bento/api-client";
import { checkAgentPairing } from "@bento/core";
import { LocalRunner } from "./runner.js";
import { startEmbedded } from "./embedded.js";
import { FileTokenStore } from "./credentials.js";
import type { CliOptions } from "./cli-options.js";
import { prepareRepositoryPath, repositoryPathOwnerForMode } from "./repository-path.js";

/**
 * Status lines for a supervising process.
 *
 * The Mac app spawns these commands and reads stdout line by line, so
 * every line is one event with a stable prefix and no formatting. Keep
 * this contract stable: parsing happens in a Native SDK core that has no
 * JSON and works on raw bytes.
 */
function emit(event: string, detail = ""): void {
  // A person running `bento login` in a terminal gets sentences; a
  // supervising app (the Mac helper) reads the machine lines. The
  // event vocabulary is tiny, so the translation lives here.
  if (process.stdout.isTTY) {
    const spoken: Record<string, string> = {
      verify_url: `Open this page to sign in: ${detail}`,
      verify_code: `Enter this code: ${detail}`,
      token: "Signed in. The TUI and runner will use this login.",
      // Every event needs a sentence here, or a person watching
      // `bento serve` in their own terminal reads the wire protocol.
      ready: `Ready. The board and API are at ${detail}`,
      sandbox: `Agents run in ${detail}.`,
      stopping: "Stopping. Waiting for the sandboxes to close.",
      status: detail,
      error: detail,
    };
    const line = spoken[event];
    if (line !== undefined) {
      console.log(line);
      return;
    }
  }
  console.log(detail ? `bento:${event} ${detail}` : `bento:${event}`);
}

/**
 * Runs the whole stack with no terminal UI, so another application can
 * supervise it and talk to the API over HTTP.
 */
export async function runServe(options: CliOptions): Promise<void> {
  try {
    const handle = await startEmbedded(options, (message) => emit("status", message));
    emit("ready", handle.url);
    emit("sandbox", handle.sandbox);

    const shutdown = async () => {
      emit("stopping");
      await handle.stop().catch(() => {});
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    // Hold the process open; the server owns its own handles.
    await new Promise(() => {});
  } catch (err) {
    emit("error", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Runs only the claim loop: agents execute here while a server holds the
 * board. Nothing is served locally, so there is no port to connect to.
 */
export async function runRunner(options: CliOptions): Promise<void> {
  if (!options.server) {
    emit("error", "runner needs --server <url>");
    process.exit(2);
  }

  const runner = new LocalRunner({
    baseUrl: options.server,
    tokens: new FileTokenStore(options.server),
    runnerId: options.runnerId,
    sandbox: options.sandbox,
    dataDir: options.dataDir,
    onStatus: (message) => emit("status", message),
  });

  emit("ready", options.server);
  emit("sandbox", options.sandbox);

  const shutdown = () => {
    emit("stopping");
    runner.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runner.start();
}

/**
 * Lists, adds and removes the repositories a project spans.
 *
 * The interactive setup screen can already do this, but a screen cannot
 * be scripted: connecting a project's three repositories in a
 * provisioning script, or in CI, needs a command. Output is plain lines
 * rather than the `bento:` event protocol, because a person reads this
 * one.
 */
export async function runRepos(options: CliOptions): Promise<void> {
  const { BentoClient } = await import("@bento/api-client");

  // Local mode has no server to talk to until one is running, so this
  // starts the same embedded stack the board does and stops it after.
  let embedded: { url: string; stop(): Promise<void> } | undefined;
  let baseUrl = options.server;
  if (!baseUrl) {
    embedded = await startEmbedded(options, bootProgress(options));
    baseUrl = embedded.url;
  }

  try {
    const client = new BentoClient({ baseUrl, tokens: new FileTokenStore(baseUrl) });
    const projects = await client.listProjects();
    if (projects.length === 0) {
      console.error("no projects yet. Run `bento setup` to connect one.");
      process.exitCode = 1;
      return;
    }

    // A name or an id, and the only project when neither is given.
    const wanted = options.project;
    const project = wanted
      ? projects.find((p) => p.id === wanted || p.name === wanted)
      : projects.length === 1
        ? projects[0]
        : undefined;
    if (!project) {
      console.error(
        wanted
          ? `no project called "${wanted}". Known: ${projects.map((p) => p.name).join(", ")}`
          : `several projects, so name one with --project: ${projects.map((p) => p.name).join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }

    const [action, argument] = options.positionals;
    switch (action) {
      case undefined:
      case "list": {
        const repos = await client.listRepositories(project.id);
        // Tab separated, so cut(1) still works now that a row can carry
        // commands with spaces in them.
        for (const repo of repos) {
          console.log(
            [repo.name, repo.localPath, repo.setupCommand ?? "", repo.testCommand ?? ""].join("\t"),
          );
        }
        return;
      }
      case "add": {
        if (!argument) {
          const location = options.mode === "client" ? "server path" : "path";
          throw new Error(`repos add needs a ${location}: bento repos add /path/to/checkout`);
        }
        const localPath = prepareRepositoryPath(argument, repositoryPathOwnerForMode(options.mode));
        const added = await client.addRepository(project.id, {
          localPath,
          ...(options.setupCommand !== undefined ? { setupCommand: options.setupCommand } : {}),
          ...(options.testCommand !== undefined ? { testCommand: options.testCommand } : {}),
        });
        console.log(`${added.name}\t${added.localPath}`);
        return;
      }
      case "set": {
        if (options.setupCommand === undefined && options.testCommand === undefined) {
          throw new Error("repos set needs --setup or --test: there is nothing else to change");
        }
        const repos = await client.listRepositories(project.id);
        const target = repos.find((r) => r.name === argument || r.id === argument);
        if (!target) throw new Error(`no repository called "${argument}" in ${project.name}`);
        const updated = await client.updateRepository(project.id, target.id, {
          ...(options.setupCommand !== undefined ? { setupCommand: options.setupCommand } : {}),
          ...(options.testCommand !== undefined ? { testCommand: options.testCommand } : {}),
        });
        console.log(
          [updated.name, updated.setupCommand ?? "", updated.testCommand ?? ""].join("\t"),
        );
        return;
      }
      case "remove": {
        const repos = await client.listRepositories(project.id);
        const target = repos.find((r) => r.name === argument || r.id === argument);
        if (!target) throw new Error(`no repository called "${argument}" in ${project.name}`);
        await client.removeRepository(project.id, target.id);
        console.log(`removed ${target.name}`);
        return;
      }
      default:
        throw new Error(`unknown repos action "${action}". Use list, add, set, or remove.`);
    }
  } catch (err) {
    console.error(readableError(err));
    process.exitCode = 1;
  } finally {
    await embedded?.stop().catch(() => {});
  }
}

/**
 * Reads and writes a project's pipeline as a YAML file.
 *
 * A pipeline is the part of Bento a team tunes for weeks: six stages,
 * what each one must satisfy, and the agent and instructions behind
 * each. Without a file it lives in one database and is rebuilt by hand
 * anywhere else, so this puts it beside the code it describes and into
 * whatever review the rest of that repository gets.
 */
export async function runPipeline(options: CliOptions): Promise<void> {
  const { BentoClient } = await import("@bento/api-client");
  const { readFile, writeFile } = await import("node:fs/promises");

  let embedded: { url: string; stop(): Promise<void> } | undefined;
  let baseUrl = options.server;
  if (!baseUrl) {
    embedded = await startEmbedded(options, bootProgress(options));
    baseUrl = embedded.url;
  }

  try {
    const client = new BentoClient({ baseUrl, tokens: new FileTokenStore(baseUrl) });
    const project = await resolveProject(client, options);
    if (!project) return;

    const [action, argument] = options.positionals;
    switch (action) {
      case "export": {
        const yaml = await client.exportPipeline(project.id);
        // A path writes a file and says so on stderr; without one the
        // document goes to stdout, so it can be piped.
        if (argument) {
          await writeFile(argument, yaml, "utf8");
          console.error(`bento: wrote ${argument}`);
        } else {
          process.stdout.write(yaml);
        }
        return;
      }
      case "import": {
        if (!argument) throw new Error("pipeline import needs a file: bento pipeline import pipeline.yaml");
        const result = await client.importPipeline(project.id, await readFile(argument, "utf8"));
        console.log(`${result.stages} stages, ${result.agents} agents`);
        for (const name of result.removedStages) console.log(`removed stage\t${name}`);
        // Named rather than swallowed: a file written for another
        // project can carry commands for checkouts this one lacks.
        for (const name of result.skippedRepositories) {
          console.error(`bento: no repository called "${name}" here, so its commands were skipped`);
        }
        return;
      }
      default:
        throw new Error(`unknown pipeline action "${action ?? ""}". Use export or import.`);
    }
  } catch (err) {
    console.error(readableError(err));
    process.exitCode = 1;
  } finally {
    await embedded?.stop().catch(() => {});
  }
}

/**
 * The project a command acts on: the only one, or the one named. Prints
 * the reason and leaves a non-zero exit when there is no answer.
 */
async function resolveProject(
  client: { listProjects: () => Promise<{ id: string; name: string }[]> },
  options: CliOptions,
): Promise<{ id: string; name: string } | null> {
  const projects = await client.listProjects();
  if (projects.length === 0) {
    console.error("no projects yet. Run `bento setup` to connect one.");
    process.exitCode = 1;
    return null;
  }
  const wanted = options.project;
  const project = wanted
    ? projects.find((p) => p.id === wanted || p.name === wanted)
    : projects.length === 1
      ? projects[0]
      : undefined;
  if (!project) {
    console.error(
      wanted
        ? `no project called "${wanted}". Known: ${projects.map((p) => p.name).join(", ")}`
        : `several projects, so name one with --project: ${projects.map((p) => p.name).join(", ")}`,
    );
    process.exitCode = 1;
    return null;
  }
  return project;
}

/**
 * Where the local stack's startup lines go.
 *
 * They are progress, not failure, so they are prefixed: a script
 * capturing stderr was collecting "Starting the local database..." as
 * error output. Silencing them entirely is what --quiet is for, and it
 * has to be asked for, because dropping them turns a slow database
 * start into a command that appears to hang.
 */
function bootProgress(options: CliOptions): (message: string) => void {
  if (options.quiet) return () => {};
  return (message: string) => console.error(`bento: ${message}`);
}

/**
 * The API client throws with the response body as its message, so a
 * refusal arrives as `{"error":"..."}`. A person reading a terminal
 * wants the sentence, not the envelope it came in.
 */
function readableError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // A 401 has one fix, so name it instead of printing "Unauthorized".
  if (err instanceof ApiError && err.status === 401) {
    return `${message}. Sign in first: bento login --server <url>`;
  }
  // ApiError has already done this, but an error from anywhere else
  // can still arrive carrying a response body, and unwrapping is the
  // same job either way: one implementation, not two that can drift.
  return unwrapError(message);
}

/**
 * The skill as one field: a dash, or its opening words. The whole text
 * is a paragraph and would swamp the line, but its absence is the
 * thing worth being able to see at a glance.
 */
function skillColumn(skill: string | null | undefined): string {
  if (!skill) return "-";
  const oneLine = skill.replaceAll(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}...` : oneLine;
}

/**
 * Lists, adds, edits and removes coding agents.
 *
 * Editing exists as its own verb because replacing an agent is not the
 * same thing: stages point at an agent by id, so deleting one and
 * adding another leaves every stage that used it pointing at nothing,
 * while editing carries them all along.
 */
export async function runAgents(options: CliOptions): Promise<void> {
  const { BentoClient } = await import("@bento/api-client");

  let embedded: { url: string; stop(): Promise<void> } | undefined;
  let baseUrl = options.server;
  if (!baseUrl) {
    embedded = await startEmbedded(options, bootProgress(options));
    baseUrl = embedded.url;
  }

  try {
    const client = new BentoClient({ baseUrl, tokens: new FileTokenStore(baseUrl) });
    const [action, subject] = options.positionals;

    const find = async (nameOrId: string) => {
      const profiles = await client.listProfiles();
      const found = profiles.find((p) => p.id === nameOrId || p.name === nameOrId);
      if (!found) {
        throw new Error(
          `no agent called "${nameOrId}". Known: ${profiles.map((p) => p.name).join(", ") || "none"}`,
        );
      }
      return found;
    };

    switch (action) {
      case undefined:
      case "list": {
        // The skill is what tells two agents on the same tool and model
        // apart, so it earns a column; a dash keeps the shape stable
        // for anything reading these lines with cut.
        for (const p of await client.listProfiles()) {
          console.log(`${p.name}\t${p.cli}\t${p.model}\t${skillColumn(p.skill)}`);
        }
        return;
      }
      case "add": {
        // bento agents add <name> --tool <cli> --model <model>
        if (!subject) throw new Error("agents add needs a name: bento agents add Reviewer --tool claude-code");
        if (!options.tool || !options.model) {
          const missing = [!options.tool && "--tool", !options.model && "--model"].filter(Boolean).join(" and ");
          throw new Error(`agents add needs ${missing}: bento agents add Reviewer --tool claude-code --model claude-sonnet-5`);
        }
        // The same check the console makes, in the same words: a tool
        // that cannot reach a model fails thirty seconds into a run,
        // long after the command that chose the pairing has returned.
        const pairing = checkAgentPairing(options.tool, options.model);
        if (pairing.status === "impossible") throw new Error(pairing.detail);
        const made = await client.createProfile({
          name: subject,
          cli: options.tool,
          model: options.model,
          ...(options.skill ? { skill: options.skill } : {}),
        });
        console.log(`${made.name}\t${made.cli}\t${made.model}\t${skillColumn(made.skill)}`);
        return;
      }
      case "edit": {
        if (!subject) throw new Error("agents edit needs a name: bento agents edit Reviewer --model claude-opus-5");
        const changes = {
          ...(options.agentName ? { name: options.agentName } : {}),
          ...(options.tool ? { cli: options.tool } : {}),
          ...(options.model ? { model: options.model } : {}),
          // An empty --skill clears it; absent leaves it alone.
          ...(options.skill !== undefined ? { skill: options.skill || null } : {}),
        };
        if (Object.keys(changes).length === 0) {
          throw new Error("nothing to change. Pass --name, --tool or --model.");
        }
        const target = await find(subject);
        // Checked against the merged result, so changing only the model
        // is judged against the tool the agent already has.
        const pairing = checkAgentPairing(changes.cli ?? target.cli, changes.model ?? target.model);
        if (pairing.status === "impossible") throw new Error(pairing.detail);
        const updated = await client.updateProfile(target.id, changes);
        console.log(`${updated.name}\t${updated.cli}\t${updated.model}\t${skillColumn(updated.skill)}`);
        return;
      }
      case "remove": {
        if (!subject) throw new Error("agents remove needs a name");
        const target = await find(subject);
        await client.deleteProfile(target.id);
        console.log(`removed ${target.name}`);
        return;
      }
      default:
        throw new Error(`unknown agents action "${action}". Use list, add, edit, or remove.`);
    }
  } catch (err) {
    console.error(readableError(err));
    process.exitCode = 1;
  } finally {
    await embedded?.stop().catch(() => {});
  }
}

/**
 * Signs this machine in.
 *
 * The desktop app spawns this rather than implementing the device flow
 * itself: its core has no JSON parser, and reusing this path means one
 * implementation of the polling contract. The token is written to the
 * shared credentials file, so the TUI and runner pick it up too, and
 * emitted for the supervising app to read.
 */
export async function runLogin(options: CliOptions): Promise<void> {
  if (!options.server) {
    emit("error", "login needs --server <url>");
    process.exit(2);
  }

  const tokens = new FileTokenStore(options.server);
  const existing = await tokens.get();
  if (existing) {
    // A stored token proves a login happened, not that it still works:
    // one that has been revoked reported "Signed in." while every
    // other command answered 401. One authenticated call settles it.
    if (await stillAccepted(options.server, tokens)) {
      emit("token", existing);
      return;
    }
    emit("status", "The saved login is no longer accepted. Signing in again.");
    await tokens.set(null);
  }

  try {
    const { DeviceFlow } = await import("@bento/api-client");
    const flow = new DeviceFlow({
      baseUrl: options.server,
      clientId: "bento-desktop",
      onPrompt: (code) => {
        // Two lines so a supervising UI can show both without parsing.
        emit("verify_url", code.verification_uri_complete ?? code.verification_uri);
        emit("verify_code", code.user_code);
      },
    });
    const token = await flow.login();
    await tokens.set(token);
    emit("token", token);
  } catch (err) {
    emit("error", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Whether the stored token still opens the door. Only a refusal counts
 * as an answer: a server that cannot be reached says nothing about the
 * token, and starting a device flow against one would fail the same
 * way, more slowly.
 */
async function stillAccepted(server: string, tokens: FileTokenStore): Promise<boolean> {
  const { BentoClient } = await import("@bento/api-client");
  try {
    await new BentoClient({ baseUrl: server, tokens }).listProjects();
    return true;
  } catch (err) {
    return !(err instanceof ApiError && (err.status === 401 || err.status === 403));
  }
}
