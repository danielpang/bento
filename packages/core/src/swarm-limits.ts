/**
 * The most workers a swarm may run at once, anywhere.
 *
 * One constant, because this number used to be written out in six
 * places, and the New swarm dialog and the server each read their own
 * copy differently. Six copies of a limit is five
 * chances for the form to offer a number the route refuses, which is
 * the shape of every bug this file exists to stop.
 *
 * Ten rather than a larger figure. A swarm's workers land through one
 * merge queue, taken one at a time by the coordinator holding the
 * swarm's checkout, so raising this widens the fan out without
 * widening the funnel: past a point the extra agents finish and queue,
 * and what they cost is spent waiting. Ten is the number a person can
 * still read a board of.
 */
export const MAX_SWARM_WORKERS = 10;

/** The goal is stored as text and sent to the planner as its opening brief. */
export const MAX_SWARM_GOAL_CHARS = 100_000;

/**
 * How deep a plan may be decomposed by agents other than the one
 * planner. One means the planner writes the whole tree; each level
 * past it lets a node be handed to a sub planner. Three, because a
 * planner that plans planners that plan planners is already more
 * coordination than one merge queue can use.
 */
export const MAX_PLAN_DEPTH = 3;

/**
 * How much of a plan a person may hand a swarm at creation.
 *
 * A plan source is one file somebody uploaded or one web page the
 * server fetched for them, stored as text and read by the planner
 * before it builds the tree. The caps are what Postgres holds without
 * complaint and what a planner can actually read: a plan of twenty
 * documents is a plan somebody should have assembled first, and a
 * single source past a few hundred thousand characters is a dump of
 * something rather than a plan.
 *
 * In one place for the reason MAX_SWARM_WORKERS is: the New swarm
 * dialog refuses the same set the route refuses, so a person is told
 * before the request is sent rather than after.
 */
export const MAX_SWARM_PLAN_SOURCES = 20;

/** Characters of text one plan source may hold. */
export const MAX_SWARM_PLAN_SOURCE_CHARS = 300_000;

/** Characters of text every plan source of one swarm may hold together. */
export const MAX_SWARM_PLAN_CHARS = 1_000_000;

/** How long the name of an uploaded plan file may be, path included. */
export const MAX_SWARM_PLAN_SOURCE_NAME_CHARS = 240;

/**
 * Bytes one PDF or image plan source may hold, and bytes every binary
 * source of one swarm may hold together. Separate from the character
 * caps above because a PDF's size says nothing about how much text is
 * in it, and a mockup is read by the agent's eyes rather than as
 * text. Ten megabytes is a long design document or a large screenshot;
 * past that a plan source is a dump of something.
 */
export const MAX_SWARM_PLAN_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_SWARM_PLAN_BYTES = 30 * 1024 * 1024;
