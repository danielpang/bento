/**
 * Terminates a Modal sandbox by name, and deletes an exit snapshot
 * when the terminate left one.
 *
 * The last resort behind modal.e2e.test.ts. That test destroys its own
 * machine, but a cancelled job kills the process first. A sandbox
 * bills until something terminates it.
 *
 * Already gone is the normal case. Not being able to tell is an error.
 *
 * The product secret is MODAL_TOKEN_SECRET. This script, and only this
 * script plus the e2e file, also accepts MODAL_SECRET_TOKEN when the
 * product name is unset. The value is never printed.
 *
 *   node --import tsx scripts/delete-modal-sandbox.ts bento-e2e-123-1
 */
import { ModalClient, NotFoundError } from "modal";

const name = process.argv[2];
const tokenId = process.env.MODAL_TOKEN_ID;
const tokenSecret = process.env.MODAL_TOKEN_SECRET || process.env.MODAL_SECRET_TOKEN;
const environment = process.env.MODAL_ENVIRONMENT;

if (!name) {
  console.error("usage: delete-modal-sandbox.ts <sandbox name>");
  process.exit(2);
}
if (!tokenId || !tokenSecret) {
  console.error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set");
  process.exit(2);
}

const client = new ModalClient({
  tokenId,
  tokenSecret,
  ...(environment ? { environment } : {}),
});

try {
  const sandbox = await client.sandboxes.fromName("bento-sandboxes", name, environment ? { environment } : undefined);
  console.log(`${name} outlived its test, terminating it`);
  await sandbox.terminate();
  try {
    const image = await sandbox.experimentalGetExitSnapshot();
    if (image.imageId) await client.images.delete(image.imageId);
  } catch {
    // No exit snapshot was kept. The machine is already stopped.
  }
  console.log(`${name} is terminated`);
} catch (err) {
  if (err instanceof NotFoundError || (err instanceof Error && err.name.includes("NotFound"))) {
    console.log(`${name} is already gone`);
    process.exit(0);
  }
  console.error(`::error::could not confirm whether ${name} still exists`);
  process.exit(1);
}
