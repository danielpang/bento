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
import { SlackPanel } from "./SlackPanel.js";
import { ProjectsSettings } from "./ProjectsSettings.js";
import { SignIn } from "./SignIn.js";
import { TeamSettings } from "./TeamSettings.js";
import { SettingsPageSkeleton } from "./Skeleton.js";

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
type Tab = "appearance" | "projects" | "config" | "github" | "linear" | "slack" | "team" | "billing" | "account";

/** The tabs that exist in every mode, so a link to one always resolves. */
const ALWAYS: Tab[] = ["appearance", "projects", "config", "github", "linear", "slack"];

export function SettingsPage({ client }: { client: BentoClient }) {
  const { data: session, isPending } = useSession();
  const [mode, setMode] = useState<"local" | "multi" | "unknown">("unknown");
  const [social, setSocial] = useState<{ github: boolean; google: boolean } | undefined>(undefined);
  const [hasBilling, setHasBilling] = useState(false);
  const [tab, setTab] = useState<Tab>(() => {
    const wanted = new URLSearchParams(window.location.search).get("tab");
    const known: Tab[] = [...ALWAYS, "team", "billing", "account"];
    return known.find((id) => id === wanted) ?? "appearance";
  });

  // A GitHub connection started from this page comes back to it, so the
  // outcome is said here rather than only on the board.
  useGitHubOutcome();

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
  }, [client]);

  if (mode === "unknown" || (mode === "multi" && isPending)) return <SettingsPageSkeleton />;
  if (mode === "multi" && !session) return <SignIn social={social} />;

  const tabs: { id: Tab; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "projects", label: "Projects" },
    { id: "config", label: "Config" },
    { id: "github", label: "GitHub" },
    { id: "linear", label: "Linear" },
    { id: "slack", label: "Slack" },
    ...(mode === "multi" ? [{ id: "team" as const, label: "Team" }] : []),
    ...(mode === "multi" && hasBilling ? [{ id: "billing" as const, label: "Billing" }] : []),
    ...(mode === "multi" ? [{ id: "account" as const, label: "Account" }] : []),
  ];
  const active = tabs.some((t) => t.id === tab) ? tab : "appearance";

  return (
    <div className="app">
      <header className="topbar">
        <BrandLockup />
        <span className="topbar-spacer" />
        <a className="btn btn-ghost" href="/">
          Back
        </a>
      </header>

      <div className="settings-page">
        <h1 className="settings-heading">Settings</h1>
        {/* Radix owns the tablist's keyboard behaviour. Hand rolled,
            this markup claimed role="tab" and then ignored the arrow
            keys that role promises, so assistive tech announced a tab
            strip that could not be operated as one. */}
        <Tabs.Root
          value={active}
          onValueChange={(next) => {
            setTab(next as Tab);
            // The address mirrors the tab so a reload or a shared link
            // lands on the same section.
            history.replaceState(null, "", next === "appearance" ? "/settings" : `/settings?tab=${next}`);
          }}
        >
          <Tabs.List className="tab-row" aria-label="Settings sections">
            {tabs.map((entry) => (
              <Tabs.Trigger
                key={entry.id}
                value={entry.id}
                className={`tab${entry.id === active ? " tab-on" : ""}`}
              >
                {entry.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

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
          <Tabs.Content value="account" className="settings-body">
            <AccountSettings />
          </Tabs.Content>
          <Tabs.Content value="billing" className="settings-body">
            <p className="muted">
              The plan covers this team. Payments go through Stripe; Bento never sees a card
              number.
            </p>
            <BillingCard />
          </Tabs.Content>
        </Tabs.Root>
      </div>
    </div>
  );
}
