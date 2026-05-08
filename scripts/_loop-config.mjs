// taac-loop.yaml v2 schema parsing + validation.
// Schema follows skill-expansion-design-2026-05-07.md §12.
//
// We avoid a full YAML AST tool — js-yaml (already a dep) parses the file,
// then this module asserts required fields and applies safe defaults.

import yaml from "js-yaml";

const REQUIRED_TOP_LEVEL = ["plan_id", "loop", "review", "compliance"];

const DEFAULTS = Object.freeze({
  defaults: {
    enable_official_submit: false,    // mutation safety: must be explicit
    daily_hard_ceiling: 0,            // 0 = official submit disabled
    allow_network: false,             // no lit-mine inside auto-loop
  },
  loop: {
    max_iters: 12,
    schedule_window: "00:00-08:00",
    gpu_host: "gpu-01.lan",
    ssh_session_reuse: true,
    metric: { primary: "val_auc", threshold_delta: 0.001 },
    retry: { max_per_iter: 2 },
    kill_switch_path: null,           // populated at runtime
    remote_auth: "key",                // "key" | "password" (M5.5)
  },
  quota: {
    daily_official: 5,
    hard_ceiling: 3,
    daily_hard_ceiling: 0,
  },
  review: {
    train_token_ttl_hours: 24,
    submit_token_ttl_hours: 2,
    hmac_secret_env: "TAAC_REVIEW_HMAC_KEY",
    require_two_human_for_submit: true,
  },
  literature: {
    arxiv_delay_seconds: 3,
    github_per_page: 30,
    github_code_search_per_minute: 10,
    serpapi_monthly_quota_env: "SERPAPI_MONTHLY_QUOTA",
    max_papers_per_proposal: 8,
    cache_ttl_hours: 24,
  },
  compliance: {
    non_ensemble: true,
    latency_budget_ms: 25,
    pii_scan: true,
    license_allowlist: ["cc-by-nc-4.0", "mit", "apache-2.0", "bsd-3-clause"],
  },
});

function deepMerge(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object") {
      out[key] = deepMerge(target[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function parseLoopConfig(text) {
  let raw;
  try {
    raw = yaml.load(text);
  } catch (error) {
    throw new Error(`taac-loop.yaml is not valid YAML: ${error.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("taac-loop.yaml must be a top-level mapping");
  }
  if (raw.version !== 2) {
    throw new Error(`taac-loop.yaml: version must be 2 (got ${JSON.stringify(raw.version)})`);
  }
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in raw)) throw new Error(`taac-loop.yaml: missing top-level field '${key}'`);
  }

  const merged = deepMerge(DEFAULTS, raw);

  // Mutation-safety guard rails.
  if (merged.defaults.enable_official_submit && !merged.defaults.daily_hard_ceiling) {
    throw new Error("defaults.enable_official_submit=true requires defaults.daily_hard_ceiling > 0");
  }
  if (typeof merged.loop.max_iters !== "number" || merged.loop.max_iters <= 0) {
    throw new Error(`loop.max_iters must be a positive number (got ${merged.loop.max_iters})`);
  }
  if (typeof merged.loop.metric?.threshold_delta !== "number") {
    throw new Error("loop.metric.threshold_delta must be a number");
  }
  if (typeof merged.loop.retry?.max_per_iter !== "number" || merged.loop.retry.max_per_iter < 0) {
    throw new Error("loop.retry.max_per_iter must be a non-negative number");
  }
  if (!Array.isArray(merged.compliance?.license_allowlist) || merged.compliance.license_allowlist.length === 0) {
    throw new Error("compliance.license_allowlist must be a non-empty array");
  }
  if (typeof merged.compliance?.latency_budget_ms !== "number" || merged.compliance.latency_budget_ms <= 0) {
    throw new Error("compliance.latency_budget_ms must be a positive number");
  }
  if (merged.loop.remote_auth !== "key" && merged.loop.remote_auth !== "password") {
    throw new Error(`loop.remote_auth must be 'key' or 'password' (got ${JSON.stringify(merged.loop.remote_auth)})`);
  }

  return merged;
}

export function defaultLoopConfig({ planId, gpuHost = "gpu-01.lan" }) {
  return {
    version: 2,
    plan_id: planId,
    defaults: { ...DEFAULTS.defaults },
    loop: { ...DEFAULTS.loop, gpu_host: gpuHost, kill_switch_path: `~/taac-runs/${planId}/KILL` },
    quota: { ...DEFAULTS.quota },
    review: { ...DEFAULTS.review },
    literature: { ...DEFAULTS.literature },
    compliance: { ...DEFAULTS.compliance },
  };
}

export function renderLoopConfigYaml(config) {
  return yaml.dump(config, { lineWidth: 100, noRefs: true });
}

export { DEFAULTS };
