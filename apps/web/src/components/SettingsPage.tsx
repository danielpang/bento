import * as Tabs from "@radix-ui/react-tabs";
import { useEffect, useState } from "react";
import type { BentoClient } from "@bento/api-client";
import { useSession } from "../auth-client.js";
import { AccountSettings } from "./AccountSettings.js";
import { AppearanceSettings } from "./AppearanceSettings.js";
import { BillingCard } from "./BillingCard.js";
import { BrandLockup } from "./BrandLockup.js";
import { ConfigSettings } from "./ConfigSettings.js";
import { GitHubTokenCard, GitIdentityCard } from "./Credentials.js";
import { GitHubAccountCard, useGitHubOutcome } from "./GitHubIdentity.js";
import { LinearPanel } from "./LinearPanel.js";
import { McpPanel } from "./McpPanel.js";
import { SlackPanel } from "./SlackPanel.js";
import { ProjectsSettings } from "./ProjectsSettings.js";
import { SignIn } from "./SignIn.js";
import { TeamSettings } from "./TeamSettings.js";
import { SettingsPageSkeleton } from "./Skeleton.js";
import { TabScroll } from "./TabScroll.js";
import {
  KNOWN_SETTINGS_TABS,
  resolveSettingsTab,
  settingsSections,
  type SettingsTab,
} from "../settings-tabs.js";

/**
 * Settings as a page, not a drawer.
 *
 * Drawers are for working the board without leaving it; membership and
 * billing are not board work, and stacking them into a side panel made
 * every section fight for one narrow column. A page has room, a URL
 * that can be linked and reloaded, and tabs that only exist where they
 * apply: local mode is Appearance, Projects, and Config, a self-hosted
 * team adds Team, and only a deployment with the billing module shows
 * Billing.
 */
type Tab = SettingsTab;

const SECTION_DESCRIPTIONS: Record<Tab, string> = {
  appearance: "Make this workspace feel like yours.",
  projects: "Manage the projects your agents work on.",
  config: "Keep your agents and pipelines portable with YAML files.",
  github: "Connect the identity and credentials agents use with GitHub.",
  linear: "Bring issues into your pipeline and keep progress in sync.",
  slack: "Connect your team and follow the work from Slack.",
  mcp: "Give agents access to the tools and services they need.",
  team: "Manage membership and shared access for your organization.",
  billing: "Manage your plan and workspace billing.",
  account: "Manage your personal account and organization ownership.",
};

export function SettingsPage({ client }: { client: BentoClient }) {
  const { data: session, isPending } = useSession();
  const [mode, setMode] = useState<"local" | "multi" | "unknown">("unknown");
  const [social, setSocial] = useState<{ github: boolean; google: boolean } | undefined>(undefined);
  const [hasBilling, setHasBilling] = useState(false);
  const [wideNavigation, setWideNavigation] = useState(() => window.matchMedia("(min-width: 801px)").matches);
  const [tab, setTab] = useState<Tab>(() => {
    const wanted = new URLSearchParams(window.location.search).get("tab");
    return KNOWN_SETTINGS_TABS.find((id) => id === wanted) ?? "appearance";
  });

  // A GitHub connection started from this page comes back to it, so the
  // outcome is said here rather than only on the board.
  useGitHubOutcome();

  // Keep Radix's arrow-key behavior aligned with the visible navigation.
  useEffect(() => {
    const query = window.matchMedia("(min-width: 801px)");
    const update = () => setWideNavigation(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // Per-user MCP servers each member must connect for themselves: the
  // count drives a dot on the MCP tab so the prompt is visible without a
  // banner on the board.
  const [mcpToConnect, setMcpToConnect] = useState(0);

  useEffect(() => {
    void client
      .health()
      .then((h) => {
        setMode(h.mode === "multi" ? "multi" : "local");
        setSocial(h.social);
      })
      .catch(() => setMode("local"));
    void fetch("/api/billing/plan", { credentials: "include" })
      .then((res) => setHasBilling(res.ok))
      .catch(() => setHasBilling(false));
    void client
      .mcpStatus()
      .then((s) => setMcpToConnect(s.userConnectionsNeeded))
      .catch(() => setMcpToConnect(0));
  }, [client]);

  if (mode === "unknown" || (mode === "multi" && isPending)) return <SettingsPageSkeleton />;
  if (mode === "multi" && !session) return <SignIn social={social} />;

  const tabs = settingsSections(mode, { hasBilling, requested: tab });
  const active = resolveSettingsTab(tabs, tab);

  return (
    <div className="app">
      <header className="topbar">
        <BrandLockup />
        <span className="topbar-spacer" />
        <a className="btn btn-ghost" href="/">
          Back to board
        </a>
      </header>

      <div className="settings-page">
        <h1 className="settings-heading">Settings</h1>
        {/* Radix owns the tablist's keyboard behaviour. Hand rolled,
            this markup claimed role="tab" and then ignored the arrow
            keys that role promises, so assistive tech announced a tab
            strip that could not be operated as one. */}
        <Tabs.Root
          className="settings-layout"
          orientation={wideNavigation ? "vertical" : "horizontal"}
          value={active}
          onValueChange={(next) => {
            setTab(next as Tab);
            // The address mirrors the tab so a reload or a shared link
            // lands on the same section.
            history.replaceState(null, "", next === "appearance" ? "/settings" : `/settings?tab=${next}`);
          }}
        >
          {/* Same overflow cue as the provider tabs: on a phone the
              strip runs off the right edge, and a clipped label reads
              as a truncated name rather than as a row you can slide. */}
          <div className="settings-navigation">
          <TabScroll active={active}>
            <Tabs.List className="tab-row" aria-label="Settings sections">
              {tabs.map((entry) => (
                <Tabs.Trigger
                  key={entry.id}
                  value={entry.id}
                  data-tab={entry.id}
                  className={`tab${entry.id === active ? " tab-on" : ""}`}
                >
                  {entry.label}
                  {entry.id === "mcp" && mcpToConnect > 0 && (
                    <span
                      className="tab-dot"
                      data-set
                      style={{ display: "inline-block", marginLeft: 6, verticalAlign: "middle" }}
                      aria-label={`${mcpToConnect} MCP servers to connect`}
                    />
                  )}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </TabScroll>
          </div>

          <div className="settings-content">
            <header className="settings-section-heading">
              <h2>{tabs.find((entry) => entry.id === active)?.label}</h2>
              <p>{SECTION_DESCRIPTIONS[active]}</p>
            </header>
          <Tabs.Content value="appearance" className="settings-body">
            <AppearanceSettings />
          </Tabs.Content>
          <Tabs.Content value="projects" className="settings-body">
            <ProjectsSettings client={client} />
          </Tabs.Content>
          <Tabs.Content value="config" className="settings-body">
            <ConfigSettings client={client} />
          </Tabs.Content>
          <Tabs.Content value="team" className="settings-body">
            <TeamSettings client={client} />
          </Tabs.Content>
          <Tabs.Content value="github" className="settings-body">
            {mode === "multi" && <GitHubAccountCard client={client} />}
            <GitHubTokenCard client={client} />
            {mode === "local" && <GitIdentityCard client={client} />}
          </Tabs.Content>
          <Tabs.Content value="linear" className="settings-body">
            <LinearPanel client={client} />
          </Tabs.Content>
          <Tabs.Content value="slack" className="settings-body">
            <SlackPanel client={client} />
          </Tabs.Content>
          <Tabs.Content value="mcp" className="settings-body">
            <McpPanel client={client} mode={mode} />
          </Tabs.Content>
          <Tabs.Content value="account" className="settings-body">
            <AccountSettings />
          </Tabs.Content>
          <Tabs.Content value="billing" className="settings-body">
            <BillingCard />
          </Tabs.Content>
          </div>
        </Tabs.Root>
      </div>
    </div>
  );
}
