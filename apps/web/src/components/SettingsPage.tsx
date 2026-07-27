import * as Tabs from "@radix-ui/react-tabs";
import { useEffect, useState } from "react";
import type { BentoClient } from "@bento/api-client";
import { useSession } from "../auth-client.js";
import { AccountSettings } from "./AccountSettings.js";
import { AppearanceSettings } from "./AppearanceSettings.js";
import { BillingCard } from "./BillingCard.js";
import { GitHubTokenCard, GitIdentityCard } from "./Credentials.js";
import { SignIn } from "./SignIn.js";
import { TeamSettings } from "./TeamSettings.js";

/**
 * Settings as a page, not a drawer.
 *
 * Drawers are for working the board without leaving it; membership and
 * billing are not board work, and stacking them into a side panel made
 * every section fight for one narrow column. A page has room, a URL
 * that can be linked and reloaded, and tabs that only exist where they
 * apply: local mode is Appearance alone, a self-hosted team adds Team,
 * and only a deployment with the billing module shows Billing.
 */
type Tab = "appearance" | "github" | "team" | "billing" | "account";

export function SettingsPage({ client }: { client: BentoClient }) {
  const { data: session, isPending } = useSession();
  const [mode, setMode] = useState<"local" | "multi" | "unknown">("unknown");
  const [social, setSocial] = useState<{ github: boolean; google: boolean } | undefined>(undefined);
  const [hasBilling, setHasBilling] = useState(false);
  const [tab, setTab] = useState<Tab>(() => {
    const wanted = new URLSearchParams(window.location.search).get("tab");
    return wanted === "team" || wanted === "billing" || wanted === "account" || wanted === "github"
      ? wanted
      : "appearance";
  });

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

  if (mode === "unknown" || (mode === "multi" && isPending)) return <div className="center" />;
  if (mode === "multi" && !session) return <SignIn social={social} />;

  const tabs: { id: Tab; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "github", label: "GitHub" },
    ...(mode === "multi" ? [{ id: "team" as const, label: "Team" }] : []),
    ...(mode === "multi" && hasBilling ? [{ id: "billing" as const, label: "Billing" }] : []),
    ...(mode === "multi" ? [{ id: "account" as const, label: "Account" }] : []),
  ];
  const active = tabs.some((t) => t.id === tab) ? tab : "appearance";

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <span className="brand-glyph" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          Bento
        </span>
        <span className="topbar-spacer" />
        <a className="btn btn-ghost" href="/">
          Back to the board
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
          <Tabs.Content value="team" className="settings-body">
            <TeamSettings client={client} />
          </Tabs.Content>
          <Tabs.Content value="github" className="settings-body">
            <GitHubTokenCard client={client} />
            <GitIdentityCard client={client} />
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
