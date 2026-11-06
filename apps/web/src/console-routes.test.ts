import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isConsolePath } from "@bento/core";

const ID = "00000000-0000-0000-0000-000000000000";

/**
 * Every path the console routes on, read from the routing code itself,
 * with each id pattern filled in. A page added there and not to
 * CONSOLE_PAGES would open in the browser from the Mac app.
 */
function routedPaths(): string[] {
  const paths = new Set<string>();
  for (const file of ["./App.tsx", "./artifacts-routes.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const [, literal] of source.matchAll(/(?:pathname|path) === "(\/[^"]*)"/g)) paths.add(literal!);
    for (const [, pattern] of source.matchAll(/match\(\/\^((?:\\\/[a-z-]+)+)\\\/\(\[0-9a-f-\]\{36\}\)\$\//g)) {
      paths.add(`${pattern!.replaceAll("\\/", "/")}/${ID}`);
    }
  }
  return [...paths];
}

test("every page the console routes is one the Mac app keeps in its window", () => {
  const paths = routedPaths();
  for (const expected of ["/settings", "/sessions", "/artifacts", `/artifacts/${ID}`, `/session/${ID}`, `/artifact/${ID}`]) {
    assert.ok(paths.includes(expected), `the scan found ${expected}`);
  }
  for (const path of paths) assert.ok(isConsolePath(path), `${path} is a console page`);
});

test("API and asset paths are never console pages", () => {
  for (const path of ["/api/projects", "/assets/app.js", "/artifacts/not-a-card", `/artifacts/${ID}/content`, "/mcp"]) {
    assert.equal(isConsolePath(path), false, path);
  }
});
