import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type {
  BentoClient,
  FeaturePullRequestRecord,
  FeaturePullRequestStatus,
  FeatureMergeStatus,
  FeatureCheckStatus,
  Stage,
} from "@bento/api-client";
import { Navigator, Reader } from "./Navigator.js";
import { useMouseTarget } from "../mouse.js";
import { terminalText } from "../terminal.js";

export type PullRequestRow = FeaturePullRequestRecord & {
  status: string;
  state: FeaturePullRequestStatus["state"];
  mergeState: FeatureMergeStatus["state"];
  ciState: FeatureCheckStatus["state"];
  merge: string;
  ci: string;
  color: "red" | "yellow" | "green" | "gray";
};
export function pullRequestRows(
  history: FeaturePullRequestRecord[],
  states: FeaturePullRequestStatus[],
  merges: FeatureMergeStatus[],
  checks: FeatureCheckStatus[],
): PullRequestRow[] {
  return [...history]
    .sort((a, b) => Number(b.current) - Number(a.current))
    .map((pr) => {
      // Numbers repeat across repositories and repositories repeat across branches.
      const state = states.find((row) => row.url === pr.url)?.state ?? "unknown";
      const merge = merges.find((row) => row.url === pr.url)?.state ?? "unknown";
      const ci = checks.find((row) => row.url === pr.url)?.state ?? "unknown";
      const ended = state === "merged" || state === "closed";
      return {
        ...pr,
        state,
        mergeState: merge,
        ciState: ci,
        status:
          state === "unknown"
            ? "Status unknown"
            : state === "merged"
              ? "Merged"
              : state === "closed"
                ? "Closed"
                : "Open",
        merge: ended
          ? ""
          : merge === "conflicted"
            ? "❌ Merge conflicts"
            : merge === "clean"
              ? "✅ No merge conflicts"
              : "❓ Merge status unknown",
        ci: ended
          ? ""
          : ci === "failed"
            ? "❌ CI checks failing"
            : ci === "pending"
              ? "⏳ CI checks running"
              : ci === "passed"
                ? "✅ CI checks passed"
                : "❓ CI status unknown",
        color: ended
          ? "gray"
          : merge === "conflicted" || ci === "failed"
            ? "red"
            : merge === "clean" && ci === "passed"
              ? "green"
              : "yellow",
      };
    });
}

export function usePullRequestStatus(
  client: BentoClient,
  featureId: string,
  history: FeaturePullRequestRecord[],
) {
  const [states, setStates] = useState<FeaturePullRequestStatus[]>([]);
  const [merges, setMerges] = useState<FeatureMergeStatus[]>([]);
  const [checks, setChecks] = useState<FeatureCheckStatus[]>([]);
  const [error, setError] = useState("");
  const signature = history.map((pr) => pr.url).join("\n");
  useEffect(() => {
    let stopped = false,
      busy = false;
    setStates([]);
    setMerges([]);
    setChecks([]);
    setError("");
    if (!signature) return;
    async function refresh() {
      if (busy) return;
      busy = true;
      const results = await Promise.allSettled([
        client.getPullRequestStatus(featureId),
        client.getMergeStatus(featureId, true),
        client.getCheckStatus(featureId, true),
      ]);
      busy = false;
      if (stopped) return;
      setStates(results[0].status === "fulfilled" ? results[0].value : []);
      setMerges(results[1].status === "fulfilled" ? results[1].value : []);
      setChecks(results[2].status === "fulfilled" ? results[2].value : []);
      setError(
        results.some((result) => result.status === "rejected")
          ? "Some PR statuses are unavailable. Retrying…"
          : "",
      );
    }
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 30000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [client, featureId, signature]);
  return { rows: pullRequestRows(history, states, merges, checks), error };
}

export function PullRequestSummary({ pr, onOpen }: { pr: PullRequestRow; onOpen: () => void }) {
  const mouse = useMouseTarget({ onClick: onOpen });
  return (
    <Box ref={mouse} flexDirection="column" height={4} flexShrink={0} aria-role="button">
      <Text bold color="cyan" wrap="truncate-end">
        {terminalText(`${pr.name} #${pr.number}`)}
      </Text>
      <Text color={pr.color} wrap="truncate-end">
        {[pr.status, pr.current ? "current" : "previous"].join(" · ")}
      </Text>
      <Text
        color={pr.mergeState === "clean" ? "green" : pr.mergeState === "conflicted" ? "red" : "yellow"}
        wrap="truncate-end"
      >
        {pr.merge}
      </Text>
      <Text
        color={pr.ciState === "passed" ? "green" : pr.ciState === "failed" ? "red" : "yellow"}
        wrap="truncate-end"
      >
        {pr.ci}
      </Text>
    </Box>
  );
}

export function PullRequests({
  client,
  featureId,
  rows,
  stage,
  error,
  initialUrl,
  onClose,
  onChanged,
  runActive = false,
  finished = false,
  onRunStarted,
}: {
  client: BentoClient;
  featureId: string;
  rows: PullRequestRow[];
  stage?: Stage | undefined;
  error: string;
  initialUrl?: string | undefined;
  onClose: () => void;
  onChanged: () => void;
  runActive?: boolean;
  finished?: boolean;
  onRunStarted?: () => void;
}) {
  const [selected, setSelected] = useState(initialUrl);
  const [report, setReport] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingRepair = useRef(false);
  const [repairNotice, setRepairNotice] = useState("");
  const [repairStarted, setRepairStarted] = useState(false);
  useEffect(() => {
    if (runActive) setRepairStarted(false);
  }, [runActive]);
  const [automatic, setAutomatic] = useState(stage?.createPr ?? false);
  useEffect(() => setAutomatic(stage?.createPr ?? false), [stage?.id, stage?.createPr]);
  const pr = rows.find((row) => row.url === selected);
  const canRepair = Boolean(pr?.current && pr.state !== "merged" && pr.state !== "closed" && !finished);
  async function repair(kind: "ci" | "conflicts") {
    if (pendingRepair.current || busy || runActive || repairStarted || !canRepair) return;
    pendingRepair.current = true;
    setBusy(true);
    setRepairNotice("");
    try {
      if (kind === "ci") await client.fixCiTests(featureId);
      else await client.resolveConflicts(featureId);
      setRepairStarted(true);
      setRepairNotice(
        kind === "ci"
          ? "CI repair started. Follow progress in the conversation."
          : "Merge conflict repair started. Follow progress in the conversation.",
      );
      onChanged();
      onRunStarted?.();
    } catch (error) {
      setRepairNotice(error instanceof Error ? error.message : String(error));
    } finally {
      pendingRepair.current = false;
      setBusy(false);
    }
  }
  async function publish() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await client.publishFeature(featureId);
      setReport([
        ...result.published.map((pr) => `${pr.name}: ${pr.url}`),
        ...result.failures.map((f) => `${f.name}: ${f.reason}`),
        ...(result.rebaseRun ? ["A run is resolving conflicts before publishing."] : []),
        ...(!result.published.length && !result.failures.length && !result.rebaseRun
          ? ["No commits to publish beyond the base branch."]
          : []),
      ]);
      onChanged();
    } catch (error) {
      setReport([error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }
  async function toggle() {
    if (busy || !stage) return;
    setBusy(true);
    try {
      await client.updateStage(stage.id, { createPr: !automatic });
      setAutomatic(!automatic);
      onChanged();
    } catch (error) {
      setReport([error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }
  if (report)
    return <Reader title="Publish settings and results" lines={report} onClose={() => setReport(null)} />;
  if (pr)
    return (
      <Reader
        title={`${pr.name} #${pr.number}`}
        lines={[
          pr.url,
          "",
          `Branch: ${pr.branch}`,
          pr.current ? "Current branch" : "Previous branch",
          "",
          pr.status,
          ...(pr.merge ? [pr.merge] : []),
          ...(pr.ci ? [pr.ci] : []),
          ...(pr.mergeState === "clean" ? ["Repository review rules may still block merging."] : []),
          ...(error ? ["", error] : []),
          ...(canRepair && (pr.mergeState === "conflicted" || pr.ciState === "failed")
            ? ["", "The stage agent repairs the card's current PRs. Follow progress in the conversation."]
            : []),
          ...(finished ? ["", "Reopen this card before starting a repair."] : []),
          ...(runActive
            ? ["", "An agent is working this card. Repairs are available when it finishes."]
            : []),
          ...(repairNotice ? ["", repairNotice] : []),
        ]}
        description={
          busy
            ? "Starting repair…"
            : repairNotice || (runActive ? "An agent is working this card. Wait for it to finish." : "")
        }
        actions={
          canRepair
            ? [
                ...(pr.ciState === "failed"
                  ? [
                      {
                        label: "Fix CI tests",
                        onClick: () => {
                          void repair("ci");
                        },
                        disabled: busy || runActive || repairStarted,
                      },
                    ]
                  : []),
                ...(pr.mergeState === "conflicted"
                  ? [
                      {
                        label: "Fix merge conflicts",
                        onClick: () => {
                          void repair("conflicts");
                        },
                        disabled: busy || runActive || repairStarted,
                      },
                    ]
                  : []),
              ]
            : []
        }
        onClose={() => {
          if (pendingRepair.current) return;
          setRepairNotice("");
          setSelected(undefined);
        }}
      />
    );
  return (
    <Navigator
      title={busy ? "Pull requests · Publishing or saving…" : "Pull requests"}
      onClose={onClose}
      choices={
        busy
          ? []
          : [
              ...(error ? [{ id: "error", label: error, select: () => {} }] : []),
              ...rows.map((pr) => ({
                id: pr.url,
                label: `${pr.name} #${pr.number}`,
                detail: [pr.current ? "current" : "previous", pr.status, pr.merge, pr.ci]
                  .filter(Boolean)
                  .join(" · "),
                select: () => setSelected(pr.url),
              })),
              ...(!rows.length
                ? [
                    {
                      id: "empty",
                      label: "No pull requests yet",
                      detail:
                        stage && !automatic
                          ? `Automatic PR creation is off for ${stage.name}.`
                          : "Publish the current branch below.",
                      select: () => {},
                    },
                  ]
                : []),
              {
                id: "publish",
                label: "Create or update PRs",
                detail: "Publish committed changes using Bento's GitHub connection",
                select: () => {
                  void publish();
                },
              },
              ...(stage
                ? [
                    {
                      id: "automatic",
                      label: `Automatic PR for ${stage.name}: ${automatic ? "On" : "Off"}`,
                      detail: "Toggle publication after successful runs in this stage",
                      select: () => {
                        void toggle();
                      },
                    },
                  ]
                : []),
            ]
      }
    />
  );
}
