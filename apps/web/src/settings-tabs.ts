/**
 * Which settings sections exist in this mode, and which one a link
 * should land on.
 *
 * Billing is late: the tab is omitted until /api/billing/plan answers,
 * so a phone opening `?tab=billing` used to resolve to Appearance with
 * the real tab not yet in the strip. Keep Billing visible while the
 * address still asks for it, then drop it only if the endpoint says
 * this install has no billing.
 */

export type SettingsTab =
  | "appearance"
  | "projects"
  | "config"
  | "github"
  | "linear"
  | "slack"
  | "mcp"
  | "team"
  | "billing"
  | "account";

/**
 * Slack is a team surface: it installs an app for an organization, and
 * the panel speaks throughout of owners, admins, and "this Bento team".
 * Local mode has one user and no organization, so the tab offered a
 * section that could only describe something that is not there.
 */
const MULTI_ONLY: SettingsTab[] = ["slack"];

const ALWAYS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "projects", label: "Projects" },
  { id: "config", label: "Config" },
  { id: "github", label: "GitHub" },
  { id: "linear", label: "Linear" },
  { id: "slack", label: "Slack" },
  { id: "mcp", label: "MCP" },
];

export const KNOWN_SETTINGS_TABS: SettingsTab[] = [
  ...ALWAYS.map((t) => t.id),
  "team",
  "billing",
  "account",
];

export function settingsSections(
  mode: "local" | "multi",
  opts: { hasBilling: boolean; requested: SettingsTab },
): { id: SettingsTab; label: string }[] {
  // Filtered rather than appended, so a team-only section keeps its
  // place in the strip instead of being pushed to the end in multi.
  const base = ALWAYS.filter((entry) => mode === "multi" || !MULTI_ONLY.includes(entry.id));
  if (mode === "local") return base;
  return [
    ...base,
    { id: "team", label: "Team" },
    ...(opts.hasBilling || opts.requested === "billing"
      ? [{ id: "billing" as const, label: "Billing" }]
      : []),
    { id: "account", label: "Account" },
  ];
}

export function resolveSettingsTab(
  sections: { id: SettingsTab }[],
  requested: SettingsTab,
): SettingsTab {
  return sections.some((t) => t.id === requested) ? requested : "appearance";
}
