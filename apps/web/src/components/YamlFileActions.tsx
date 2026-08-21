import { useRef } from "react";

/**
 * Export and import buttons for a YAML config file, with the hidden
 * file picker the Import button opens.
 *
 * Shared by the Agents panel, the Pipeline panel, and Settings, so the
 * same two operations do not grow three slightly different pickers.
 */
export function YamlFileActions({
  busy,
  disabled,
  imported,
  onExport,
  onImport,
}: {
  busy: boolean;
  disabled?: boolean;
  imported: string;
  onExport: () => void;
  onImport: (file: File) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <>
      <div className="actions">
        <button type="button" className="btn" disabled={busy || disabled} onClick={onExport}>
          Export YAML
        </button>
        <button type="button" className="btn" disabled={busy || disabled} onClick={() => fileInput.current?.click()}>
          Import YAML
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".yaml,.yml,application/yaml,text/yaml"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared before the read, so choosing the same file
            // twice fires again: the second import is usually the
            // one after a fix.
            e.target.value = "";
            if (file) onImport(file);
          }}
        />
      </div>
      {imported && <p className="muted">{imported}</p>}
    </>
  );
}

/** Downloaded rather than shown: the point of the file is to live somewhere else. */
export function downloadYaml(filename: string, yaml: string) {
  const url = URL.createObjectURL(new Blob([yaml], { type: "application/yaml" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function pipelineImportSummary(result: {
  stages: number;
  agents: number;
  removedStages: string[];
  skippedRepositories: string[];
}): string {
  const parts = [`Imported ${result.stages} stages and ${result.agents} agents.`];
  if (result.removedStages.length > 0) parts.push(`Removed: ${result.removedStages.join(", ")}.`);
  if (result.skippedRepositories.length > 0) {
    parts.push(
      `No repository here is called ${result.skippedRepositories.join(" or ")}, so those commands were skipped.`,
    );
  }
  return parts.join(" ");
}
