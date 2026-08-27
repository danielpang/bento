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
  | "team"
  | "billing"
  | "account";

const ALWAYS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "projects", label: "Projects" },
  { id: "config", label: "Config" },
  { id: "github", label: "GitHub" },
  { id: "linear", label: "Linear" },
  { id: "slack", label: "Slack" },
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
  if (mode === "local") return ALWAYS;
  return [
    ...ALWAYS,
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
