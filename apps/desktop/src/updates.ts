import type { AppUpdater, UpdateInfo } from "electron-updater";
import type { DesktopUpdateNotice } from "./contracts.js";

type Phase = "idle" | "checking" | "downloading" | "ready" | "installing";
export type UpdateDriver = Pick<AppUpdater, "autoDownload" | "autoInstallOnAppQuit" | "allowPrerelease" | "allowDowngrade" | "on" | "checkForUpdates" | "quitAndInstall">;
export interface UpdateUi {
  changed(): void;
  notify(version: string): void;
  message(message: string, detail: string): Promise<void>;
  confirmRestart(version: string): Promise<boolean>;
  prepareInstall(): Promise<void>;
  shutdown(): Promise<void>;
  shutdownFailed(): void;
}

export interface ManualUpdateOptions {
  arch: "arm64" | "x64";
  confirmDownload(version: string): Promise<boolean>;
  openDownload(url: string): Promise<void>;
}

/** Only open the matching installer from Bento's release, never a feed-supplied URL. */
export function manualDownloadUrl(info: UpdateInfo, arch: ManualUpdateOptions["arch"]): string {
  const version = info.version;
  const tag = (info as UpdateInfo & { tag?: unknown }).tag;
  const name = `Bento-${version}-${arch}.dmg`;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    || (tag !== `v${version}` && tag !== version)
    || !info.files.some(file => file.url === name)) {
    throw Object.assign(new Error("This release does not include a matching Mac installer."), { code: "BENTO_INSTALLER_NOT_FOUND" });
  }
  return `https://github.com/danielpang/bento/releases/download/${tag}/${name}`;
}

export function updateErrorDetail(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (["ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", "ERR_UPDATER_NO_PUBLISHED_VERSIONS", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "BENTO_INSTALLER_NOT_FOUND"].includes(code ?? "")) {
    return "A macOS update is not available from the release service yet. Please try again later.";
  }
  return "Bento could not download or verify the update. Check your internet connection and try again later. Your current app and projects are kept.";
}

/** Owns one check/download at a time. Installation always requires consent. */
export class DesktopUpdates {
  private phase: Phase = "idle";
  private version = "";
  private manualUrl: string | undefined;
  private dismissedVersion = "";
  private task: Promise<void> | undefined;
  private interactive = false;
  private prompting = false;
  private disposed = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private driver: UpdateDriver, private ui: UpdateUi, private disabledReason?: string, private manual?: ManualUpdateOptions) {
    driver.autoDownload = !manual;
    // On macOS this also defers handing the ZIP to Squirrel until consent.
    driver.autoInstallOnAppQuit = false;
    driver.allowPrerelease = false;
    driver.allowDowngrade = false;
    driver.on("error", (error) => {
      console.warn("[updates]", error);
      // checkForUpdates/downloadPromise reject as well. Their owner shows the
      // one requested dialog; background failures never interrupt local work.
    });
    driver.on("update-available", () => { if (!this.manual) this.setPhase("downloading"); });
    driver.on("update-downloaded", (info) => {
      if (this.disposed || this.manual) return;
      this.version = info.version;
      this.setPhase("ready");
      if (!this.interactive) this.ui.notify(info.version);
    });
  }

  get menu() {
    const labels: Record<Phase, string> = { idle: "Check for Updates...", checking: "Checking for Updates...", downloading: "Downloading Update...", ready: "Restart to Update...", installing: "Preparing Update..." };
    return { label: labels[this.phase], enabled: !this.disposed && this.phase !== "installing" };
  }

  get notice(): DesktopUpdateNotice | null {
    if (this.disposed || this.disabledReason || !this.version || this.dismissedVersion === this.version) return null;
    if (this.manual ? !this.manualUrl : this.phase !== "ready" && this.phase !== "installing") return null;
    return { version: this.version, action: this.manual ? "download" : "restart", busy: this.phase === "checking" || this.phase === "installing" || this.prompting };
  }

  dismissNotice() {
    this.dismissedVersion = this.version;
    this.ui.changed();
  }

  start() {
    if (this.disabledReason || this.disposed || this.timers.length) return;
    this.timers.push(setTimeout(() => void this.check(), 30_000));
    this.timers.push(setInterval(() => void this.check(), 6 * 60 * 60 * 1000));
    for (const timer of this.timers) timer.unref();
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  async check(interactive = false): Promise<void> {
    if (this.disposed || this.phase === "installing") return;
    if (this.disabledReason) {
      if (interactive && !this.prompting) {
        this.prompting = true;
        try { await this.ui.message("Updates are unavailable", this.disabledReason); }
        finally { this.prompting = false; }
      }
      return;
    }
    this.interactive ||= interactive;
    if (this.task) return this.task;
    if (this.phase === "ready") {
      if (interactive) await this.offerRestart();
      return;
    }
    this.setPhase("checking");
    this.task = this.performCheck();
    try { await this.task; } finally { this.task = undefined; this.interactive = false; }
  }

  private async performCheck() {
    try {
      const result = await this.driver.checkForUpdates();
      if (this.manual && result?.isUpdateAvailable) {
        if (this.disposed) return;
        const url = manualDownloadUrl(result.updateInfo, this.manual.arch);
        this.version = result.updateInfo.version;
        this.manualUrl = url;
        if (this.interactive && await this.manual.confirmDownload(result.updateInfo.version) && !this.disposed) {
          await this.manual.openDownload(url);
          this.dismissedVersion = this.version;
        }
        this.setPhase("idle");
        return;
      }
      await result?.downloadPromise;
      if (this.disposed) return;
      if (this.phase === "ready") {
        if (this.interactive) await this.offerRestart();
      } else {
        this.manualUrl = undefined;
        this.setPhase("idle");
        if (this.interactive) await this.ui.message("Bento is up to date", "You have the latest stable version of Bento.");
      }
    } catch (error) {
      this.setPhase("idle");
      if (this.interactive && !this.disposed) await this.ui.message("Could not check for updates", updateErrorDetail(error));
    }
  }

  private async offerRestart() {
    if (this.prompting || this.disposed) return;
    this.prompting = true;
    this.ui.changed();
    try {
      if (!await this.ui.confirmRestart(this.version) || this.disposed) return;
      this.setPhase("installing");
      // Verify/stage with native Squirrel before stopping a working server.
      await this.ui.prepareInstall();
      if (this.disposed) return;
      await this.ui.shutdown();
      this.driver.quitAndInstall();
    } catch (error) {
      console.warn("[updates] Could not install", error);
      this.ui.shutdownFailed();
      this.setPhase("ready");
      if (!this.disposed) await this.ui.message("Could not install the update", updateErrorDetail(error));
    } finally {
      this.prompting = false;
      this.interactive = false;
      if (!this.disposed) this.ui.changed();
    }
  }

  private setPhase(phase: Phase) {
    this.phase = phase;
    if (!this.disposed) this.ui.changed();
  }
}
