import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The Mac app tells hosted Bento when it is installed and when its
 * version changes, so installs and updates can be counted. Nothing else
 * about the person or their work is sent: a random install id, the
 * version before and after, the architecture and the macOS version.
 * Local Bento's server still sends nothing (`posthogApiKey`).
 *
 * The app reports itself because nothing else can see an install: the
 * DMG comes from GitHub, and an update from electron-updater reading
 * GitHub's release files. A report that fails (offline, server down) is
 * tried again on the next launch, so it is late rather than lost.
 */

export const DESKTOP_EVENTS_URL = "https://app.usebento.ai/api/desktop/events";
const STATE_FILE = "install.json";

export interface InstallState {
  installId: string;
  /**
   * Whether this profile was new when the app first kept this file. A
   * profile with saved connections predates install reports, so its
   * first report is an update from a version nobody recorded.
   */
  fresh: boolean;
  /** The version last reported, once a report went through. */
  reportedVersion?: string;
}

export interface InstallReport {
  event: "installed" | "updated";
  install_id: string;
  version: string;
  previous_version?: string;
  arch: "arm64" | "x64";
  os_version?: string;
}

/** What this launch has to say, or null when this version was already reported. */
export function pendingReport(state: InstallState, app: { version: string; arch: "arm64" | "x64"; osVersion?: string }): InstallReport | null {
  if (state.reportedVersion === app.version) return null;
  const base = { install_id: state.installId, version: app.version, arch: app.arch, ...(app.osVersion ? { os_version: app.osVersion } : {}) };
  if (state.reportedVersion) return { event: "updated", ...base, previous_version: state.reportedVersion };
  return state.fresh ? { event: "installed", ...base } : { event: "updated", ...base, previous_version: "unknown" };
}

export interface InstallReportDeps {
  /** The app's profile directory (userData). */
  directory: string;
  version: string;
  arch: "arm64" | "x64";
  osVersion?: string;
  /** Whether the profile already held saved connections when this launch began. */
  configured: boolean;
  endpoint?: string;
  fetch?: typeof fetch;
}

async function readState(file: string): Promise<InstallState | null> {
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as Partial<InstallState>;
    if (typeof saved.installId !== "string" || !/^[0-9a-f-]{36}$/.test(saved.installId)) return null;
    return {
      installId: saved.installId,
      fresh: saved.fresh === true,
      ...(typeof saved.reportedVersion === "string" ? { reportedVersion: saved.reportedVersion } : {}),
    };
  } catch {
    return null;
  }
}

async function writeState(directory: string, state: InstallState): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, STATE_FILE);
  await writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

/**
 * Reports this launch's install or update, once per version. Never
 * throws: a launch must not wait on, or fail for, a count.
 */
export async function reportInstall(deps: InstallReportDeps): Promise<InstallReport | null> {
  try {
    const file = path.join(deps.directory, STATE_FILE);
    let state = await readState(file);
    if (!state) {
      // Kept before the report goes, so a launch that is offline still
      // remembers that this profile was a new install.
      state = { installId: randomUUID(), fresh: !deps.configured };
      await writeState(deps.directory, state);
    }
    const report = pendingReport(state, deps);
    if (!report) return null;
    const response = await (deps.fetch ?? fetch)(deps.endpoint ?? DESKTOP_EVENTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    // A refusal is not retried forever: only a server that could not
    // answer (5xx, or a 429 meter) leaves the version for next launch.
    if (response.status >= 500 || response.status === 429) return null;
    await writeState(deps.directory, { ...state, reportedVersion: deps.version });
    return response.ok ? report : null;
  } catch {
    return null;
  }
}
