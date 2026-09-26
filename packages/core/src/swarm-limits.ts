/**
 * The most workers a swarm may run at once, anywhere.
 *
 * One constant, because this number used to be written out in six
 * places: three zod schemas on the server, the swarm file's parser,
 * and the console's own copy, which the New swarm dialog and the
 * templates form each read differently. Six copies of a limit is five
 * chances for the form to offer a number the route refuses, which is
 * the shape of every bug this file exists to stop.
 *
 * Ten rather than a larger figure. A swarm's workers land through one
 * merge queue, taken one at a time by the coordinator holding the
 * swarm's checkout, so raising this widens the fan out without
 * widening the funnel: past a point the extra agents finish and queue,
 * and what they cost is spent waiting. Ten is the number a person can
 * still read a board of.
 *
 * A template may of course allow fewer, and most do. This is the
 * ceiling on what a template may allow, not what one should.
 */
export const MAX_SWARM_WORKERS = 10;
