import { useState } from "react";

/**
 * The accents on offer. Each carries both renditions because a swatch
 * previews the value the current theme would actually use; the CSS
 * variants in styles.css hold the same numbers.
 */
const ACCENTS = [
  { id: "orange", name: "Orange", dark: "#ff8a3d", light: "#b34a00" },
  { id: "magenta", name: "Magenta", dark: "#ee5396", light: "#c31765" },
  { id: "teal", name: "Teal", dark: "#2dd4bf", light: "#0f766e" },
] as const;

type AccentId = (typeof ACCENTS)[number]["id"];

const THEMES = [
  { id: "system", name: "System" },
  { id: "dark", name: "Dark" },
  { id: "light", name: "Light" },
  // The palette the console shipped with, kept for anyone who prefers
  // the cool navy. Only a pinned choice reaches it; "System" resolves
  // to the warm pair above.
  { id: "navy", name: "Dark blue" },
] as const;

type ThemeId = (typeof THEMES)[number]["id"];
type ResolvedTheme = Exclude<ThemeId, "system">;

/** What the system prefers right now, which "System" resolves to. */
function systemTheme(): "dark" | "light" {
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const THEME_COLOR: Record<ResolvedTheme, string> = {
  dark: "#0e0d0b",
  light: "#f2f1ed",
  navy: "#0a0e16",
};

function applyTheme(resolved: ResolvedTheme) {
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLOR[resolved]);
}

/**
 * Appearance choices that live in the browser, not on the server: the
 * accent names a preference of the person at this screen, so another
 * machine or another teammate keeps their own.
 */
export function AppearanceSettings() {
  const [accent, setAccent] = useState<AccentId>(() => {
    const current = document.documentElement.dataset.accent;
    return current === "magenta" || current === "teal" ? current : "orange";
  });
  const [theme, setTheme] = useState<ThemeId>(() => {
    try {
      const pinned = localStorage.getItem("bento-theme");
      if (pinned === "dark" || pinned === "light" || pinned === "navy") return pinned;
    } catch {
      // Unreadable storage means nothing was pinned.
    }
    return "system";
  });
  /** What the swatches preview: "System" resolves to a real palette. */
  const resolved = theme === "system" ? systemTheme() : theme;
  /** Which accent rendition that palette uses; navy shares the dark one. */
  const rendition = resolved === "light" ? "light" : "dark";

  function chooseTheme(next: ThemeId) {
    try {
      if (next === "system") localStorage.removeItem("bento-theme");
      else localStorage.setItem("bento-theme", next);
    } catch {
      // Private browsing can refuse storage; the theme still applies.
    }
    applyTheme(next === "system" ? systemTheme() : next);
    setTheme(next);
  }

  function choose(next: AccentId) {
    // Orange is the stylesheet default, so it is expressed by absence.
    if (next === "orange") delete document.documentElement.dataset.accent;
    else document.documentElement.dataset.accent = next;
    try {
      localStorage.setItem("bento-accent", next);
    } catch {
      // Private browsing can refuse storage; the accent still applies.
    }
    setAccent(next);
  }

  return (
    <>
      <div className="section settings-card">
        <h3 className="settings-title">Accent</h3>
        <div className="accent-row" role="radiogroup" aria-label="Accent">
          {ACCENTS.map((option) => (
            <button
              key={option.id}
              className="accent-option"
              data-on={option.id === accent || undefined}
              role="radio"
              aria-checked={option.id === accent}
              onClick={() => choose(option.id)}
            >
              <span className="accent-dot" style={{ background: option[rendition] }} />
              {option.name}
            </button>
          ))}
        </div>
      </div>

      <div className="section settings-card">
        <h3 className="settings-title">Theme</h3>
        <div className="accent-row" role="radiogroup" aria-label="Theme">
          {THEMES.map((option) => (
            <button
              key={option.id}
              className="accent-option"
              data-on={option.id === theme || undefined}
              role="radio"
              aria-checked={option.id === theme}
              onClick={() => chooseTheme(option.id)}
            >
              {option.name}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
