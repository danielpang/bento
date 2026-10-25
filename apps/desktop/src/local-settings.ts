import type { DesktopSettings, DesktopStatus } from "./contracts.js";

type LocalSettings = NonNullable<DesktopStatus["local"]>;
const LOCAL_KEYS = ["dataDir", "databaseUrl", "sandbox", "sandboxImage", "betaFeatures", "modelProxy"] as const satisfies readonly (keyof LocalSettings)[];

export function localSettings(settings: LocalSettings): LocalSettings {
  return Object.fromEntries(LOCAL_KEYS.map((key) => [key, settings[key]])) as LocalSettings;
}

/** Whether starting local Bento with `next` means restarting the one running with `running`. */
export function localSettingsChanged(running: LocalSettings, next: Pick<DesktopSettings, keyof LocalSettings>): boolean {
  return LOCAL_KEYS.some((key) => {
    const a = running[key], b = next[key];
    return typeof a === "string" && typeof b === "string" ? a.trim() !== b.trim() : a !== b;
  });
}
