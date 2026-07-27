/** Public surface for embedding the server in another process. */
export { startServer, type StartOptions, type RunningServer } from "./server.js";
export { ensureLocalPostgres, type LocalPostgres } from "./local-postgres.js";
