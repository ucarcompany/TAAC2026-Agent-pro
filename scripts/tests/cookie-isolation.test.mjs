import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertArtifactHostAllowed,
  assertCookieHostAllowed,
  fetchTaijiBinary,
  isHostAllowedForArtifact,
  isHostAllowedForCookie,
} from "../_taiji-http.mjs";

test("cookie host allowlist accepts only Taiji hosts", () => {
  assert.equal(isHostAllowedForCookie("https://taiji.algo.qq.com/x"), true);
  assert.equal(isHostAllowedForCookie("https://attacker.example/x"), false);
  assert.equal(isHostAllowedForCookie("https://hunyuan-external-1258344706.cos.ap-guangzhou.myqcloud.com/x"), false);
});

test("artifact host allowlist accepts Taiji + COS suffixes", () => {
  assert.equal(isHostAllowedForArtifact("https://taiji.algo.qq.com/x"), true);
  assert.equal(isHostAllowedForArtifact("https://hunyuan-external-1258344706.cos.ap-guangzhou.myqcloud.com/x"), true);
  assert.equal(isHostAllowedForArtifact("https://attacker.example/x"), false);
});

test("assertCookieHostAllowed rejects non-Taiji hosts", () => {
  assert.throws(() => assertCookieHostAllowed("https://attacker.example/x"), /Refusing to send Taiji cookie/);
  assert.doesNotThrow(() => assertCookieHostAllowed("https://taiji.algo.qq.com/api/x"));
});

test("fetchTaijiBinary refuses to attach cookie to a COS host", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { "content-type": "application/octet-stream" } });
  };
  try {
    await fetchTaijiBinary("session=secret", "https://hunyuan-external-1258344706.cos.ap-guangzhou.myqcloud.com/asset.zip");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.cookie, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchTaijiBinary attaches cookie when host is Taiji", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(Buffer.from([9]), { status: 200 });
  };
  try {
    await fetchTaijiBinary("session=secret", "https://taiji.algo.qq.com/file/x");
    assert.equal(calls[0].headers.cookie, "session=secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchTaijiBinary refuses non-allowlisted host before any fetch", async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return new Response("nope"); };
  try {
    await assert.rejects(
      fetchTaijiBinary("session=secret", "https://attacker.example/x"),
      /Refusing to fetch artifact from non-allowlisted host/,
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assertArtifactHostAllowed accepts Taiji and COS but not generic hosts", () => {
  assert.doesNotThrow(() => assertArtifactHostAllowed("https://taiji.algo.qq.com/x"));
  assert.doesNotThrow(() => assertArtifactHostAllowed("https://abc.cos.ap-guangzhou.myqcloud.com/y"));
  assert.throws(() => assertArtifactHostAllowed("https://huggingface.co/z"), /non-allowlisted/);
});
