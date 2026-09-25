import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleDocument, documentPathFor, isSafeRelativePath, shiftHeadings } from "./deliverable.js";

/**
 * Assembling a document swarm's sections into one file.
 *
 * Two things are worth pinning here and neither needs a database. The
 * outline of the assembled document has to be the outline of the plan,
 * because that is the whole claim the feature makes: a person who
 * approved the tree has approved the document's shape. And a section's
 * own headings have to end up underneath the heading the plan gave it,
 * because a leaf writes its section as a document in its own right and
 * every one of them opens with an h1.
 */

test("the document's outline is the plan's outline", () => {
  const document = assembleDocument({
    title: "Migrating off the legacy queue",
    goal: "Write the case for moving, and what moving involves.",
    preamble: "# Overview\n\nThree parts: why, how, and what it costs.",
    sections: [
      { title: "Why", depth: 0, body: null, note: "" },
      { title: "What it costs us today", depth: 1, body: "The queue drops messages under load." },
      { title: "How", depth: 0, body: null, note: "" },
      { title: "The migration itself", depth: 1, body: "# Steps\n\nOne consumer at a time." },
    ],
  });

  const headings = document
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => line.replace(/ .*/, "").length + " " + line.replace(/^#+ /, ""));

  assert.deepEqual(headings, [
    "1 Migrating off the legacy queue",
    "2 Overview",
    "2 Why",
    "3 What it costs us today",
    "2 How",
    "3 The migration itself",
    "4 Steps",
  ]);
  assert.match(document, /Write the case for moving/, "the goal is in it");
  assert.match(document, /One consumer at a time\./, "and every section's prose");
});

test("a section that was never written says so rather than vanishing", () => {
  /**
   * A document that quietly leaves out the section its plan promised
   * is a document that disagrees with the tree it was made from, and
   * the gap is exactly what a person reviewing it needs to see.
   */
  const document = assembleDocument({
    title: "A document",
    goal: "",
    preamble: null,
    sections: [
      { title: "Written", depth: 0, body: "Here it is." },
      { title: "Not written", depth: 0, body: null, note: "This section is failed, so nothing has been written for it yet." },
    ],
  });
  assert.match(document, /## Not written/);
  assert.match(document, /This section is failed/);
});

test("a section's own headings are moved under the one the plan gave it", () => {
  assert.equal(shiftHeadings("# Top\n\ntext\n\n## Under", 2), "### Top\n\ntext\n\n#### Under");
  assert.equal(shiftHeadings("### Already deep", 2), "### Already deep", "nothing moves when it does not have to");
  assert.equal(shiftHeadings("no headings here", 2), "no headings here");
  // Six is as deep as markdown goes, so nothing is pushed past it.
  assert.equal(shiftHeadings("###### Deepest", 5), "###### Deepest");
});

test("a hash inside a fenced block is a comment, not a heading", () => {
  /**
   * A section explaining how to run something puts shell in a fence,
   * and shell comments start with a hash. Rewriting one would change a
   * command somebody is meant to copy.
   */
  const shifted = shiftHeadings("# Title\n\n```sh\n# install it first\npnpm install\n```", 1);
  assert.match(shifted, /^## Title/);
  assert.match(shifted, /\n# install it first\n/, "the comment is untouched");
});

test("the document's path is the template's, or the swarm's slug", () => {
  assert.equal(documentPathFor({ slug: "queue-migration" }), "docs/queue-migration.md");
  assert.equal(documentPathFor({ slug: "x" }, "docs/rfc/queue.md"), "docs/rfc/queue.md");
  // A path that climbs out of the checkout is not used, and the swarm
  // gets its ordinary one rather than a failure.
  assert.equal(documentPathFor({ slug: "x" }, "../../etc/passwd.md"), "docs/x.md");
  assert.equal(documentPathFor({ slug: "x" }, "/tmp/out.md"), "docs/x.md");
});

test("a path this server will write to has to be relative, inside, and markdown", () => {
  assert.equal(isSafeRelativePath("docs/plan.md"), true);
  assert.equal(isSafeRelativePath("/docs/plan.md"), false);
  assert.equal(isSafeRelativePath("../plan.md"), false);
  assert.equal(isSafeRelativePath("docs/../../plan.md"), false);
  assert.equal(isSafeRelativePath("docs\\plan.md"), false);
  assert.equal(isSafeRelativePath("docs//plan.md"), false);
  assert.equal(isSafeRelativePath("docs/plan.txt"), false, "the assembled file is markdown");
});
