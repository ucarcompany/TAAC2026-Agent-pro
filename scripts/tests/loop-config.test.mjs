import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultLoopConfig, parseLoopConfig, renderLoopConfigYaml } from "../_loop-config.mjs";

test("parseLoopConfig accepts a minimal v2 config and applies defaults", () => {
  const text = `
version: 2
plan_id: plan-1
loop:
  max_iters: 8
review: {}
compliance:
  latency_budget_ms: 30
  license_allowlist: [mit]
`;
  const cfg = parseLoopConfig(text);
  assert.equal(cfg.plan_id, "plan-1");
  assert.equal(cfg.loop.max_iters, 8);
  assert.equal(cfg.loop.metric.primary, "val_auc"); // default
  assert.equal(cfg.defaults.enable_official_submit, false); // safe default
  assert.equal(cfg.compliance.latency_budget_ms, 30);
});

test("parseLoopConfig rejects version != 2", () => {
  assert.throws(() => parseLoopConfig("version: 1\nplan_id: x\nloop: {max_iters: 1}\nreview: {}\ncompliance: {latency_budget_ms: 5, license_allowlist: [mit]}\n"),
    /version must be 2/);
});

test("parseLoopConfig rejects missing top-level field", () => {
  assert.throws(() => parseLoopConfig("version: 2\nloop: {}\nreview: {}\ncompliance: {latency_budget_ms: 5, license_allowlist: [mit]}\n"),
    /missing top-level field 'plan_id'/);
});

test("parseLoopConfig rejects enable_official_submit=true with daily_hard_ceiling=0", () => {
  const text = `
version: 2
plan_id: plan-1
defaults:
  enable_official_submit: true
  daily_hard_ceiling: 0
loop:
  max_iters: 1
review: {}
compliance:
  latency_budget_ms: 25
  license_allowlist: [mit]
`;
  assert.throws(() => parseLoopConfig(text), /requires defaults\.daily_hard_ceiling > 0/);
});

test("parseLoopConfig rejects non-positive max_iters", () => {
  const text = `
version: 2
plan_id: plan-1
loop:
  max_iters: 0
review: {}
compliance:
  latency_budget_ms: 25
  license_allowlist: [mit]
`;
  assert.throws(() => parseLoopConfig(text), /max_iters must be a positive number/);
});

test("parseLoopConfig rejects empty license_allowlist", () => {
  const text = `
version: 2
plan_id: plan-1
loop:
  max_iters: 1
review: {}
compliance:
  latency_budget_ms: 25
  license_allowlist: []
`;
  assert.throws(() => parseLoopConfig(text), /license_allowlist must be a non-empty array/);
});

test("defaultLoopConfig produces a config that round-trips through parser", () => {
  const cfg = defaultLoopConfig({ planId: "plan-roundtrip" });
  const yaml = renderLoopConfigYaml(cfg);
  const parsed = parseLoopConfig(yaml);
  assert.equal(parsed.plan_id, "plan-roundtrip");
  assert.equal(parsed.defaults.enable_official_submit, false);
  assert.equal(parsed.defaults.daily_hard_ceiling, 0);
});
