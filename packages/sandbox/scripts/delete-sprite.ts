/**
 * Deletes a sprite by name, and says whether it really went.
 *
 * The last resort behind sprite.e2e.test.ts. That test deletes its own
 * machine and asserts the deletion, but a job that is cancelled or hits
 * its timeout kills the process before any of that runs, and a sprite
 * lives until something deletes it. So the workflow runs this after the
 * test whatever happened, with the name worked out from the run id.
 *
 * Finding it already gone is the normal case, not an error: the test
 * usually got there first. Not being able to tell is an error, because
 * "I could not reach the API" and "there is no such machine" are the
 * same silence, and only one of them is free.
 *
 *   node --import tsx scripts/delete-sprite.ts bento-e2e-123-1
 */
import { SpritesClient } from "@fly/sprites";
import { spriteExists } from "../src/sprite.js";

const name = process.argv[2];
const token = process.env.SPRITES_TOKEN;

if (!name) {
  console.error("usage: delete-sprite.ts <sprite name>");
  process.exit(2);
}
if (!token) {
  console.error("SPRITES_TOKEN is not set");
  process.exit(2);
}

const client = new SpritesClient(token, { timeout: 60_000 });

try {
  if (!(await spriteExists(client, name))) {
    console.log(`${name} is already gone`);
    process.exit(0);
  }

  console.log(`${name} outlived its test, deleting it`);
  await client.deleteSprite(name);

  // Confirmed rather than assumed, for the same reason the test
  // confirms it: an unnoticed leak is a machine that goes on being
  // billed with nobody looking for it.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!(await spriteExists(client, name))) {
      console.log(`${name} is deleted`);
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  console.error(`::error::${name} is still there a minute after being deleted, and is still being billed`);
  process.exit(1);
} catch (err) {
  // An unanswerable question is not a clean bill of health. Said as an
  // annotation so it is visible on the job rather than only in the log.
  console.error(`::error::could not confirm whether ${name} still exists: ${String(err)}`);
  process.exit(1);
}
