export type DesktopMode = "local" | "remote";

export interface DesktopSettings {
  mode: DesktopMode;
  serverUrl: string;
  dataDir: string;
  databaseUrl: string;
  sandbox: "docker" | "local-process";
  sandboxImage: string;
}

export interface DesktopStatus {
  phase: "idle" | "starting" | "login" | "ready" | "error";
  message: string;
  serverUrl?: string;
  userCode?: string;
  verificationUrl?: string;
}

export type RuntimeCommand =
  | { type: "start"; settings: DesktopSettings; sandboxDirectory: string }
  | { type: "stop" };

export type RuntimeEvent =
  | { type: "progress"; message: string }
  | { type: "ready"; url: string }
  | { type: "error"; message: string }
  | { type: "stopped" };

export interface LauncherBridge {
  settings(): Promise<DesktopSettings>;
  status(): Promise<DesktopStatus>;
  connect(settings: DesktopSettings): Promise<void>;
  cancel(): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  openVerification(): Promise<void>;
  showConsole(): Promise<void>;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
}

export interface ConsoleBridge {
  openIntegration(tab: "github" | "slack" | "mcp"): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  settings(): Promise<void>;
  connection(): Promise<{ mode: DesktopMode; serverUrl: string }>;
}
