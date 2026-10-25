import { LOCAL_SETTING_KEYS, type LocalSettings } from "./contracts.js";

export function localSettings(settings: LocalSettings): LocalSettings {
  return Object.fromEntries(LOCAL_SETTING_KEYS.map((key) => [key, settings[key]])) as LocalSettings;
}

export function localSettingsChanged(running: LocalSettings, next: LocalSettings): boolean {
  return LOCAL_SETTING_KEYS.some((key) => {
    const a = running[key], b = next[key];
    return typeof a === "string" && typeof b === "string" ? a.trim() !== b.trim() : a !== b;
  });
}
