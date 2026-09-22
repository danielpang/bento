-- What a run cost, and how well that is known.
--
-- Bento has recorded spend and never enforced it. A swarm is the first
-- place a cap has to hold, because it is the first place one click
-- starts twenty agents. The difficulty is that only some tools say what
-- they cost, so a single number would put a measurement, an arithmetic
-- estimate and a guess behind one figure, printed next to a budget
-- people set real limits with.
--
-- So a run says which of the four it is. measured is the figure the
-- tool printed. estimated is the tokens it printed, priced from the
-- model catalog. assumed is a stand in for a tool that prints nothing.
-- notional is a printed figure that a subscription had already paid
-- for, which is the least true number in the most trusted tier if it is
-- filed as measured.
--
-- Nullable, with no backfill, and that is the honest shape: a run that
-- ended before any of this existed has no tier, and null is "nobody has
-- said" rather than "free". Every reader treats it that way.
ALTER TABLE "agent_runs" ADD COLUMN "cost_tier" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "output_tokens" integer;--> statement-breakpoint

-- The rate an estimate used, in dollars per million tokens, as
-- {"input": 3, "output": 15}.
--
-- On the run rather than looked up when somebody reads it: catalog
-- prices change, and a figure that moves after the fact is a figure
-- nobody can reconcile against a bill. Two numbers in one column
-- because they are one fact, the rate card in force when the run ended.
ALTER TABLE "agent_runs" ADD COLUMN "price_per_mtok" jsonb;--> statement-breakpoint

-- Whether the run borrowed the operator's own agent login rather than
-- an API key. Written when the agent starts, not asked at the end: the
-- setting can change while a run is in flight, and what the ledger
-- needs to know is what this run actually used. False is right for
-- every existing row, because multi mode never shares a login and no
-- local run has been tiered yet.
ALTER TABLE "agent_runs" ADD COLUMN "shared_agent_auth" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- A message the server wrote, rather than one a person did.
--
-- The planner's wake message labels the two apart, and it matters that
-- it can: a long run escalation and a low budget warning are Bento's
-- own words about facts it holds, and printing them under "messages
-- from people" would tell the planner somebody asked for something
-- nobody asked for. 'person' is right for every row that exists,
-- because until now only people wrote them.
ALTER TABLE "swarm_messages" ADD COLUMN "source" text DEFAULT 'person' NOT NULL;--> statement-breakpoint

-- The fourth tier on a node, and the agent a person chose for it.
--
-- agent_profile_id is null for every leaf the template's own worker
-- runs, which is all of them until somebody reassigns one. Set null on
-- delete, like every other run-to-agent link: deleting an agent must
-- not take the plan with it.
ALTER TABLE "swarm_tasks" ADD COLUMN "cost_notional_usd" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "swarm_tasks" ADD COLUMN "agent_profile_id" uuid;--> statement-breakpoint

-- What a run that reports nothing is charged, and when a node that is
-- still being worked starts asking for a person.
--
-- assumed_cost_usd is null by default and that is deliberate: null
-- means "work it out from what this swarm has actually measured", and
-- a number here is a team saying they know their own tools better than
-- an average of them does.
--
-- The two thresholds are minutes, and they are thresholds rather than a
-- timeout because a task that takes forty minutes for being large is
-- not a failure. The first turns a node yellow for a person to glance
-- at. The second spends a planner turn deciding whether to wait,
-- message, split, or cancel. The process timeout stays where it is, as
-- the backstop.
ALTER TABLE "swarm_templates" ADD COLUMN "assumed_cost_usd" numeric;--> statement-breakpoint
ALTER TABLE "swarm_templates" ADD COLUMN "long_run_warn_min" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "swarm_templates" ADD COLUMN "long_run_escalate_min" integer DEFAULT 45 NOT NULL;--> statement-breakpoint

-- The swarm's own fourth tier, and the latch that keeps one warning
-- from becoming a warning per tick.
--
-- Notional spend is the one tier the cap does not count. The tool
-- printed a list price, a subscription had already paid for the work,
-- and the marginal cost of the run was zero: charging it against the
-- budget would stop a swarm that is costing nothing. Recorded and
-- shown, never enforced.
ALTER TABLE "swarms" ADD COLUMN "spent_notional_usd" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "swarms" ADD COLUMN "budget_warned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "swarm_tasks" ADD CONSTRAINT "swarm_tasks_agent_profile_id_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE set null ON UPDATE no action;
