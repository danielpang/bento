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
