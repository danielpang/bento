import assert from "node:assert/strict";
import test from "node:test";
import { descriptionText, hasDescription, needsClamp } from "./card-description.js";

/**
 * The two decisions the drawer's Description section makes: whether
 * there is a section at all, and whether it opens cut off.
 *
 * Both are about text nobody typed for this purpose. A description
 * arrives from the create dialog, from a Linear import (issue body plus
 * the issue URL), or from Slack ("Created from Slack: <permalink>"), so
 * blank, multi line and very long are all ordinary inputs. Getting the
 * first one wrong grows an empty bordered box on every title-only card,
 * which reads as a drawer that failed to load.
 */

const linearBody = `${"The chrome wraps below 720px and the tab row overlaps the title. ".repeat(20)}\n\nhttps://linear.app/acme/issue/ENG-441/rework-the-mobile-topbar`;

test("a written description gets a section", () => {
  assert.equal(hasDescription("The chrome wraps below 720px."), true);
  assert.equal(hasDescription("Created from Slack: https://acme.slack.com/archives/C1/p1"), true);
});

test("nothing, or only whitespace, gets no section", () => {
  assert.equal(hasDescription(""), false);
  assert.equal(hasDescription("   "), false);
  assert.equal(hasDescription("\n\n  \t\n"), false);
});

test("a missing description is not a crash", () => {
  assert.equal(hasDescription(null), false);
  assert.equal(hasDescription(undefined), false);
});

test("the text shows word for word, with its line breaks", () => {
  const written = "Two things:\n\n- the topbar wraps\n- the tabs overlap";
  assert.equal(descriptionText(`\n${written}\n\n`), written);
  assert.equal(descriptionText(written), written);
});

test("a few sentences are not clamped", () => {
  assert.equal(needsClamp("The chrome wraps below 720px."), false);
  assert.equal(needsClamp("A brief.\nOn three lines.\nStill short."), false);
});

test("nothing to show is nothing to clamp", () => {
  assert.equal(needsClamp(""), false);
  assert.equal(needsClamp("   \n  "), false);
  assert.equal(needsClamp(null), false);
});

test("the character threshold trips just above 900, not at it", () => {
  assert.equal(needsClamp("x".repeat(900)), false);
  assert.equal(needsClamp("x".repeat(901)), true);
});

test("the line threshold trips just above 12, not at it", () => {
  assert.equal(needsClamp("line\n".repeat(12).trimEnd()), false);
  assert.equal(needsClamp("line\n".repeat(13).trimEnd()), true);
});

test("blank lines around the text do not push it over a threshold", () => {
  assert.equal(needsClamp(`\n\n\n${"line\n".repeat(12).trimEnd()}\n\n\n`), false);
  assert.equal(needsClamp(`\n  ${"x".repeat(900)}  \n`), false);
});

test("a Linear sized body is clamped", () => {
  assert.equal(hasDescription(linearBody), true);
  assert.equal(needsClamp(linearBody), true);
});
