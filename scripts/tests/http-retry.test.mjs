import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchTaijiJson, fetchWithRetry } from "../_taiji-http.mjs";

test("fetchWithRetry retries on 503 then returns success", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("temporarily unavailable", { status: 503 });
    return new Response("ok", { status: 200 });
  };
  try {
    const response = await fetchWithRetry("https://taiji.algo.qq.com/x", {}, {
      retry: { attempts: 3, baseDelayMs: 1, retryStatuses: new Set([503]) },
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchTaijiJson rejects HTTP-200 with business error.code", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: "QUOTA_EXCEEDED", message: "daily limit reached" }, data: null }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  try {
    await assert.rejects(
      fetchTaijiJson("session=x", "/aide/api/x"),
      /Taiji error\.code=QUOTA_EXCEEDED/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchTaijiJson refuses non-Taiji endpoint", async () => {
  await assert.rejects(
    fetchTaijiJson("session=x", "https://attacker.example/api/x"),
    /Refusing to send Taiji cookie/,
  );
});

test("fetchTaijiJson accepts SUCCESS error.code as success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: "SUCCESS" }, data: { hello: "world" } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  try {
    const body = await fetchTaijiJson("session=x", "/aide/api/x");
    assert.equal(body.data.hello, "world");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
