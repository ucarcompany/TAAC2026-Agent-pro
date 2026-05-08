import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildFingerprint,
  detectLayer,
  normalizeMessage,
  normalizeStackTrace,
} from "../_error-fingerprint.mjs";

const CUDA_OOM_LOG_A = `
2026-05-08T03:14:01.123Z [pid 12345] starting iter 4
allocating 4096 MiB on GPU 0 ...
Traceback (most recent call last):
  File "/var/run/code/train.py", line 142, in train_step
    out = model(x.cuda())
  File "/usr/lib/python3.10/site-packages/torch/nn/modules/module.py", line 1518, in _call_impl
    return forward_call(*args, **kwargs)
  File "/var/run/code/model.py", line 88, in forward
    return self.tower(x)
RuntimeError: CUDA out of memory. Tried to allocate 2048.00 MiB (GPU 0; 24.00 GiB total capacity)
`;

const CUDA_OOM_LOG_B = `
2026-05-09T11:52:18.987Z [pid 99887] starting iter 7
allocating 8192 MiB on GPU 1 ...
Traceback (most recent call last):
  File "C:\\Users\\worker\\code\\train.py", line 200, in train_step
    out = model(x.cuda())
  File "C:\\python310\\site-packages\\torch\\nn\\modules\\module.py", line 1518, in _call_impl
    return forward_call(*args, **kwargs)
  File "C:\\Users\\worker\\code\\model.py", line 95, in forward
    return self.tower(x)
RuntimeError: CUDA out of memory. Tried to allocate 4096.00 MiB (GPU 1; 24.00 GiB total capacity)
`;

const SUBMIT_422_LOG = `
HTTP 422 /taskmanagement/api/v1/webtasks/external/task: {"error":{"code":"INVALID_TRAINFILE","message":"trainFiles[0].size mismatch"}}
`;

const NETWORK_5XX_LOG = `
fetch failed: ETIMEDOUT 117.50.48.78:443 after 60000ms
HTTP 503 /taskmanagement/api/v1/webtasks/external/task
`;

test("normalizeMessage replaces shapes / addresses / paths / numbers", () => {
  const a = normalizeMessage('RuntimeError: shape [1, 32, 64, 64] at 0x7f8a2c0e1100 in "/tmp/code/train.py", line 142, allocated 4096 MiB');
  assert.match(a, /<SHAPE>/);
  assert.match(a, /<ADDR>/);
  assert.match(a, /<MEM>/);
  assert.match(a, /line <N>/);
});

test("normalizeStackTrace pulls top-3 module.func from python traceback", () => {
  const frames = normalizeStackTrace(CUDA_OOM_LOG_A);
  assert.equal(frames.length, 3);
  assert.equal(frames[0], "train.train_step");
  assert.equal(frames[1], "module._call_impl");
  assert.equal(frames[2], "model.forward");
});

test("normalizeStackTrace handles Node-style 'at module.func (...)'", () => {
  const trace = `
    at submitTaiji.uploadToCos (/repo/scripts/submit-taiji.mjs:200:5)
    at async main (/repo/scripts/submit-taiji.mjs:300:1)
  `;
  const frames = normalizeStackTrace(trace);
  assert.deepEqual(frames, ["submitTaiji.uploadToCos", "main"]);
});

test("detectLayer recognises CUDA OOM as gpu", () => {
  const norm = normalizeMessage(CUDA_OOM_LOG_A.split(/\r?\n/).filter(Boolean).at(-1));
  assert.equal(detectLayer(norm), "gpu");
});

test("detectLayer recognises submit 422 as submit-api, network 5xx as network, 401 as auth, 429 as quota", () => {
  assert.equal(detectLayer(normalizeMessage(SUBMIT_422_LOG)), "submit-api");
  assert.equal(detectLayer(normalizeMessage(NETWORK_5XX_LOG)), "network");
  assert.equal(detectLayer(normalizeMessage("HTTP 401 Unauthorized")), "auth");
  assert.equal(detectLayer(normalizeMessage("HTTP 429 quota exceeded")), "quota");
});

test("buildFingerprint produces the SAME sig for the same root cause across runs", () => {
  const fpA = buildFingerprint({ rawText: CUDA_OOM_LOG_A });
  const fpB = buildFingerprint({ rawText: CUDA_OOM_LOG_B });
  assert.equal(fpA.layer, "gpu");
  assert.equal(fpB.layer, "gpu");
  assert.equal(fpA.sig, fpB.sig, `OOM sigs must match across runs.\nA=${fpA.sig}\nB=${fpB.sig}`);
  assert.equal(fpA.exception_class, "RuntimeError");
});

test("buildFingerprint produces DIFFERENT sigs for different root causes", () => {
  const oom = buildFingerprint({ rawText: CUDA_OOM_LOG_A });
  const submit = buildFingerprint({ rawText: SUBMIT_422_LOG });
  const net = buildFingerprint({ rawText: NETWORK_5XX_LOG });
  assert.notEqual(oom.sig, submit.sig);
  assert.notEqual(oom.sig, net.sig);
  assert.notEqual(submit.sig, net.sig);
  assert.equal(submit.layer, "submit-api");
  assert.equal(net.layer, "network");
});

test("buildFingerprint sig is sha256-prefixed 64 hex chars", () => {
  const fp = buildFingerprint({ rawText: CUDA_OOM_LOG_A });
  assert.match(fp.sig, /^sha256:[0-9a-f]{64}$/);
});

test("buildFingerprint trusts statusJson.layer when provided", () => {
  const fp = buildFingerprint({
    rawText: "Some generic message",
    statusJson: { phase: "failed", layer: "data" },
  });
  assert.equal(fp.layer, "data");
});
