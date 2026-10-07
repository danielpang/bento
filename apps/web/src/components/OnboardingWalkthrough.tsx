import { useEffect, useState } from "react";
import type { BentoClient } from "@bento/api-client";
import { ONBOARDING_REENABLE_NOTE } from "../onboarding.js";
import { Modal } from "./Modal.js";
import { useToast } from "./Toasts.js";


export type OnboardingStep = "repository" | "github" | "agents" | "pipeline";

/**
 * What the board already knows about this workspace, so each step can
 * say whether it is done rather than asking somebody to check.
 */
export interface OnboardingState {
  hasProjects: boolean;
  /** Null until the selected project's repositories have been read. */
  repoCount: number | null;
  agentCount: number;
  stageCount: number;
  stagesWithAgents: number;
  /**
   * Steps whose panel was opened from the walkthrough. Agents and the
   * pipeline arrive filled in with Bento's defaults, so they only count
   * as the person's own once they have looked.
   */
  reviewed: { agents: boolean; pipeline: boolean };
}

/**
 * True is done, "defaults" is done by Bento's seeding but not yet
 * looked at, null is still being read.
 */
type StepDone = boolean | "defaults" | null;

function reviewedOr(ready: boolean, reviewed: boolean): StepDone {
  if (!ready) return false;
  return reviewed ? true : "defaults";
}

/**
 * The first run walkthrough: a repository, GitHub, agents, and the
 * pipeline, in the order a card needs them.
 *
 * A guide rather than a form. Every step opens the panel or page that
 * already does the job, so there is one place to add a repository and
 * one place to edit an agent, and the walkthrough cannot drift from
 * them. The board hides the dialog while one of those is open and
 * brings it back on the same step when it closes.
 *
 * Shown while the person's `onboarding_walkthrough` flag is on. Skip
 * and Finish both turn it off on the server, so it stays away on every
 * device and in the Mac app; Settings, Account turns it back on.
 * Escape only puts it away for this page load.
 */
export function OnboardingWalkthrough({
  client,
  mode,
  state,
  step,
  onStep,
  onNewProject,
  onOpenRepositories,
  onOpenAgents,
  onOpenPipeline,
  onDismiss,
  onDone,
}: {
  client: BentoClient;
  mode: "local" | "multi";
  state: OnboardingState;
  /** Held by the board, so the dialog reopens on the step it left from. */
  step: OnboardingStep;
  onStep: (step: OnboardingStep) => void;
  onNewProject: () => void;
  onOpenRepositories: () => void;
  onOpenAgents: () => void;
  onOpenPipeline: () => void;
  /** Put away for this page load, without saving anything. */
  onDismiss: () => void;
  /** Saved as off. */
  onDone: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  /** Null while unknown, so a slow status read does not claim GitHub is missing. */
  const [canPublish, setCanPublish] = useState<boolean | null>(null);

  // Read each time the dialog mounts, which includes coming back from
  // the settings page or a panel where the connection was just made.
  useEffect(() => {
    let cancelled = false;
    void client
      .githubStatus()
      .then((status) => {
        if (!cancelled) setCanPublish(status.canPublish);
      })
      .catch(() => {
        if (!cancelled) setCanPublish(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  async function finish() {
    setBusy(true);
    try {
      await client.setOnboarding(false);
      toast.note(ONBOARDING_REENABLE_NOTE);
      onDone();
    } catch (err) {
      toast.fail(err);
    } finally {
      setBusy(false);
    }
  }

  const steps: {
    id: OnboardingStep;
    title: string;
    done: StepDone;
    body: string;
    action: { label: string; run: () => void } | null;
    hint?: string;
  }[] = [
    {
      id: "repository",
      title: "Connect a repository",
      done: state.hasProjects ? (state.repoCount === null ? null : state.repoCount > 0) : false,
      body: state.hasProjects
        ? "Agents work in a checkout of your code. Add the repository this project builds, and every card on the board gets a branch of it."
        : "Agents work in a checkout of your code. Create a project and point it at the repository it builds. Every card on that board gets a branch of it.",
      action: state.hasProjects
        ? { label: "Add a repository", run: onOpenRepositories }
        : { label: "New project", run: onNewProject },
    },
    {
      id: "github",
      title: "Connect GitHub",
      done: canPublish,
      body:
        mode === "multi"
          ? "Connect your GitHub account and install the Bento GitHub App on your repositories. That is what lets agents push branches, open pull requests, and leave review comments on the code."
          : "Save a GitHub token so agents can push branches, open pull requests, and leave review comments on the code.",
      action: {
        label: "Open GitHub settings",
        run: () => window.location.assign("/settings?tab=github"),
      },
      hint: "You will come back to this step when you return to the board.",
    },
    {
      id: "agents",
      title: "Set up your agents",
      done: reviewedOr(state.agentCount > 0, state.reviewed.agents),
      body: "Agents are a coding harness paired with a model and skill. Each stage in the pipeline has an agent and will repeat their actions for every card that enters their stage.",
      action: { label: "Open agents", run: onOpenAgents },
    },
    {
      id: "pipeline",
      title: "Shape your pipeline",
      done: reviewedOr(
        state.stageCount > 0 && state.stagesWithAgents === state.stageCount,
        state.reviewed.pipeline,
      ),
      body: "Pipeline defines your software development cycle. Define how your team ships features (i.e. product investigation, code spec, implementation, code review, QA).",
      action: state.hasProjects ? { label: "Open pipeline", run: onOpenPipeline } : null,
      hint: state.hasProjects ? undefined : "Create a project first. Its pipeline arrives with it.",
    },
  ];

  const index = steps.findIndex((entry) => entry.id === step);
  const current = steps[index]!;
  const last = index === steps.length - 1;

  return (
    <Modal
      title="Welcome to Bento"
      description="Four steps take a card from an idea to a pull request. Do them now, or skip and come back later."
      onClose={onDismiss}
      large
      actions={
        <>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void finish()}>
            Skip
          </button>
          <span className="onboarding-spacer" />
          {index > 0 && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => onStep(steps[index - 1]!.id)}
            >
              Back
            </button>
          )}
          {last ? (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void finish()}>
              {busy ? "Saving..." : "Finish"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => onStep(steps[index + 1]!.id)}
            >
              Next
            </button>
          )}
        </>
      }
    >
      <ol className="onboarding-steps" aria-label="Onboarding steps">
        {steps.map((entry, i) => (
          <li key={entry.id}>
            <button
              type="button"
              className={`onboarding-step${entry.id === step ? " onboarding-step-on" : ""}`}
              aria-current={entry.id === step ? "step" : undefined}
              onClick={() => onStep(entry.id)}
            >
              <span
                className={`onboarding-step-mark${entry.done === true ? " onboarding-step-done" : entry.done === "defaults" ? " onboarding-step-defaults" : ""}`}
                aria-hidden="true"
              >
                {entry.done ? "✓" : i + 1}
              </span>
              <span>{entry.title}</span>
              {entry.done === true && <span className="visually-hidden"> (done)</span>}
              {entry.done === "defaults" && <span className="visually-hidden"> (using Bento's defaults)</span>}
            </button>
          </li>
        ))}
      </ol>

      <section className="onboarding-body" aria-live="polite">
        <h3 className="onboarding-title">
          {current.title}
          {current.done === true && <span className="onboarding-badge">Done</span>}
          {current.done === "defaults" && (
            <span className="onboarding-badge onboarding-badge-defaults">Using defaults</span>
          )}
        </h3>
        <p className="muted">{current.body}</p>
        {current.action && (
          <div className="actions">
            <button type="button" className={current.done === true ? "btn" : "btn btn-primary"} onClick={current.action.run}>
              {current.action.label}
            </button>
          </div>
        )}
        {current.hint && <p className="muted onboarding-hint">{current.hint}</p>}
      </section>
    </Modal>
  );
}
