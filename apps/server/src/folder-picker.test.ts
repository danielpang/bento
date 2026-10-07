import assert from "node:assert/strict";
import test from "node:test";
import type { AppContext } from "./context.js";
import { cleanPickedPath, folderPickerCommand, isPickerCancel } from "./folder-picker.js";
import { isLoopbackHost, settingsRoutes } from "./routes/settings.js";

const local = { env: { BENTO_MODE: "local" } } as AppContext;
const fakeCommand = async () => ({ command: "dialog", args: [] });
const post = (routes: ReturnType<typeof settingsRoutes>, body = "{}") =>
  routes.request("/folder-picker", { method: "POST", headers: { "content-type": "application/json" }, body });

test("each platform gets its own dialog, and a headless Linux gets none", async () => {
  assert.equal((await folderPickerCommand("darwin", {}))?.command, "osascript");
  assert.equal((await folderPickerCommand("win32", {}))?.command, "powershell.exe");
  assert.equal(await folderPickerCommand("linux", {}, async () => true), null, "no display, no dialog");
  assert.equal((await folderPickerCommand("linux", { DISPLAY: ":0" }, async (bin) => bin === "zenity"))?.command, "zenity");
  assert.equal((await folderPickerCommand("linux", { WAYLAND_DISPLAY: "w" }, async (bin) => bin === "kdialog"))?.command, "kdialog");
  assert.equal(await folderPickerCommand("linux", { DISPLAY: ":0" }, async () => false), null);
});

test("a picked path loses the newline and the trailing slash the dialogs print", () => {
  assert.equal(cleanPickedPath("/Users/me/code/app/\n"), "/Users/me/code/app");
  assert.equal(cleanPickedPath("C:\\code\\app\\\r\n"), "C:\\code\\app");
  assert.equal(cleanPickedPath("/\n"), "/");
  assert.equal(cleanPickedPath("  \n"), null);
});

test("Browse answers with the chosen folder, or null when the dialog is cancelled", async () => {
  const chosen = settingsRoutes(local, {
    command: fakeCommand,
    inContainer: async () => false,
    run: async () => ({ stdout: "/Users/me/code/app/\n", cancelled: false }),
  });
  assert.deepEqual(await (await chosen.request("/folder-picker")).json(), { available: true });
  assert.deepEqual(await (await post(chosen)).json(), { path: "/Users/me/code/app" });

  const cancelled = settingsRoutes(local, {
    command: fakeCommand,
    inContainer: async () => false,
    run: async () => ({ stdout: "", cancelled: true }),
  });
  assert.deepEqual(await (await post(cancelled)).json(), { path: null });
});

test("no dialog opens on a shared server, in a container, or from a form post", async () => {
  let opened = 0;
  const run = async () => {
    opened++;
    return { stdout: "/x", cancelled: false };
  };
  const multi = settingsRoutes({ env: { BENTO_MODE: "multi" } } as AppContext, { command: fakeCommand, run, inContainer: async () => false });
  assert.deepEqual(await (await multi.request("/folder-picker")).json(), { available: false });
  assert.equal((await post(multi)).status, 404);

  const container = settingsRoutes(local, { command: fakeCommand, run, inContainer: async () => true });
  assert.deepEqual(await (await container.request("/folder-picker")).json(), { available: false });
  assert.equal((await post(container)).status, 404);

  const form = settingsRoutes(local, { command: fakeCommand, run, inContainer: async () => false });
  const refused = await form.request("/folder-picker", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "a=1",
  });
  assert.notEqual(refused.status, 200);
  assert.equal(opened, 0);
});

test("a second Browse while a dialog is open is refused rather than stacked", async () => {
  let release!: () => void;
  const routes = settingsRoutes(local, {
    command: fakeCommand,
    inContainer: async () => false,
    run: () => new Promise((resolve) => { release = () => resolve({ stdout: "/a", cancelled: false }); }),
  });
  const first = post(routes);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await post(routes)).status, 409);
  release();
  assert.equal((await first).status, 200);
});

test("only a recognised cancel counts as one; any other exit 1 is a failure", () => {
  assert.equal(isPickerCancel(1, ""), true, "zenity, kdialog and PowerShell cancel silently");
  assert.equal(isPickerCancel(1, "execution error: User canceled. (-128)\n"), true, "osascript");
  assert.equal(isPickerCancel(1, "execution error: Not authorized to send Apple events. (-1743)"), false);
  assert.equal(isPickerCancel(1, "Exception calling ShowDialog"), false);
  assert.equal(isPickerCancel(2, ""), false);
  assert.equal(isPickerCancel("ENOENT", ""), false, "a missing binary is not a cancel");
});

test("the dialog is only for a browser on this machine", async () => {
  assert.equal(isLoopbackHost("http://localhost:4400/x"), true);
  assert.equal(isLoopbackHost("http://127.0.0.1:4400/x"), true);
  assert.equal(isLoopbackHost("http://[::1]:4400/x"), true);
  assert.equal(isLoopbackHost("http://192.168.1.20:4400/x"), false, "another machine on the network");
  assert.equal(isLoopbackHost("http://rebind.example.com:4400/x"), false, "DNS rebinding");

  let opened = 0;
  const routes = settingsRoutes(local, {
    command: fakeCommand,
    inContainer: async () => false,
    run: async () => {
      opened++;
      return { stdout: "/x", cancelled: false };
    },
  });
  assert.deepEqual(await (await routes.request("http://192.168.1.20:4400/folder-picker")).json(), { available: false });
  const remote = await routes.request("http://rebind.example.com/folder-picker", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(remote.status, 404);
  assert.equal(opened, 0);
});
