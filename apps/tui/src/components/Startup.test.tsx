import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { cliVersion } from "../version.js";
import { Startup } from "./Startup.js";

test("startup shows the same version as bento --version in redirected output", async () => {
  const ui = render(<Startup message="Connecting..." />);
  try {
    const expected = `Bento ${cliVersion()}: Connecting...`;
    const deadline = Date.now() + 5000;
    while (!ui.lastFrame()?.includes(expected)) {
      if (Date.now() > deadline) throw new Error(`Startup did not show the version: ${ui.lastFrame()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(ui.lastFrame(), expected);
  } finally {
    ui.unmount();
    ui.cleanup();
  }
});
