import { useRef, useState } from "react";
import { open as openFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Box, Text } from "ink";
import {
  MODEL_GUIDANCE,
  checkAgentPairing,
  modelStringFor,
  providersForCli,
  type AgentCli,
} from "@bento/core";
import type { AgentProfile } from "@bento/api-client";
import { Navigator, type Choice } from "./Navigator.js";
import { Form } from "./Form.js";
import { MouseActions, MouseButton } from "./MouseControls.js";
import { terminalText } from "../terminal.js";

export type AgentDraft = {
  name: string;
  cli: AgentCli;
  model: string;
  skill: string | null;
  extraArgs: string[];
};
type Page =
  | "overview"
  | "harness"
  | "provider"
  | "model"
  | "name"
  | "customModel"
  | "skill"
  | "skillText"
  | "skillFile"
  | "advanced"
  | "arguments";

/** Edits stay local until Save, so changing a harness never partially updates an agent. */
export function AgentEditor({
  profile,
  onSave,
  onCancel,
}: {
  profile: AgentProfile;
  onSave: (draft: AgentDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<AgentDraft>({
    name: profile.name,
    cli: profile.cli,
    model: profile.model,
    skill: profile.skill ?? null,
    extraArgs: [...(profile.extraArgs ?? [])],
  });
  const [page, setPage] = useState<Page>("overview");
  const [providerId, setProviderId] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const harness = MODEL_GUIDANCE.find((tool) => tool.cli === draft.cli);
  const providers = providersForCli(draft.cli as AgentCli);
  const choice = (id: string, label: string, select: () => void): Choice => ({ id, label, select });
  function open(next: Page, text = "") {
    setError("");
    setValue(text);
    setPage(next);
  }
  function models(cli = draft.cli) {
    const options = providersForCli(cli as AgentCli);
    if (options.length === 1) {
      setProviderId(options[0]!.id);
      open("model");
    } else if (options.length > 1) open("provider");
    else open("customModel", draft.model);
  }
  function setModel(model: string) {
    const pairing = checkAgentPairing(draft.cli as AgentCli, model.trim());
    if (!model.trim()) {
      setError("Enter a model.");
      return;
    }
    if (pairing.status === "impossible") {
      setError(pairing.detail);
      return;
    }
    setDraft({ ...draft, model: model.trim() });
    open("overview");
  }
  async function save() {
    if (pending.current) return;
    const next = {
      ...draft,
      name: draft.name.trim(),
      model: draft.model.trim(),
      skill: draft.skill?.trim() || null,
    };
    if (!next.name || !next.model) {
      setError("Name and model are required.");
      return;
    }
    if ((next.skill?.length ?? 0) > 20000) {
      setError("SKILL.md instructions must be at most 20,000 characters.");
      return;
    }
    const pairing = checkAgentPairing(next.cli as AgentCli, next.model);
    if (pairing.status === "impossible") {
      setError(pairing.detail);
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function importSkill(filename: string) {
    if (pending.current) return;
    if (!filename.trim()) {
      setError("Enter the path to a SKILL.md file on this machine.");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const input = filename.trim();
      const localPath = input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
      const file = await openFile(localPath, "r");
      let contents: string;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 80000)
          throw new Error("Choose a text file with at most 20,000 characters.");
        contents = await file.readFile("utf8");
        if (contents.length > 20000 || contents.includes("\0"))
          throw new Error("Choose a text file with at most 20,000 characters.");
      } finally {
        await file.close();
      }
      setDraft({ ...draft, skill: contents });
      open("overview");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  if (busy) return <Text color="gray">{page === "skillFile" ? "Reading SKILL.md…" : "Saving agent…"}</Text>;

  let title = `Edit agent: ${profile.name}`;
  let choices: Choice[] = [];
  if (page === "overview")
    choices = [
      choice("name", `Name: ${draft.name}`, () => open("name", draft.name)),
      choice("harness", `Harness: ${harness?.label ?? draft.cli}`, () => open("harness")),
      choice("model", `Model: ${draft.model}`, () => models()),
      choice(
        "skill",
        `Prompt (SKILL.md): ${draft.skill ? (draft.skill.split("\n").find((line) => line.trim()) ?? "Prompt set") : "No prompt"}`,
        () => open("skill"),
      ),
      choice("advanced", "Advanced options", () => open("advanced")),
      choice("save", "Save changes", () => {
        void save();
      }),
      choice("cancel", "Cancel", onCancel),
    ];
  if (page === "harness") {
    title = "Choose harness";
    choices = MODEL_GUIDANCE.map((tool) =>
      choice(tool.cli, `${tool.label}${tool.cli === draft.cli ? " (current)" : ""}`, () => {
        // Changing harness starts at its default model. Other draft fields stay intact.
        setDraft({
          ...draft,
          cli: tool.cli as AgentCli,
          model: tool.cli === draft.cli ? draft.model : tool.defaultModel,
        });
        open("overview");
      }),
    );
  }
  if (page === "provider") {
    title = "Choose model provider";
    choices = providers.map((provider) =>
      choice(provider.id, provider.name, () => {
        setProviderId(provider.id);
        open("model");
      }),
    );
    choices.push(choice("custom", "Type a model ID", () => open("customModel", draft.model)));
  }
  if (page === "model") {
    title = "Choose model";
    choices = (providers.find((provider) => provider.id === providerId)?.models ?? []).map((model) => {
      const id = modelStringFor(draft.cli as AgentCli, providerId, model.id);
      return choice(id, `${model.name} (${id})${id === draft.model ? " (current)" : ""}`, () => setModel(id));
    });
    choices.unshift(
      choice("custom", `Type a model ID (current: ${draft.model})`, () => open("customModel", draft.model)),
    );
  }
  if (page === "skill") {
    title = "Agent prompt (SKILL.md)";
    choices = [
      choice("edit", "Edit prompt", () => open("skillText", draft.skill ?? "")),
      choice("file", "Load a SKILL.md file", () => open("skillFile")),
      choice("clear", "Clear prompt", () => {
        setDraft({ ...draft, skill: null });
        open("overview");
      }),
    ];
  }
  if (page === "advanced") {
    title = "Advanced agent options";
    choices = [
      choice("arguments", `Extra CLI arguments: ${JSON.stringify(draft.extraArgs)}`, () =>
        open("arguments", JSON.stringify(draft.extraArgs)),
      ),
    ];
  }
  const form = ["name", "customModel", "skillText", "skillFile", "arguments"].includes(page);
  const formTitles: Partial<Record<Page, string>> = {
    name: "Agent name",
    customModel: "Model ID",
    skillText: "Edit agent prompt",
    skillFile: "Load SKILL.md from this machine",
    arguments: "Extra CLI arguments (JSON array)",
  };
  if (form) title = formTitles[page]!;
  return (
    <Box flexDirection="column">
      {form ? (
        <Form
          key={page}
          title={title}
          fields={[
            {
              id: "value",
              label: page === "skillText" ? "Prompt (SKILL.md)" : title,
              value,
              multiline: page === "skillText",
            },
          ]}
          initialValues={{ value }}
          onValuesChange={({ value = "" }) => setValue(value)}
          submitLabel={page === "skillFile" ? "Load file" : "Apply to draft"}
          onCancel={() =>
            open(page.startsWith("skill") ? "skill" : page === "arguments" ? "advanced" : "overview")
          }
          onSubmit={({ value: text = "" }) => {
            if (page === "customModel") setModel(text);
            else if (page === "skillFile") void importSkill(text);
            else if (page === "arguments") {
              try {
                const args: unknown = JSON.parse(text);
                if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
                  throw new Error("invalid arguments");
                setDraft({ ...draft, extraArgs: args });
                open("overview");
              } catch {
                setError('Enter an array of strings, for example ["--verbose"].');
              }
            } else if (page === "name") {
              if (text.trim()) {
                setDraft({ ...draft, name: text.trim() });
                open("overview");
              } else setError("Enter a name.");
            } else {
              setDraft({ ...draft, skill: text });
              open("overview");
            }
          }}
        />
      ) : (
        <Navigator
          key={page}
          title={title}
          choices={choices}
          onClose={() => (page === "overview" ? onCancel() : open("overview"))}
        />
      )}
      {page === "overview" && (
        <MouseActions>
          <MouseButton
            label="Save changes"
            onClick={() => {
              void save();
            }}
          />
          <MouseButton label="Cancel" onClick={onCancel} />
        </MouseActions>
      )}
      {error && (
        <Text color="red" wrap="truncate-end">
          {terminalText(error)}
        </Text>
      )}
    </Box>
  );
}
