/** Close only an isolated smoke-test app, including a hung inspector or close(). */
export async function closeElectron(application, { timeoutMs = 10_000, killTimeoutMs = 5_000 } = {}) {
  const child = application.process();
  let exited = child.exitCode !== null || child.signalCode !== null;
  let onExit;
  const exit = exited ? Promise.resolve() : new Promise(resolve => {
    onExit = () => { exited = true; resolve(); };
    child.once("exit", onExit);
  });
  let stage = "quit";
  let deadline;
  let killDeadline;
  const teardown = (async () => {
    // Keep the inspector attached through the app's asynchronous before-quit
    // handler. A disconnected inspector may reject after the process exits.
    await application.evaluate(({ app }) => new Promise(resolve => {
      app.once("will-quit", () => resolve());
      app.quit();
    })).catch(() => {});
    stage = "close";
    await application.close();
    await exit;
  })();
  try {
    const completed = await Promise.race([
      teardown.then(() => true),
      new Promise(resolve => { deadline = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    if (completed) return { forced: false };
    const timedOutAt = stage;
    const forced = !exited;
    if (forced) child.kill("SIGKILL");
    // Kill through the ChildProcess handle, never a process-name search. Wait
    // for exit and Playwright transport disposal before another fixture starts.
    await Promise.race([
      Promise.all([exit, teardown]),
      new Promise((_, reject) => { killDeadline = setTimeout(() => reject(new Error("Isolated Electron fixture did not finish cleanup after termination.")), killTimeoutMs); }),
    ]);
    return { forced, timedOutAt };
  } finally {
    clearTimeout(deadline);
    clearTimeout(killDeadline);
    if (onExit) child.off("exit", onExit);
  }
}
