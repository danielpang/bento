/**
 * How deep a plan may be decomposed by agents other than the one
 * planner. One means the planner writes the whole tree; each level
 * past it lets a node be handed to a sub planner. Three, because a
 * planner that plans planners that plan planners is already more
 * coordination than one merge queue can use.
 */
export const MAX_PLAN_DEPTH = 3;
