import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { eq } from "drizzle-orm";
import { createDb, createPool, projects, pipelines, stages, features, agentProfiles, agentRuns, runQuestions, runMigrations, type Db } from "@bento/db";
import { ensureLocalUser } from "../context.js";
import {
  answersFor,
  claimAnswers,
  openQuestions,
  recordQuestion,
  requeueAnswers,
  storeAnswer,
  withdrawQuestions,
} from "./questions.js";

/**
 * The lifecycle of an agent's question, against a real database: asked,
 * answered by a person, claimed once by the process that writes it into
 * the agent, and withdrawn when the agent stops waiting.
 */
const base = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5439/app";
const url = base.replace(/\/[^/]+$/, "/run_questions_test");
let pool: ReturnType<typeof createPool>;
let db: Db;
let runId: string;

const questions = [
  { question: "Which database should we use?", header: "Database", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] },
  { question: "Which features should ship first?", multiSelect: true, options: [{ label: "Search" }, { label: "Export" }, { label: "Sharing" }] },
];
const ask = (id: string) => ({ id, questions, input: { questions } });

before(async () => {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS run_questions_test WITH (FORCE)");
  await admin.query("CREATE DATABASE run_questions_test");
  await admin.end();
  await runMigrations(url);
  pool = createPool(url);
  db = createDb(pool);
  const ownerId = await ensureLocalUser(db);
  const [project] = await db.insert(projects).values({ ownerId, name: "Questions" }).returning();
  const [pipeline] = await db.insert(pipelines).values({ projectId: project!.id, name: "Pipeline" }).returning();
  const [stage] = await db.insert(stages).values({ pipelineId: pipeline!.id, name: "Work", slug: "work", position: 0 }).returning();
  const [feature] = await db.insert(features).values({ projectId: project!.id, pipelineId: pipeline!.id, title: "Work" }).returning();
  const [profile] = await db.insert(agentProfiles).values({ ownerId, name: "Agent", cli: "claude-code", model: "claude-sonnet-5" }).returning();
  const [run] = await db
    .insert(agentRuns)
    .values({ featureId: feature!.id, stageId: stage!.id, agentProfileId: profile!.id, status: "running", prompt: "work", type: "pipeline" })
    .returning();
  runId = run!.id;
});
after(async () => {
  await pool?.end();
});

test("a question is stored once per agent request, and listed while it waits", async () => {
  const id = await recordQuestion(db, runId, ask("req-1"));
  assert.ok(id);
  assert.equal(await recordQuestion(db, runId, ask("req-1")), null, "the same request seen again after a reattach is one row");
  const open = await openQuestions(db, runId);
  assert.deepEqual(open.map((q) => [q.id, q.questions.length]), [[id, 2]]);
});

test("an answer is stored once, claimed once, and back for the next pump when its write fails", async () => {
  const id = (await recordQuestion(db, runId, ask("req-2")))!;
  const answers = { "Which database should we use?": "Postgres", "Which features should ship first?": "Search, Export" };
  assert.equal(await storeAnswer(db, id, answers, null), true);
  assert.equal(await storeAnswer(db, id, answers, null), false, "a second answer to the same question is refused");
  assert.ok(!(await openQuestions(db, runId)).some((q) => q.id === id), "an answered question is no longer offered");

  const [claimed, again] = await Promise.all([claimAnswers(db, runId), claimAnswers(db, runId)]);
  assert.equal(claimed.length + again.length, 1, "two pumps at once split the answers rather than writing one twice");
  const taken = [...claimed, ...again][0]!;
  assert.deepEqual(taken.answers, answers);
  assert.equal(taken.ask.id, "req-2", "the agent's own request id, which its answer must echo");
  assert.deepEqual(taken.ask.input, { questions });

  await requeueAnswers(db, [taken.id]);
  const retried = await claimAnswers(db, runId);
  assert.deepEqual(retried.map((a) => a.id), [taken.id], "a write that failed is claimed again");
  const [row] = await db.select().from(runQuestions).where(eq(runQuestions.id, id));
  assert.equal(row!.status, "delivered");
});

test("a withdrawn question cannot be answered, and a run's end withdraws whatever it still had open", async () => {
  const one = (await recordQuestion(db, runId, ask("req-3")))!;
  const two = (await recordQuestion(db, runId, ask("req-4")))!;
  await withdrawQuestions(db, runId, ["req-3"]);
  assert.equal(await storeAnswer(db, one, { x: "y" }, null), false, "the agent stopped waiting for it");
  await storeAnswer(db, two, { "Which database should we use?": "SQLite" }, null);
  await withdrawQuestions(db, runId);
  assert.deepEqual(await claimAnswers(db, runId), [], "an answer nobody wrote goes with its run");
  assert.deepEqual(await openQuestions(db, runId), []);
});

test("answers are checked against what was asked", () => {
  const ok = answersFor(questions, [
    { question: "Which database should we use?", selected: ["Postgres"] },
    { question: "Which features should ship first?", selected: ["Export", "Search"], other: "Webhooks" },
  ]);
  assert.deepEqual(ok, {
    answers: {
      "Which database should we use?": "Postgres",
      // In the order the agent offered them, free text last.
      "Which features should ship first?": "Search, Export, Webhooks",
    },
  });
  const words = answersFor(questions, [
    { question: "Which database should we use?", selected: [], other: "  DynamoDB  " },
    { question: "Which features should ship first?", selected: ["Sharing"] },
  ]);
  assert.deepEqual(words, { answers: { "Which database should we use?": "DynamoDB", "Which features should ship first?": "Sharing" } });

  const refused = (choices: Parameters<typeof answersFor>[1]) => {
    const result = answersFor(questions, choices);
    return "error" in result ? result.error : null;
  };
  const both = { question: "Which features should ship first?", selected: ["Search"] };
  assert.match(refused([{ question: "Which database should we use?", selected: ["Postgres", "SQLite"] }, both]) ?? "", /takes one answer/);
  assert.match(refused([{ question: "Which database should we use?", selected: ["Postgres"], other: "MySQL" }, both]) ?? "", /takes one answer/);
  assert.match(refused([{ question: "Which database should we use?", selected: ["Oracle"] }, both]) ?? "", /not an option/);
  assert.match(refused([{ question: "Which database should we use?", selected: [] }, both]) ?? "", /has no answer/);
  assert.match(refused([both]) ?? "", /has no answer/);
  assert.match(refused([{ question: "Which database should we use?", selected: ["Postgres"] }, both, { question: "Invented?", selected: [] }]) ?? "", /was not asked/);
});
