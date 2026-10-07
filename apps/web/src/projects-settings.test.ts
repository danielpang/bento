import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project } from "@bento/api-client";
import { ProjectsSettingsList, projectsSettingsHref } from "./components/ProjectsSettingsList.js";

function project(id: string, name: string, localPath: string | null = null): Project {
  return {
    id,
    name,
    repoUrl: null,
    localPath,
    defaultBranch: "main",
    autoStartPipeline: false,
    sandboxProvider: null,
    linearCreateIssues: false,
    linearTeamId: null,
    linearTeamKey: null,
    linearTeamName: null,
    linearProjectId: null,
    linearProjectName: null,
  };
}

function list(props: Partial<Parameters<typeof ProjectsSettingsList>[0]> & { projects: Project[] | null }) {
  return renderToStaticMarkup(
    createElement(ProjectsSettingsList, {
      failed: false,
      busy: false,
      onNew() {},
      onRename() {},
      onRemove() {},
      onOpen() {},
      ...props,
    }),
  );
}

test("the Projects tab can create a project, including when the list is empty", () => {
  const empty = list({ projects: [] });
  assert.match(empty, />New project</);
  assert.match(empty, /No projects yet/);
  assert.doesNotMatch(empty, /from the board/);

  const populated = list({ projects: [project("p1", "Payments", "/src/payments")] });
  assert.match(populated, />New project</);
  assert.match(populated, /Payments/);
  assert.match(populated, /\/src\/payments/);
  assert.match(populated, />Settings</);
  assert.match(populated, />Remove</);
});

test("creating a project from settings opens that project's own settings", () => {
  assert.equal(projectsSettingsHref("p1"), "/settings?tab=projects&project=p1");
  assert.equal(projectsSettingsHref(null), "/settings?tab=projects");
});

test("New project stays available when the list failed to load", () => {
  const html = list({ projects: null, failed: true });
  assert.match(html, />New project</);
  assert.match(html, /Could not load the projects/);
});
