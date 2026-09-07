import { test } from "node:test";
import assert from "node:assert/strict";
import { BentoClient } from "./client.js";

test("relatedFeatures names the card in the path", async () => {
  let url = "";
  const client = new BentoClient({
    baseUrl: "http://bento.test",
    fetch: (async (input) => {
      url = String(input);
      return new Response(JSON.stringify(null), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  await client.relatedFeatures("11111111-1111-1111-1111-111111111111");
  assert.equal(url, "http://bento.test/api/features/11111111-1111-1111-1111-111111111111/related");
});
