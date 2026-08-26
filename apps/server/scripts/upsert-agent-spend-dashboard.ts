/**
 * Creates or updates the Agent spend dashboard in PostHog.
 *
 * Needs a personal API key (phx_..., from PostHog user settings) and the
 * numeric project id. The project token (phc_..., POSTHOG_API_KEY) can
 * only capture events and cannot create dashboards.
 *
 *   POSTHOG_PERSONAL_API_KEY=phx_... POSTHOG_PROJECT_ID=12345 \
 *     pnpm --filter @bento/server exec tsx scripts/upsert-agent-spend-dashboard.ts
 *
 * POSTHOG_HOST defaults to the ingest host; the script maps
 * us.i.posthog.com to the us.posthog.com API.
 */
import { AGENT_STAGE_SPEND_DASHBOARD } from "../src/orchestrator/stage-spend.js";

const personalKey = process.env.POSTHOG_PERSONAL_API_KEY;
const projectId = process.env.POSTHOG_PROJECT_ID;
if (!personalKey || !projectId) {
  console.error("POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID are required.");
  process.exit(1);
}

const ingestHost = (process.env.POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/+$/, "");
const apiHost = ingestHost.replace("://us.i.posthog.com", "://us.posthog.com").replace(
  "://eu.i.posthog.com",
  "://eu.posthog.com",
);
const base = `${apiHost}/api/projects/${projectId}`;

async function api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${personalKey}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new Error(`${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return json;
}

async function findDashboardId(name: string): Promise<number | null> {
  const data = await api("GET", `/dashboards/?limit=100&search=${encodeURIComponent(name)}`);
  const results = (data.results as Array<{ id: number; name: string; deleted?: boolean }>) ?? [];
  return results.find((d) => d.name === name && !d.deleted)?.id ?? null;
}

async function findInsightId(name: string): Promise<number | null> {
  const data = await api("GET", `/insights/?limit=100&search=${encodeURIComponent(name)}`);
  const results = (data.results as Array<{ id: number; name: string; deleted?: boolean }>) ?? [];
  return results.find((i) => i.name === name && !i.deleted)?.id ?? null;
}

const dashboardId =
  (await findDashboardId(AGENT_STAGE_SPEND_DASHBOARD.name)) ??
  ((await api("POST", "/dashboards/", {
    name: AGENT_STAGE_SPEND_DASHBOARD.name,
    description: AGENT_STAGE_SPEND_DASHBOARD.description,
    filters: AGENT_STAGE_SPEND_DASHBOARD.filters,
    pinned: true,
  })).id as number);

await api("PATCH", `/dashboards/${dashboardId}/`, {
  name: AGENT_STAGE_SPEND_DASHBOARD.name,
  description: AGENT_STAGE_SPEND_DASHBOARD.description,
  filters: AGENT_STAGE_SPEND_DASHBOARD.filters,
});

for (const insight of AGENT_STAGE_SPEND_DASHBOARD.insights) {
  const existingId = await findInsightId(insight.name);
  if (existingId !== null) {
    await api("PATCH", `/insights/${existingId}/`, {
      name: insight.name,
      description: insight.description,
      query: insight.query,
      saved: true,
      dashboards: [dashboardId],
    });
    continue;
  }
  await api("POST", "/insights/", {
    name: insight.name,
    description: insight.description,
    query: insight.query,
    saved: true,
    dashboards: [dashboardId],
  });
}

console.log(`${apiHost}/dashboard/${dashboardId}`);
