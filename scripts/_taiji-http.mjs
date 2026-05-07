// Shared HTTP / path / atomic-write helpers for the TAAC2026 CLI.
//
// This module exists to fix three classes of issues identified in
// taiji-output/reports/code-audit-2026-05-07.md:
//   - P0: Cookie cross-origin leakage (fetchBinaryDirect transparently
//         forwarded the Taiji session cookie to any URL).
//   - P1: Missing fetch timeouts / retries; inconsistent body.error.code
//         validation; non-atomic state writes; duplicated helpers.
//
// Keep this file dependency-free (only node: built-ins) and small.

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const TAIJI_ORIGIN = "https://taiji.algo.qq.com";

// Hosts that are allowed to receive a Taiji session cookie. Anything else
// must be fetched anonymously (no cookie header) or rejected.
export const TAIJI_COOKIE_HOST_ALLOWLIST = new Set([
  "taiji.algo.qq.com",
]);

// Hosts that legitimately serve training/evaluation artefacts. We allow
// anonymous binary fetches against these as a fallback when a path looks
// like an HTTPS URL (e.g. presigned COS URLs). Cookies are never sent here.
export const TAIJI_ARTIFACT_HOST_SUFFIX_ALLOWLIST = [
  ".cos.ap-guangzhou.myqcloud.com",
  ".myqcloud.com",
];

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 500, retryStatuses: new Set([408, 429, 500, 502, 503, 504]) };

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147 Safari/537.36";

export function isHostAllowedForCookie(urlString) {
  try {
    const host = new URL(urlString).host.toLowerCase();
    return TAIJI_COOKIE_HOST_ALLOWLIST.has(host);
  } catch {
    return false;
  }
}

export function isHostAllowedForArtifact(urlString) {
  try {
    const host = new URL(urlString).host.toLowerCase();
    if (TAIJI_COOKIE_HOST_ALLOWLIST.has(host)) return true;
    return TAIJI_ARTIFACT_HOST_SUFFIX_ALLOWLIST.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

export function assertCookieHostAllowed(urlString) {
  if (!isHostAllowedForCookie(urlString)) {
    const host = (() => { try { return new URL(urlString).host; } catch { return "<unparseable>"; } })();
    throw new Error(`Refusing to send Taiji cookie to non-allowlisted host: ${host}`);
  }
}

export function assertArtifactHostAllowed(urlString) {
  if (!isHostAllowedForArtifact(urlString)) {
    const host = (() => { try { return new URL(urlString).host; } catch { return "<unparseable>"; } })();
    throw new Error(`Refusing to fetch artifact from non-allowlisted host: ${host}`);
  }
}

export function taijiHeaders(cookieHeader, refererPath = "/training") {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    cookie: cookieHeader,
    referer: `${TAIJI_ORIGIN}${refererPath}`,
    "user-agent": DEFAULT_USER_AGENT,
  };
}

export function extractCookieHeader(fileContent) {
  const text = String(fileContent ?? "").trim();
  const headerLine = text.match(/^cookie:\s*(.+)$/im);
  if (headerLine) return headerLine[1].trim();
  const curlHeader = text.match(/(?:-H|--header)\s+(['"])cookie:\s*([\s\S]*?)\1/i);
  if (curlHeader) return curlHeader[2].trim();
  return text.replace(/^cookie:\s*/i, "").trim();
}

export async function readCookieHeader(cookieFile) {
  if (!cookieFile) throw new Error("Missing cookie file");
  const content = await readFile(path.resolve(cookieFile), "utf8");
  const cookieHeader = extractCookieHeader(content);
  if (!cookieHeader) throw new Error(`No cookie header parsed from ${cookieFile}`);
  return cookieHeader;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fetch with AbortSignal.timeout + bounded exponential backoff for transient
// failures. Non-2xx responses with a retryable status are retried; everything
// else is returned (so the caller can read body for failure context).
export async function fetchWithRetry(url, init = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retry = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
  let lastError = null;

  for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!retry.retryStatuses.has(response.status) || attempt === retry.attempts - 1) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
      // Retry on AbortError (timeout) and generic network errors.
    }
    const delay = retry.baseDelayMs * 2 ** attempt;
    await sleep(delay);
  }
  throw lastError ?? new Error(`Request failed after ${retry.attempts} attempts: ${url}`);
}

// JSON helper used by submit / scrape / evaluation paths. Validates HTTP
// status AND the Taiji business-level error code when present.
export async function fetchTaijiJson(cookieHeader, endpoint, options = {}) {
  const url = new URL(endpoint, TAIJI_ORIGIN).href;
  assertCookieHostAllowed(url);

  const init = {
    method: options.method || "GET",
    headers: taijiHeaders(cookieHeader, options.refererPath),
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  const response = await fetchWithRetry(url, init, {
    timeoutMs: options.timeoutMs,
    retry: options.retry,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${new URL(url).pathname}: ${String(text).slice(0, 300)}`);
  }
  // Reject HTTP-200 responses that carry a business-level failure.
  if (body && typeof body === "object" && body.error && typeof body.error === "object") {
    const code = body.error.code;
    if (code && code !== "SUCCESS" && code !== 0 && code !== "0") {
      const message = body.error.message ?? body.error.msg ?? JSON.stringify(body.error);
      throw new Error(`Taiji error.code=${code} at ${new URL(url).pathname}: ${String(message).slice(0, 300)}`);
    }
  }
  return body;
}

// Binary fetch that *only* attaches the Taiji cookie when the target host is
// in the allowlist. Anything else falls back to anonymous fetch to prevent
// session leakage to attacker-controlled URLs (audit P0 §2.1).
export async function fetchTaijiBinary(cookieHeader, resourceUrl, options = {}) {
  assertArtifactHostAllowed(resourceUrl);

  const headers = {
    accept: "*/*",
    referer: `${TAIJI_ORIGIN}${options.refererPath ?? "/training"}`,
    "user-agent": DEFAULT_USER_AGENT,
  };
  if (cookieHeader && isHostAllowedForCookie(resourceUrl)) {
    headers.cookie = cookieHeader;
  }

  const response = await fetchWithRetry(resourceUrl, { headers }, {
    timeoutMs: options.timeoutMs,
    retry: options.retry,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type"),
    buffer,
  };
}

export async function fetchTaijiText(cookieHeader, resourceUrl, options = {}) {
  const result = await fetchTaijiBinary(cookieHeader, resourceUrl, options);
  return { ...result, text: result.buffer.toString("utf8") };
}

// Atomic JSON write: writes to <path>.tmp then renames into place. Survives
// process crash / Ctrl-C without truncating the prior good file (audit P1 §3.3).
export async function atomicWriteFile(targetPath, data, options = {}) {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, options.encoding ?? "utf8");
  await rename(tmp, targetPath);
}

export async function atomicWriteJson(targetPath, value, options = {}) {
  const text = `${JSON.stringify(value, null, options.indent ?? 2)}\n`;
  await atomicWriteFile(targetPath, text, { encoding: "utf8" });
}

// Generic safe relative-path joiner: refuses '.' / '..' segments and any
// resolved path that escapes baseDir. Used by data-ingest, scrape's code
// downloader, and evaluation file saver (audit P0 §2.2).
export function joinSafeRelative(baseDir, relativeParts) {
  const parts = (Array.isArray(relativeParts) ? relativeParts : [relativeParts])
    .flatMap((part) => String(part ?? "").split(/[\\/]+/))
    .filter(Boolean);
  for (const part of parts) {
    if (part === "." || part === ".." || part.includes("\0")) {
      throw new Error(`Unsafe path segment: ${JSON.stringify(part)}`);
    }
  }
  const joined = path.resolve(baseDir, ...parts);
  const rel = path.relative(path.resolve(baseDir), joined);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${JSON.stringify(rel)}`);
  }
  return joined;
}
