import { useEffect, useState } from "react";
import type { BentoClient, Project } from "@bento/api-client";
import { ListRowsSkeleton } from "./Skeleton.js";
import { useToast } from "./Toasts.js";
import { YamlFileActions, downloadYaml, pipelineImportSummary } from "./YamlFileActions.js";

/**
 * Import and export the YAML files that describe agents and a
 * project's pipeline. The same files live on the Agents and Pipeline
 * panels; they are here so both can be moved without opening the board.
 *
 * Agents belong to the person, so that card needs no picker. A
 * pipeline belongs to a project, so that card asks which one.
 */
export function ConfigSettings({ client }: { client: BentoClient }) {
  const toast = useToast();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [agentsImported, setAgentsImported] = useState("");
  const [pipelineImported, setPipelineImported] = useState("");

  useEffect(() => {
    void client
      .listProjects()
      .then((rows) => {
        setProjects(rows);
        setFailed(false);
        setProjectId((current) => current || rows[0]?.id || "");
      })
      .catch(() => {
        setFailed(true);
        setProjects([]);
      });
  }, [client]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (err) {
      toast.fail(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function exportAgents() {
    await act(async () => {
      downloadYaml("bento-agents.yaml", await client.exportAgents());
    });
  }

  async function importAgents(file: File) {
    setAgentsImported("");
    const ok = await act(async () => {
      const result = await client.importAgents(await file.text());
      setAgentsImported(`Imported ${result.agents} agent${result.agents === 1 ? "" : "s"}.`);
    });
    if (!ok) setAgentsImported("");
  }

  async function exportPipeline() {
    await act(async () => {
      if (!projectId) return;
      downloadYaml("bento-pipeline.yaml", await client.exportPipeline(projectId));
    });
  }

  async function importPipeline(file: File) {
    setPipelineImported("");
    const ok = await act(async () => {
      if (!projectId) return;
      setPipelineImported(pipelineImportSummary(await client.importPipeline(projectId, await file.text())));
    });
    if (!ok) setPipelineImported("");
  }

  const noProject = !projectId;

  return (
    <>
      <section className="section settings-card">
        <h3 className="settings-title">Agents file</h3>
        <p className="muted">
          Every named agent: the tool, the model, and the skill. Importing matches by name, so
          importing twice edits rather than duplicating. Agents the file leaves out are left alone.
        </p>
        <YamlFileActions
          busy={busy}
          imported={agentsImported}
          onExport={() => void exportAgents()}
          onImport={(file) => void importAgents(file)}
        />
      </section>

      <section className="section settings-card">
        <h3 className="settings-title">Pipeline file</h3>
        <p className="muted">
          A project's stages, their requirements, the agents behind them, and each repository's
          commands. Pick which project, then export or import.
        </p>
        {failed ? (
          <p className="error">Could not load the projects. Retry once the server is reachable.</p>
        ) : projects === null ? (
          <ListRowsSkeleton rows={2} />
        ) : projects.length === 0 ? (
          <p className="muted">No projects yet. Create one from the board, then export its pipeline here.</p>
        ) : (
          <label className="field">
            <span className="label">Project</span>
            <select
              className="input"
              value={projectId}
              disabled={busy}
              aria-label="Project whose pipeline to export or import"
              onChange={(e) => {
                setProjectId(e.target.value);
                setPipelineImported("");
              }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <YamlFileActions
          busy={busy}
          disabled={noProject}
          imported={pipelineImported}
          onExport={() => void exportPipeline()}
          onImport={(file) => void importPipeline(file)}
        />
      </section>
    </>
  );
}
