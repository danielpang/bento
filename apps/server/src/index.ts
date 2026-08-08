import { startServer } from "./server.js";

startServer()
  .then((server) => {
    /**
     * A deploy sends SIGTERM and expects the process to leave; without
     * a handler the runtime just dies mid-write, which is the hard kill
     * every open stream and half-finished insert experiences. Runs in
     * flight are deliberately not touched here: their sandboxes keep
     * the agents alive through the disconnect grace, and the next
     * boot's recovery reattaches to them (see recoverInterruptedRuns).
     * The deadline covers a stop that cannot finish, a closing pool
     * with a wedged connection for instance, so the platform is not
     * left waiting on a process that will never exit on its own.
     */
    let stopping = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      console.log(`received ${signal}, shutting down`);
      const deadline = setTimeout(() => process.exit(1), 10_000);
      deadline.unref();
      void server.stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
