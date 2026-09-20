import { utilityProcess, type UtilityProcess } from "electron";
import type { DesktopSettings, RuntimeEvent } from "./contracts.js";

export class RuntimeController {
  private child: UtilityProcess | undefined;
  private stopping: Promise<void> | undefined;
  constructor(private directory: string, private progress: (message: string) => void, private failed: (message: string) => void) {}

  async start(settings: DesktopSettings): Promise<string> {
    if (this.child) throw new Error("The local runtime is already running.");
    const child = utilityProcess.fork(`${this.directory}/runtime.js`, [], {
      serviceName: "Bento local server", stdio: "pipe",
      env: { ...process.env, PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":") },
    });
    this.child = child;
    child.stdout?.on("data", (bytes: Buffer) => process.stdout.write(bytes));
    child.stderr?.on("data", (bytes: Buffer) => process.stderr.write(bytes));
    return new Promise<string>((resolve, reject) => {
      let ready = false;
      child.on("message", (event: RuntimeEvent) => {
        if (event.type === "progress") this.progress(event.message);
        if (event.type === "ready") { ready = true; resolve(event.url); }
        if (event.type === "error") {
          if (ready) this.failed(event.message);
          else reject(new Error(event.message));
        }
      });
      child.once("exit", (code) => {
        this.child = undefined;
        if (!ready) reject(new Error(`The local server stopped during startup (exit ${code}).`));
        else if (!this.stopping) this.failed("The local server stopped. Open Connection Settings to restart it.");
      });
      child.postMessage({ type: "start", settings, sandboxDirectory: `${this.directory}/sandbox` });
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return;
    this.stopping = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 12_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      child.postMessage({ type: "stop" });
    });
    await this.stopping;
    this.child = undefined;
    this.stopping = undefined;
  }
}
