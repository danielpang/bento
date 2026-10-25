import { test } from "node:test";
import assert from "node:assert/strict";
import { captureWaitlistIntent, hasWaitlistIntent, signInCallbackURL, takeWaitlistIntent } from "./swarm/waitlist-intent.js";

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

test("the landing page's waitlist link is kept through sign in and taken once", () => {
  const store = memory();
  let replaced: string | null = null;
  captureWaitlistIntent({ pathname: "/", search: "?waitlist=swarms&mode=swarms", hash: "" }, store, (url) => {
    replaced = url;
  });
  assert.equal(replaced, "/?mode=swarms", "the parameter leaves the address");
  assert.equal(takeWaitlistIntent(store), true);
  assert.equal(takeWaitlistIntent(store), false, "a reload does not join again");
});

test("an address without the parameter leaves nothing behind", () => {
  const store = memory();
  let replaced = false;
  captureWaitlistIntent({ pathname: "/", search: "?waitlist=other", hash: "" }, store, () => {
    replaced = true;
  });
  assert.equal(replaced, false);
  assert.equal(takeWaitlistIntent(store), false);
});

test("sign in sends the intent back through the address, so another browser still has it", () => {
  const store = memory();
  assert.equal(signInCallbackURL(store), "/");
  captureWaitlistIntent({ pathname: "/", search: "?waitlist=swarms", hash: "" }, store, () => {});
  assert.equal(signInCallbackURL(store), "/?waitlist=swarms");
  assert.equal(hasWaitlistIntent(store), true, "asking does not use it up");
});
