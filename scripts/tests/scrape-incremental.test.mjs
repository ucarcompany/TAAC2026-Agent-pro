import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOWNLOAD_VALIDATION_VERSION,
  filterJobsForArgs,
  shouldSkipJobDeepSync,
  validateTrainFileDownload,
} from "../scrape-taiji.mjs";

test("incremental sync skips unchanged terminal jobs with complete cached data", () => {
  const current = {
    updateTime: "2026-05-05T17:06:54+08:00",
    status: "SUCCEED",
    jzStatus: "END",
    code: { files: 3, saved: 3, downloadVersion: DOWNLOAD_VALIDATION_VERSION },
    instancesById: {
      instance_a: { error: null, metrics: { auc: {} }, log: { lines: 10 } },
    },
  };
  const listed = {
    taskID: "job_a",
    id: 123,
    updateTime: "2026-05-05T17:06:54+08:00",
    status: "SUCCEED",
    jzStatus: "END",
  };

  assert.deepEqual(shouldSkipJobDeepSync(current, listed, { incremental: true }), {
    skip: true,
    reason: "unchanged_terminal_job",
  });
});

test("incremental sync refreshes changed, running, or incomplete cached jobs", () => {
  const complete = {
    updateTime: "2026-05-05T17:06:54+08:00",
    status: "SUCCEED",
    jzStatus: "END",
    code: { files: 3, saved: 3, downloadVersion: DOWNLOAD_VALIDATION_VERSION },
    instancesById: {
      instance_a: { error: null, metrics: { auc: {} }, log: { lines: 10 } },
    },
  };

  assert.equal(
    shouldSkipJobDeepSync(
      complete,
      { taskID: "job_a", updateTime: "2026-05-05T18:00:00+08:00", status: "SUCCEED", jzStatus: "END" },
      { incremental: true },
    ).skip,
    false,
  );
  assert.equal(
    shouldSkipJobDeepSync(
      complete,
      { taskID: "job_a", updateTime: complete.updateTime, status: "RUNNING", jzStatus: "RUNNING" },
      { incremental: true },
    ).skip,
    false,
  );
  assert.equal(
    shouldSkipJobDeepSync(
      { ...complete, code: { error: "previous fetch failed" } },
      { taskID: "job_a", updateTime: complete.updateTime, status: "SUCCEED", jzStatus: "END" },
      { incremental: true },
    ).skip,
    false,
  );
  assert.equal(
    shouldSkipJobDeepSync(
      { ...complete, code: { files: 3, saved: 3 } },
      { taskID: "job_a", updateTime: complete.updateTime, status: "SUCCEED", jzStatus: "END" },
      { incremental: true },
    ).skip,
    false,
  );
  assert.equal(
    shouldSkipJobDeepSync(
      complete,
      { taskID: "job_a", updateTime: complete.updateTime, status: "SUCCEED", jzStatus: "END" },
      { incremental: false },
    ).skip,
    false,
  );
});

test("download validation rejects Taiji SPA HTML saved as trainFiles", () => {
  assert.throws(
    () =>
      validateTrainFileDownload(
        { name: "config.yaml", size: 1432 },
        {
          buffer: Buffer.from("<!doctype html><html><title>Tencent Angel Machine Learning Platform</title></html>"),
          contentType: "text/html",
        },
      ),
    /HTML page/,
  );
});

test("download validation checks zip magic, yaml shape, and expected size", () => {
  assert.throws(
    () => validateTrainFileDownload({ name: "code.zip", size: 4 }, { buffer: Buffer.from("nope"), contentType: "" }),
    /ZIP magic/,
  );
  assert.throws(
    () =>
      validateTrainFileDownload(
        { name: "config.yaml", size: 13 },
        { buffer: Buffer.from("plain scalar\n"), contentType: "" },
      ),
    /YAML mapping/,
  );
  assert.throws(
    () =>
      validateTrainFileDownload(
        { name: "run.sh", size: 99 },
        { buffer: Buffer.from("#!/usr/bin/env bash\n"), contentType: "text/x-shellscript" },
      ),
    /size mismatch/,
  );

  assert.equal(
    validateTrainFileDownload(
      { name: "code.zip", size: 4 },
      { buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]), contentType: "application/zip" },
    ).bytes,
    4,
  );
  assert.equal(
    validateTrainFileDownload(
      { name: "config.yaml", size: 13 },
      { buffer: Buffer.from("foo: bar\nx: 1"), contentType: "" },
    ).bytes,
    13,
  );
});

test("job filters support targeted scrape by internal id or task id", () => {
  const jobs = [
    { id: 56242, taskID: "job_a" },
    { id: 58244, taskID: "job_b" },
  ];

  assert.deepEqual(filterJobsForArgs(jobs, { jobInternalId: "56242" }), [{ id: 56242, taskID: "job_a" }]);
  assert.deepEqual(filterJobsForArgs(jobs, { jobId: "job_b" }), [{ id: 58244, taskID: "job_b" }]);
  assert.deepEqual(filterJobsForArgs(jobs, {}), jobs);
});
