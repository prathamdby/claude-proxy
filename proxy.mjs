#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

// ---------------------------------------------------------------------------
// Configuration.
//
// Every variable is required and nothing has a default: no fallback literals,
// no implicitly-on flags, no silent coercion. Everything is read and validated
// here, above every other module-level initialiser, so a bad value is named
// instead of surfacing further down as `new URL(undefined)`, `listen(NaN)`, a
// socket timeout that never fires or a body limit that never trips. Every
// problem is collected and reported together so a fresh setup is fixed in one
// pass instead of one variable per restart.
// ---------------------------------------------------------------------------
const config = (() => {
  const values = {};
  const problems = [];

  // setTimeout()'s ceiling. `server.requestTimeout` below is UPSTREAM_TIMEOUT_MS
  // plus this headroom, so the accepted maximum leaves room for the addition.
  const requestTimeoutHeadroomMs = 30000;
  const maxTimeoutMs = 2147483647 - requestTimeoutHeadroomMs;
  const headerValue = /^[\x20-\x7e]+$/;

  const read = (name) => {
    const raw = process.env[name];
    return typeof raw === "string" ? raw.trim() : undefined;
  };

  // Secrets are never echoed back; stderr ends up in container logs.
  const invalid = (name, expected, value, secret = false) => {
    if (value === undefined || value === "") {
      problems.push(`${name}: expected ${expected}, but it is not set`);
    } else if (secret) {
      problems.push(`${name}: expected ${expected} (the value received is not shown)`);
    } else {
      const shown = value.length > 64 ? `${value.slice(0, 64)}…` : value;
      problems.push(`${name}: expected ${expected}, got ${JSON.stringify(shown)}`);
    }
  };

  const readText = (name, expected, { minLength = 1, secret = false, pattern = null } = {}) => {
    const value = read(name);
    const ok = typeof value === "string"
      && value.length >= minLength
      && !/[\u0000-\u001f\u007f]/.test(value)
      && (pattern === null || pattern.test(value));
    if (!ok) return invalid(name, expected, value, secret);
    values[name] = value;
  };

  // Strict: "0x10", "1e3" and "12abc" are rejected rather than silently coerced.
  const readInteger = (name, expected, { min, max = Number.MAX_SAFE_INTEGER }) => {
    const value = read(name);
    if (typeof value !== "string" || !/^-?\d+$/.test(value)) return invalid(name, expected, value);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return invalid(name, expected, value);
    values[name] = parsed;
  };

  const readBoolean = (name, meaning) => {
    const value = read(name);
    if (value !== "true" && value !== "false") {
      return invalid(name, `exactly "true" or "false" (${meaning})`, value);
    }
    values[name] = value === "true";
  };

  const readUrl = (name, expected) => {
    const value = read(name);
    let parsed = null;
    if (value) {
      try {
        parsed = new URL(value);
      } catch {
        parsed = null;
      }
    }
    // Anything but http:/https: would silently fall through to the https agent.
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return invalid(name, expected, value);
    }
    values[name] = parsed;
  };

  readText("HOST", "a bind address with no spaces, such as 127.0.0.1 or 0.0.0.0", { pattern: /^\S+$/ });
  readInteger("PORT", "an integer between 1 and 65535", { min: 1, max: 65535 });
  readUrl("ANYROUTER_BASE_URL", "an absolute http:// or https:// URL");
  readText("ANYROUTER_API_KEY", "the upstream gateway key, at least 8 characters", { minLength: 8, secret: true, pattern: headerValue });
  readText("LOCAL_PROXY_KEY", "a shared secret of at least 16 characters (generate one with: openssl rand -hex 32)", { minLength: 16, secret: true, pattern: headerValue });
  readText("CLAUDE_CODE_VERSION", "a version string such as 2.1.197", { pattern: headerValue });
  readText("ANYROUTER_MODEL", "a model id such as claude-opus-4-8");
  readInteger("UPSTREAM_TIMEOUT_MS", `an integer between 1 and ${maxTimeoutMs} (milliseconds)`, { min: 1, max: maxTimeoutMs });
  readInteger("RETRY_AFTER_SECONDS", "an integer of at least 1 (seconds)", { min: 1 });
  readInteger("MAX_BODY_BYTES", "an integer of at least 1048576 (1 MiB)", { min: 1024 * 1024 });
  readText("ANYROUTER_WIRE_OS", "an x-stainless-os value such as MacOS", { pattern: headerValue });
  readText("ANYROUTER_WIRE_ARCH", "an x-stainless-arch value such as arm64", { pattern: headerValue });
  readText("ANYROUTER_STAINLESS_VERSION", "an x-stainless-package-version value such as 0.94.0", { pattern: headerValue });
  readInteger("RESPONSES_STORE_MAX", "an integer of at least 1", { min: 1 });
  readBoolean("PROXY_LOG", "console request logging");
  readBoolean("PROXY_LOG_VERBOSE", "header and body dumps in the console log");
  readInteger("PROXY_LOG_BODY_LIMIT", "an integer of at least 0 (characters; 0 truncates every logged body to nothing)", { min: 0 });
  readText("PROXY_TRACE_FILE", "a file path for the request trace, such as /tmp/anyrouter-trace.log");
  readBoolean("PROXY_TRACE", "the verbatim request and response file trace");
  readInteger("PROXY_TRACE_BODY_LIMIT", "an integer of at least 0 (characters; 0 means no truncation)", { min: 0 });

  if (problems.length > 0) {
    const report = [
      `Any Router Local Proxy cannot start: ${problems.length} environment variable problem${problems.length === 1 ? "" : "s"}.`,
      "Every variable is required and none of them has a default value.",
      ...problems.map((problem) => `  - ${problem}`),
      "Set every variable listed above and start the proxy again.",
      ""
    ].join("\n");
    // Written synchronously: process.exit() can truncate a piped stderr write.
    try {
      fs.writeSync(2, report);
    } catch {
      console.error(report);
    }
    process.exit(1);
  }

  return Object.freeze(values);
})();

const host = config.HOST;
const port = config.PORT;
const proxyVersion = "2.1.0";
const nodeRuntimeVersion = process.version;
const upstreamBaseUrl = config.ANYROUTER_BASE_URL;
const apiKey = config.ANYROUTER_API_KEY;
const localProxyKey = config.LOCAL_PROXY_KEY;
const claudeCodeVersion = config.CLAUDE_CODE_VERSION;
const defaultModel = config.ANYROUTER_MODEL;
const upstreamTimeoutMs = config.UPSTREAM_TIMEOUT_MS;
const retryAfterSeconds = config.RETRY_AFTER_SECONDS;
const maxBodyBytes = config.MAX_BODY_BYTES;
const compatibilityOs = config.ANYROUTER_WIRE_OS;
const compatibilityArch = config.ANYROUTER_WIRE_ARCH;
const packageVersion = config.ANYROUTER_STAINLESS_VERSION;
const responsesStoreMax = config.RESPONSES_STORE_MAX;

const supportedModels = [
  ["claude-opus-4-8", "Claude Opus 4.8 via Any Router"],
  ["claude-opus-4-7", "Claude Opus 4.7 via Any Router"],
  ["claude-opus-4-6", "Claude Opus 4.6 via Any Router"],
  ["glm-5.2", "GLM 5.2 via Any Router"],
  ["gpt-5.5", "GPT 5.5 via Any Router"]
];

const requiredBetas = [
  "claude-code-20250219",
  "context-1m-2025-08-07",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advisor-tool-2026-03-01",
  "effort-2025-11-24",
  "web-search-2025-03-05"
];

const permanentErrorPatterns = [
  "unauthorized_client_error",
  "not authorized to access",
  "not authorised to access",
  "model not found",
  "invalid model",
  "unknown model",
  "model does not exist",
  "invalid_api_key",
  "invalid api key",
  "invalid token",
  "authentication failed",
  "authentication error",
  "content-blocked",
  "content blocked",
  "moderation",
  "request too large",
  "payload too large",
  "context length",
  "context_length",
  "maximum context",
  "max_tokens",
  "无权访问模型",
  "无效的令牌"
];

const transientErrorPatterns = [
  "rate limit",
  "rate_limit",
  "rate-limit",
  "too many requests",
  "quota exceeded",
  "quota exhausted",
  "quota limit",
  "insufficient quota",
  "insufficient balance",
  "balance insufficient",
  "credit exhausted",
  "credits exhausted",
  "usage limit",
  "plan limit",
  "provider overloaded",
  "provider saturated",
  "provider busy",
  "server overloaded",
  "server busy",
  "capacity exceeded",
  "temporarily unavailable",
  "service unavailable",
  "gateway timeout",
  "upstream timeout",
  "downstream timeout",
  "timed out",
  "maintenance",
  "try again later",
  "retry later",
  "额度不足",
  "余额不足",
  "超出额度",
  "额度已用完",
  "配额不足",
  "频率限制",
  "请求过多",
  "限流"
];

const retryableServerStatuses = new Set([
  429, 500, 501, 502, 503, 504, 505, 510, 511,
  520, 521, 522, 523, 524, 525, 526, 527, 529, 530
]);
const convertedClientStatuses = new Set([400, 403, 408, 409]);
const neverConvertStatuses = new Set([401, 404, 413, 422]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const startedAt = Date.now();
const stats = {
  requests: 0,
  upstreamErrors: 0,
  normalizedTo429: 0,
  retryablePassed: 0,
  permanentPassed: 0,
  networkErrors: 0,
  droppedSseFrames: 0,
  emptyStreamsRecovered: 0,
  streamsClosedOnTerminalFrame: 0,
  authRejected: 0,
  responsesBridged: 0,
  responsesStored: 0,
  responsesStoreHits: 0,
  responsesStoreMisses: 0
};
const responseStore = new Map();

const logEnabled = config.PROXY_LOG;
const logVerbose = config.PROXY_LOG_VERBOSE;
// 0 is a meaningful setting here: every logged body is truncated to nothing.
const logBodyLimit = config.PROXY_LOG_BODY_LIMIT;

function redactSecrets(value) {
  let text = String(value ?? "");
  for (const secret of [apiKey, localProxyKey]) {
    if (secret && secret.length > 3) text = text.split(secret).join(`${secret.slice(0, 6)}…REDACTED`);
  }
  return text;
}

function truncate(value) {
  const text = redactSecrets(value).replace(/\s+/g, " ").trim();
  return text.length > logBodyLimit ? `${text.slice(0, logBodyLimit)}… (+${text.length - logBodyLimit} chars)` : text;
}

function log(requestId, direction, message) {
  if (!logEnabled) return;
  console.log(`[${new Date().toISOString()}] ${requestId.slice(0, 8)} ${direction} ${redactSecrets(message)}`);
}

// Full request/response trace to a file. Raw SSE chunks are recorded verbatim
// (newlines escaped) so stream framing problems are visible byte for byte.
const traceFile = config.PROXY_TRACE_FILE;
const traceEnabled = config.PROXY_TRACE;
// Note the asymmetry with logBodyLimit above: 0 here means no truncation.
const traceBodyLimit = config.PROXY_TRACE_BODY_LIMIT;

function traceInit() {
  if (!traceEnabled) return;
  try {
    fs.writeFileSync(traceFile, `# Any Router proxy trace started ${new Date().toISOString()}\n`);
    console.log(`Tracing every request and response to ${traceFile}`);
  } catch (error) {
    console.error(`Could not open trace file ${traceFile}: ${error.message}`);
  }
}

function trace(requestId, tag, value, { raw = false } = {}) {
  if (!traceEnabled) return;
  let text = typeof value === "string" ? value : JSON.stringify(value);
  text = redactSecrets(text);
  if (raw) {
    text = JSON.stringify(text);
  } else if (traceBodyLimit && text.length > traceBodyLimit) {
    text = `${text.slice(0, traceBodyLimit)}… (+${text.length - traceBodyLimit} chars)`;
  }
  try {
    fs.appendFileSync(traceFile, `[${new Date().toISOString()}] ${String(requestId).slice(0, 8)} ${tag} ${text}\n`);
  } catch {
    // Never let tracing break a live request.
  }
}

class HttpError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function clientToken(headers) {
  const authorization = String(headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer || headers["x-api-key"] || headers["api-key"] || "";
}

function isAuthorized(req) {
  return safeEqual(clientToken(req.headers), localProxyKey);
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...extraHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function clientErrorShape(requestUrl, type, message, code = undefined) {
  if (["/v1/chat/completions", "/v1/responses"].includes(requestUrl?.pathname)) {
    return { error: { message, type, ...(code ? { code } : {}) } };
  }
  return { type: "error", error: { type, message } };
}

function sendHttpError(res, requestUrl, error) {
  if (res.headersSent) {
    res.destroy(error);
    return;
  }
  const status = error instanceof HttpError ? error.status : 502;
  const type = error instanceof HttpError ? error.type : "anyrouter_proxy_error";
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, status, clientErrorShape(requestUrl, type, message));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBodyBytes) {
        reject(new HttpError(413, "request_too_large", `Request body exceeds ${maxBodyBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function modelList() {
  const models = [...supportedModels];
  if (!models.some(([id]) => id === defaultModel)) {
    models.unshift([defaultModel, `${defaultModel} via Any Router`]);
  }
  return {
    object: "list",
    data: models.map(([id, displayName]) => ({
      id,
      object: "model",
      type: "model",
      display_name: displayName
    })),
    has_more: false,
    first_id: models[0][0],
    last_id: models[models.length - 1][0]
  };
}

function buildUpstreamPath(requestUrl, pathnameOverride = undefined) {
  let pathname = pathnameOverride || requestUrl.pathname;
  if (upstreamBaseUrl.pathname !== "/") {
    pathname = `${upstreamBaseUrl.pathname.replace(/\/$/, "")}${pathname}`;
  }
  const target = new URL(`${pathname}${requestUrl.search}`, upstreamBaseUrl);
  if (requestUrl.pathname === "/v1/messages" && !target.searchParams.has("beta")) {
    target.searchParams.set("beta", "true");
  }
  return `${target.pathname}${target.search}`;
}

function mergeBetaHeader(sourceValue) {
  const merged = new Set(requiredBetas);
  for (const part of String(sourceValue || "").split(",")) {
    const value = part.trim();
    if (value) merged.add(value);
  }
  return [...merged].join(",");
}

function sessionId(sourceHeaders) {
  const incoming = String(sourceHeaders["x-claude-code-session-id"] || "");
  return uuidPattern.test(incoming) ? incoming : crypto.randomUUID();
}

// Hop-by-hop headers plus the ones the proxy must own on the upstream request.
const requestHeadersProxyOwns = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "trailer", "te", "transfer-encoding", "upgrade",
  "host", "content-length", "accept-encoding",
  "authorization", "x-api-key", "api-key"
]);

// Wire-image values used only when the client did not send its own.
function wireImageDefaults() {
  return {
    "user-agent": `claude-cli/${claudeCodeVersion} (external, sdk-cli)`,
    "x-stainless-lang": "js",
    "x-stainless-package-version": packageVersion,
    "x-stainless-os": compatibilityOs,
    "x-stainless-arch": compatibilityArch,
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": nodeRuntimeVersion,
    "x-app": "cli",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  };
}

function safeUpstreamHeaders(sourceHeaders, bodyLength, wantsStream) {
  const headers = {};

  // Forward every client header except the ones the proxy has to control.
  for (const [name, value] of Object.entries(sourceHeaders)) {
    const key = name.toLowerCase();
    if (requestHeadersProxyOwns.has(key) || value === undefined) continue;
    headers[key] = value;
  }

  for (const [name, value] of Object.entries(wireImageDefaults())) {
    if (headers[name] === undefined) headers[name] = value;
  }

  headers["x-claude-code-session-id"] = sessionId(sourceHeaders);
  headers.authorization = `Bearer ${apiKey}`;
  headers["anthropic-beta"] = mergeBetaHeader(sourceHeaders["anthropic-beta"]);
  headers.accept = wantsStream ? "text/event-stream" : sourceHeaders.accept || "application/json";
  headers["accept-encoding"] = "identity";
  headers["content-length"] = bodyLength;
  return headers;
}

function requestUpstream(req, requestUrl, body, wantsStream, onResponse, pathnameOverride = undefined) {
  const transport = upstreamBaseUrl.protocol === "http:" ? http : https;
  const requestId = req._proxyRequestId || "--------";
  const upstreamPath = buildUpstreamPath(requestUrl, pathnameOverride);
  const upstreamHeaders = safeUpstreamHeaders(req.headers, body.length, wantsStream);
  const startedRequestAt = Date.now();

  log(requestId, "->UP", `${req.method} ${upstreamBaseUrl.origin}${upstreamPath} (${body.length} bytes, stream=${wantsStream})`);
  if (logVerbose) {
    log(requestId, "->UP", `headers ${JSON.stringify(upstreamHeaders)}`);
    log(requestId, "->UP", `body ${truncate(body.toString("utf8"))}`);
  }
  trace(requestId, "UPSTREAM-REQ", `${req.method} ${upstreamBaseUrl.origin}${upstreamPath} stream=${wantsStream}`);
  trace(requestId, "UPSTREAM-REQ-HEADERS", upstreamHeaders);
  trace(requestId, "UPSTREAM-REQ-BODY", body.toString("utf8"));

  const upstream = transport.request(
    {
      protocol: upstreamBaseUrl.protocol,
      hostname: upstreamBaseUrl.hostname,
      port: upstreamBaseUrl.port || undefined,
      path: upstreamPath,
      method: req.method,
      headers: upstreamHeaders,
      agent: upstreamBaseUrl.protocol === "http:" ? httpAgent : httpsAgent,
      timeout: upstreamTimeoutMs
    },
    (upstreamRes) => {
      log(
        requestId,
        "<-UP",
        `${upstreamRes.statusCode} ${String(upstreamRes.headers["content-type"] || "?")} in ${Date.now() - startedRequestAt}ms`
      );
      trace(requestId, "UPSTREAM-RES", `${upstreamRes.statusCode} in ${Date.now() - startedRequestAt}ms`);
      trace(requestId, "UPSTREAM-RES-HEADERS", upstreamRes.headers);

      // Passive tap. Attached in the same tick as the real consumer below, so
      // no data is lost, and recorded raw to expose SSE framing exactly.
      if (traceEnabled) {
        let chunkIndex = 0;
        upstreamRes.on("data", (chunk) => {
          trace(requestId, `UPSTREAM-CHUNK[${chunkIndex++}]`, chunk.toString("utf8"), { raw: true });
        });
        upstreamRes.on("end", () => trace(requestId, "UPSTREAM-END", `after ${chunkIndex} chunks`));
        upstreamRes.on("error", (error) => trace(requestId, "UPSTREAM-ERR", error.message));
      }

      onResponse(upstreamRes);
    }
  );

  upstream.on("timeout", () => upstream.destroy(new Error("Any Router request timed out.")));
  upstream.on("error", (error) => {
    log(requestId, "<-UP", `network error: ${error.message}`);
    trace(requestId, "UPSTREAM-NETERR", error.message);
  });
  req.once("aborted", () => {
    trace(requestId, "CLIENT-ABORTED", "client closed the connection");
    upstream.destroy(new Error("Client aborted request."));
  });
  upstream.end(body);
  return upstream;
}

function stripHopByHopHeaders(source) {
  const headers = { ...source };
  for (const name of [
    "connection", "content-length", "transfer-encoding", "keep-alive",
    "proxy-authenticate", "proxy-authorization", "proxy-connection",
    "trailer", "te", "upgrade"
  ]) {
    delete headers[name];
  }
  return headers;
}

function sseFrameData(frame) {
  return frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function shouldDropSseFrame(frame) {
  const eventName = frame
    .split(/\r?\n/)
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim() || "";
  const data = sseFrameData(frame);

  if (!data || data === "[DONE]") return false;
  try {
    const payload = JSON.parse(data);
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return true;
    }
    const shape = String(payload.object || payload.type || eventName)
      .toLowerCase()
      .replaceAll(".", "")
      .replaceAll("_", "")
      .replaceAll("-", "");
    return shape === "billingsummary";
  } catch {
    return false;
  }
}


function sseErrorInfo(frame) {
  const data = sseFrameData(frame);
  if (!data || data === "[DONE]") return null;
  try {
    const payload = JSON.parse(data);
    if (!payload || typeof payload !== "object" || !payload.error) return null;
    const error = payload.error;
    const type = String(error.type || payload.type || "").toLowerCase();
    const message = String(error.message || "");
    const text = `${type} ${message}`.toLowerCase();
    if (type.includes("rate_limit") || transientErrorPatterns.some((pattern) => text.includes(pattern))) {
      return { status: type.includes("rate_limit") ? 429 : 503, message: message || "Any Router returned a transient SSE error." };
    }
    if (type.includes("overloaded") || type.includes("unavailable")) {
      return { status: 503, message: message || "Any Router is temporarily unavailable." };
    }
  } catch {
    return null;
  }
  return null;
}

function isMeaningfulSseFrame(frame) {
  const data = sseFrameData(frame);
  return Boolean(data && data !== "[DONE]" && !shouldDropSseFrame(frame));
}

function parseSseEvents(buffer, onEvent) {
  while (true) {
    const separator = buffer.match(/\r?\n\r?\n/);
    if (!separator || separator.index === undefined) return buffer;
    const frame = buffer.slice(0, separator.index);
    buffer = buffer.slice(separator.index + separator[0].length);
    if (shouldDropSseFrame(frame)) {
      stats.droppedSseFrames += 1;
      continue;
    }

    let event = "message";
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join("\n");
    if (data && data !== "[DONE]") onEvent(event, data);
  }
}

function collectResponseBody(upstreamRes, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    upstreamRes.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size <= limit) chunks.push(buffer);
    });
    upstreamRes.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    upstreamRes.on("error", reject);
  });
}

function errorClassification(status, bodyText) {
  const text = String(bodyText || "").toLowerCase();
  const permanentMatch = permanentErrorPatterns.some((pattern) => text.includes(pattern));
  const transientMatch = transientErrorPatterns.some((pattern) => text.includes(pattern));

  if (neverConvertStatuses.has(status) || permanentMatch) {
    return { kind: "permanent", reason: permanentMatch ? "permanent-pattern" : `status-${status}` };
  }
  if (status === 429 || retryableServerStatuses.has(status)) {
    return { kind: "retryable", reason: `status-${status}` };
  }
  if (convertedClientStatuses.has(status) && transientMatch) {
    return { kind: "convert", reason: "transient-pattern" };
  }
  if (status === 408) {
    return { kind: "convert", reason: "request-timeout" };
  }
  return { kind: "permanent", reason: "unrecognized-client-error" };
}

function retryAfterFrom(headers) {
  const raw = headers?.["retry-after"];
  if (raw !== undefined && String(raw).trim()) return String(raw);
  return String(retryAfterSeconds);
}

function looksLikeJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function sendRetryableProxyError(res, requestUrl, status, message, extraHeaders = {}) {
  if (res.headersSent) {
    res.destroy(new Error(message));
    return;
  }
  const type = status === 429 ? "rate_limit_error" : "api_error";
  const code = status === 429 ? "rate_limit_exceeded" : "upstream_unavailable";
  sendJson(
    res,
    status,
    clientErrorShape(requestUrl, type, message, code),
    {
      "retry-after": String(retryAfterSeconds),
      "cache-control": "no-store",
      ...extraHeaders
    }
  );
}

function sendUpstreamError(res, requestUrl, upstreamRes, bodyText) {
  const status = upstreamRes.statusCode || 502;
  const classification = errorClassification(status, bodyText);
  stats.upstreamErrors += 1;
  log("upstream ", "<-UP", `error ${status} [${classification.kind}/${classification.reason}] ${truncate(bodyText)}`);

  if (classification.kind === "convert") {
    stats.normalizedTo429 += 1;
    sendJson(
      res,
      429,
      clientErrorShape(
        requestUrl,
        "rate_limit_error",
        `Any Router returned a transient ${status}; normalized to 429 so the client can retry.`,
        "rate_limit_exceeded"
      ),
      {
        "retry-after": retryAfterFrom(upstreamRes.headers),
        "cache-control": "no-store",
        "x-anyrouter-proxy-original-status": String(status),
        "x-anyrouter-proxy-classification": classification.reason
      }
    );
    return;
  }

  const headers = stripHopByHopHeaders(upstreamRes.headers);
  headers["cache-control"] = "no-store";
  headers["x-anyrouter-proxy-classification"] = classification.reason;

  if (classification.kind === "retryable") {
    stats.retryablePassed += 1;
    headers["retry-after"] = retryAfterFrom(upstreamRes.headers);
    if (!looksLikeJson(bodyText)) {
      sendJson(
        res,
        status,
        clientErrorShape(requestUrl, status === 429 ? "rate_limit_error" : "api_error", `Any Router returned retryable HTTP ${status}.`),
        headers
      );
      return;
    }
  } else {
    stats.permanentPassed += 1;
  }

  const body = bodyText || JSON.stringify(clientErrorShape(requestUrl, "api_error", `Any Router returned HTTP ${status}.`));
  headers["content-length"] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(body);
}

function applyAnthropicSsePayload(state, payload) {
  switch (payload.type) {
    case "message_start":
      state.message = payload.message;
      state.seenUsefulEvent = true;
      break;
    case "content_block_start":
      state.blocks[payload.index] = payload.content_block || { type: "text", text: "" };
      state.seenUsefulEvent = true;
      break;
    case "content_block_delta": {
      const block = state.blocks[payload.index] || { type: "text", text: "" };
      const delta = payload.delta || {};
      if (delta.type === "text_delta") {
        block.type = "text";
        block.text = `${block.text || ""}${delta.text || ""}`;
      } else if (delta.type === "thinking_delta") {
        block.type = "thinking";
        block.thinking = `${block.thinking || ""}${delta.thinking || ""}`;
      } else if (delta.type === "signature_delta") {
        block.signature = delta.signature;
      } else if (delta.type === "input_json_delta") {
        block.partial_json = `${block.partial_json || ""}${delta.partial_json || ""}`;
      }
      state.blocks[payload.index] = block;
      state.seenUsefulEvent = true;
      break;
    }
    case "content_block_stop":
      finalizeBlock(state.blocks[payload.index]);
      break;
    case "message_delta":
      state.stopReason = payload.delta?.stop_reason || state.stopReason;
      state.stopSequence = payload.delta?.stop_sequence || state.stopSequence;
      state.usage = { ...state.usage, ...(payload.usage || {}) };
      state.seenUsefulEvent = true;
      break;
    case "error":
      state.error = payload.error || payload;
      break;
    default:
      break;
  }
}

function finalizeBlock(block) {
  if (!block || block.type !== "tool_use" || typeof block.partial_json !== "string") return block;
  const partial = block.partial_json;
  delete block.partial_json;
  if (!partial.trim()) {
    if (block.input === undefined) block.input = {};
    return block;
  }
  try {
    block.input = JSON.parse(partial);
  } catch {
    block.input = block.input ?? {};
    block._proxy_partial_json = partial;
  }
  return block;
}

function buildCollectedAnthropicMessage(state, requestedModel) {
  for (const block of state.blocks) finalizeBlock(block);
  const message = state.message || {};
  return {
    id: message.id || `msg_proxy_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: message.role || "assistant",
    model: message.model || requestedModel || defaultModel,
    content: state.blocks.filter(Boolean),
    stop_reason: state.stopReason || message.stop_reason || "end_turn",
    stop_sequence: state.stopSequence ?? message.stop_sequence ?? null,
    usage: { ...(message.usage || {}), ...(state.usage || {}) }
  };
}

// Terminal frames after which no further events can arrive. Gateways may hold
// the upstream socket open well past this point, so the client response is
// closed here rather than waiting for the connection to drop.
function isTerminalSseFrame(frame) {
  const data = sseFrameData(frame);
  if (data === "[DONE]") return true;
  if (!data) return false;
  try {
    const payload = JSON.parse(data);
    return payload?.type === "message_stop";
  } catch {
    return false;
  }
}

function filteredStreamingResponse(upstreamRes, res, requestUrl) {
  const responseHeaders = stripHopByHopHeaders(upstreamRes.headers);
  let buffer = "";
  let started = false;
  let sawMeaningfulFrame = false;
  let finishedEarly = false;
  let completed = false;
  upstreamRes.setEncoding("utf8");

  function startResponse() {
    if (started) return;
    started = true;
    res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
  }

  function handleFrame(frame) {
    if (finishedEarly || completed) return;
    if (!started) {
      const earlyError = sseErrorInfo(frame);
      if (earlyError) {
        finishedEarly = true;
        sendRetryableProxyError(res, requestUrl, earlyError.status, earlyError.message, {
          "x-anyrouter-proxy-classification": "sse-error-before-first-token"
        });
        upstreamRes.destroy();
        return;
      }
    }
    if (shouldDropSseFrame(frame)) {
      stats.droppedSseFrames += 1;
      return;
    }
    if (isMeaningfulSseFrame(frame)) sawMeaningfulFrame = true;
    if (!sawMeaningfulFrame && sseFrameData(frame) === "[DONE]") return;
    if (!sawMeaningfulFrame && !sseFrameData(frame)) return;

    // Gateways pad frames with extra newlines; re-emit exactly one separator so
    // the client always sees well-formed SSE, including on the final frame.
    const normalized = frame.replace(/^[\r\n]+/, "").replace(/[\r\n]+$/, "");
    if (!normalized) return;

    startResponse();
    res.write(`${normalized}\n\n`);

    if (isTerminalSseFrame(normalized)) {
      completed = true;
      stats.streamsClosedOnTerminalFrame += 1;
      res.end();
      upstreamRes.destroy();
    }
  }

  upstreamRes.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const separator = buffer.match(/\r?\n\r?\n/);
      if (!separator || separator.index === undefined) break;
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      handleFrame(frame);
    }
  });

  upstreamRes.on("end", () => {
    if (finishedEarly || completed) return;
    if (buffer) handleFrame(buffer);
    if (finishedEarly || completed) return;
    if (!sawMeaningfulFrame) {
      stats.emptyStreamsRecovered += 1;
      sendRetryableProxyError(res, requestUrl, 503, "Any Router returned an empty SSE stream. Retrying is safe.", {
        "x-anyrouter-proxy-classification": "empty-stream"
      });
      return;
    }
    if (!started) startResponse();
    res.end();
  });

  upstreamRes.on("error", (error) => {
    if (completed) return;
    stats.networkErrors += 1;
    if (!started) {
      sendRetryableProxyError(res, requestUrl, 503, `Any Router stream failed before first event: ${error.message}`);
    } else {
      res.destroy(error);
    }
  });
}

function collectAnthropicStreamingResponse(req, res, requestUrl, clientPayload) {
  const upstreamBody = Buffer.from(JSON.stringify({ ...clientPayload, stream: true }));
  const state = {
    message: null,
    blocks: [],
    usage: {},
    stopReason: null,
    stopSequence: null,
    error: null,
    seenUsefulEvent: false
  };
  let buffer = "";
  let errorBody = "";
  let finalized = false;

  const upstream = requestUpstream(req, requestUrl, upstreamBody, true, (upstreamRes) => {
    const status = upstreamRes.statusCode || 502;
    if (status >= 400) {
      collectResponseBody(upstreamRes)
        .then((bodyText) => sendUpstreamError(res, requestUrl, upstreamRes, bodyText))
        .catch((error) => sendNetworkError(res, requestUrl, error));
      return;
    }

    // Reply as soon as the message is complete. Waiting for the upstream socket
    // to close adds the gateway's full keep-alive idle timeout to every call.
    function finalize() {
      if (finalized) return;
      finalized = true;
      if (state.error) {
        const errorText = JSON.stringify(state.error).toLowerCase();
        const isRate = String(state.error.type || "").toLowerCase().includes("rate_limit");
        const isTransient = isRate || transientErrorPatterns.some((pattern) => errorText.includes(pattern));
        if (isTransient) {
          sendRetryableProxyError(res, requestUrl, isRate ? 429 : 503, state.error.message || "Any Router returned a transient SSE error.");
        } else {
          sendJson(res, 502, clientErrorShape(requestUrl, "api_error", state.error.message || "Any Router stream returned an error."));
        }
        return;
      }
      if (!state.seenUsefulEvent) {
        stats.emptyStreamsRecovered += 1;
        sendRetryableProxyError(res, requestUrl, 503, "Any Router returned an empty SSE stream while collecting a non-streaming response.");
        return;
      }
      sendJson(res, 200, buildCollectedAnthropicMessage(state, clientPayload.model));
    }

    upstreamRes.setEncoding("utf8");
    upstreamRes.on("data", (chunk) => {
      if (finalized) return;
      errorBody += chunk;
      if (errorBody.length > 2 * 1024 * 1024) errorBody = errorBody.slice(-2 * 1024 * 1024);
      buffer += chunk;
      buffer = parseSseEvents(buffer, (_event, data) => {
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          return; // Ignore non-JSON extensions; valid Anthropic events are still collected.
        }
        applyAnthropicSsePayload(state, payload);
        if (payload?.type === "message_stop") {
          stats.streamsClosedOnTerminalFrame += 1;
          finalize();
          upstreamRes.destroy();
        }
      });
    });
    upstreamRes.on("end", () => {
      if (finalized) return;
      if (buffer.trim()) {
        buffer = parseSseEvents(`${buffer}\n\n`, (_event, data) => {
          try {
            applyAnthropicSsePayload(state, JSON.parse(data));
          } catch {
            // Ignore non-JSON extensions.
          }
        });
      }
      finalize();
    });
    upstreamRes.on("error", (error) => {
      if (finalized) return;
      sendNetworkError(res, requestUrl, error);
    });
  });
  upstream.on("error", (error) => {
    if (finalized) return;
    sendNetworkError(res, requestUrl, error);
  });
}


function responseTextContent(content) {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) return String(content);
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (["input_text", "output_text", "text"].includes(part.type) && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    if (part.type === "refusal" && typeof part.refusal === "string") {
      parts.push(part.refusal);
    }
  }
  return parts.join("");
}

function responseContentToChat(content, role) {
  if (typeof content === "string" || content === null || content === undefined) {
    return content ?? "";
  }
  if (!Array.isArray(content)) return String(content);
  const chatParts = [];
  for (const part of content) {
    if (typeof part === "string") {
      chatParts.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (["input_text", "output_text", "text"].includes(part.type) && typeof part.text === "string") {
      chatParts.push({ type: "text", text: part.text });
      continue;
    }
    if (role === "user" && part.type === "input_image") {
      const url = part.image_url || part.url;
      if (typeof url === "string" && url) {
        chatParts.push({ type: "image_url", image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } });
        continue;
      }
    }
    if (part.type === "refusal" && typeof part.refusal === "string") {
      chatParts.push({ type: "text", text: part.refusal });
      continue;
    }
    throw new HttpError(400, "invalid_request_error", `Unsupported Responses content part type: ${String(part.type || "unknown")}.`);
  }
  if (!chatParts.length) return "";
  if (chatParts.every((part) => part.type === "text")) return chatParts.map((part) => part.text).join("");
  return chatParts;
}

function responseFunctionToolToChat(tool) {
  if (!tool || tool.type !== "function") {
    throw new HttpError(400, "invalid_request_error", `Responses tool type ${String(tool?.type || "unknown")} cannot be represented by Chat Completions.`);
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {})
    }
  };
}

function responseToolChoiceToChat(choice) {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return choice;
  if (!choice || typeof choice !== "object") return choice;
  if (choice.type === "function" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  throw new HttpError(400, "invalid_request_error", `Responses tool_choice type ${String(choice.type || "unknown")} cannot be represented by Chat Completions.`);
}

function responseTextFormatToChat(textConfig) {
  const format = textConfig?.format;
  if (!format) return undefined;
  if (format.type === "text") return { type: "text" };
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: format.name,
        ...(format.description !== undefined ? { description: format.description } : {}),
        schema: format.schema,
        ...(format.strict !== undefined ? { strict: format.strict } : {})
      }
    };
  }
  throw new HttpError(400, "invalid_request_error", `Responses text.format type ${String(format.type || "unknown")} cannot be represented by Chat Completions.`);
}

function responseItemToChatMessages(item) {
  if (!item || typeof item !== "object") {
    throw new HttpError(400, "invalid_request_error", "Responses input items must be objects.");
  }
  if (item.type === "function_call") {
    const callId = item.call_id || item.id || `call_${crypto.randomUUID().replaceAll("-", "")}`;
    return [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: callId,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})
        }
      }]
    }];
  }
  if (item.type === "function_call_output") {
    if (!item.call_id) throw new HttpError(400, "invalid_request_error", "function_call_output requires call_id.");
    return [{
      role: "tool",
      tool_call_id: item.call_id,
      content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "")
    }];
  }
  if (item.type && item.type !== "message") {
    if (item.type === "reasoning") return [];
    throw new HttpError(400, "invalid_request_error", `Responses input item type ${String(item.type)} cannot be represented by Chat Completions.`);
  }
  const role = item.role || "user";
  if (!["system", "developer", "user", "assistant"].includes(role)) {
    throw new HttpError(400, "invalid_request_error", `Unsupported Responses message role: ${String(role)}.`);
  }
  return [{ role, content: responseContentToChat(item.content, role) }];
}

function responseInputToChatMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new HttpError(400, "invalid_request_error", "Responses input must be a string or an array of Items.");
  }
  const messages = [];
  for (const item of input) messages.push(...responseItemToChatMessages(item));
  return messages;
}

function getStoredResponseContext(responseId) {
  const entry = responseStore.get(responseId);
  if (!entry) {
    stats.responsesStoreMisses += 1;
    throw new HttpError(400, "invalid_request_error", `Unknown or expired previous_response_id: ${responseId}.`);
  }
  stats.responsesStoreHits += 1;
  responseStore.delete(responseId);
  responseStore.set(responseId, entry);
  return structuredClone(entry.messages);
}

function storeResponseContext(responseId, messages) {
  responseStore.set(responseId, { messages: structuredClone(messages), storedAt: Date.now() });
  while (responseStore.size > responsesStoreMax) {
    responseStore.delete(responseStore.keys().next().value);
  }
  stats.responsesStored += 1;
}

function responsesRequestToChat(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "invalid_request_error", "Responses request body must be a JSON object.");
  }
  if (payload.background === true) {
    throw new HttpError(400, "invalid_request_error", "background mode cannot be represented by Chat Completions.");
  }
  if (payload.conversation !== undefined && payload.conversation !== null) {
    throw new HttpError(400, "invalid_request_error", "Responses conversation objects cannot be represented by Chat Completions.");
  }

  const priorMessages = payload.previous_response_id ? getStoredResponseContext(payload.previous_response_id) : [];
  const currentInputMessages = responseInputToChatMessages(payload.input);
  const contextMessages = [...priorMessages, ...currentInputMessages];
  if (!contextMessages.length) throw new HttpError(400, "invalid_request_error", "Responses request requires input or previous_response_id.");

  const messages = [];
  if (typeof payload.instructions === "string" && payload.instructions) {
    messages.push({ role: "system", content: payload.instructions });
  }
  messages.push(...contextMessages);

  const chat = {
    model: payload.model || defaultModel,
    messages,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (payload.max_output_tokens !== undefined) chat.max_tokens = payload.max_output_tokens;
  if (payload.temperature !== undefined) chat.temperature = payload.temperature;
  if (payload.top_p !== undefined) chat.top_p = payload.top_p;
  if (payload.parallel_tool_calls !== undefined) chat.parallel_tool_calls = payload.parallel_tool_calls;
  if (payload.reasoning?.effort !== undefined) chat.reasoning_effort = payload.reasoning.effort;
  if (payload.seed !== undefined) chat.seed = payload.seed;
  if (payload.user !== undefined) chat.user = payload.user;
  if (payload.stop !== undefined) chat.stop = payload.stop;
  if (payload.tools !== undefined) chat.tools = payload.tools.map(responseFunctionToolToChat);
  const toolChoice = responseToolChoiceToChat(payload.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  const responseFormat = responseTextFormatToChat(payload.text);
  if (responseFormat !== undefined) chat.response_format = responseFormat;
  return { chat, messages, contextMessages };
}

function newResponsesState(payload) {
  return {
    responseId: `resp_${crypto.randomUUID().replaceAll("-", "")}`,
    createdAt: Math.floor(Date.now() / 1000),
    completedAt: null,
    model: payload.model || defaultModel,
    payload,
    chatId: null,
    text: "",
    textItemId: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    textOutputIndex: null,
    textStarted: false,
    toolCalls: new Map(),
    outputOrder: [],
    nextOutputIndex: 0,
    finishReason: null,
    usage: null,
    sequence: 0
  };
}

function responsesUsage(chatUsage) {
  if (!chatUsage) return null;
  const input = Number(chatUsage.prompt_tokens ?? chatUsage.input_tokens ?? 0);
  const output = Number(chatUsage.completion_tokens ?? chatUsage.output_tokens ?? 0);
  const reasoning = Number(chatUsage.completion_tokens_details?.reasoning_tokens ?? chatUsage.output_tokens_details?.reasoning_tokens ?? 0);
  const cached = Number(chatUsage.prompt_tokens_details?.cached_tokens ?? chatUsage.input_tokens_details?.cached_tokens ?? 0);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: Number(chatUsage.total_tokens ?? input + output)
  };
}

function responsesOutputItems(state, status = "completed") {
  const items = [];
  for (const entry of [...state.outputOrder].sort((a, b) => a.outputIndex - b.outputIndex)) {
    if (entry.kind === "text") {
      items.push({
        id: state.textItemId,
        type: "message",
        status,
        role: "assistant",
        content: [{ type: "output_text", text: state.text, annotations: [], logprobs: [] }]
      });
    } else {
      const call = state.toolCalls.get(entry.chatIndex);
      if (!call) continue;
      items.push({
        id: call.itemId,
        type: "function_call",
        status,
        arguments: call.arguments,
        call_id: call.callId,
        name: call.name
      });
    }
  }
  return items;
}

function responseObject(state, status = "completed") {
  const payload = state.payload;
  const incomplete = state.finishReason === "length" || status === "incomplete";
  const effectiveStatus = incomplete ? "incomplete" : status;
  return {
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    completed_at: effectiveStatus === "completed" ? (state.completedAt || Math.floor(Date.now() / 1000)) : null,
    status: effectiveStatus,
    error: null,
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    instructions: payload.instructions ?? null,
    max_output_tokens: payload.max_output_tokens ?? null,
    model: state.model,
    output: effectiveStatus === "in_progress" ? [] : responsesOutputItems(state, "completed"),
    parallel_tool_calls: payload.parallel_tool_calls ?? true,
    previous_response_id: payload.previous_response_id ?? null,
    reasoning: {
      effort: payload.reasoning?.effort ?? null,
      summary: payload.reasoning?.summary ?? null
    },
    store: payload.store !== false,
    temperature: payload.temperature ?? 1,
    text: payload.text ?? { format: { type: "text" } },
    tool_choice: payload.tool_choice ?? "auto",
    tools: payload.tools ?? [],
    top_p: payload.top_p ?? 1,
    truncation: payload.truncation ?? "disabled",
    usage: effectiveStatus === "in_progress" ? null : responsesUsage(state.usage),
    user: payload.user ?? null,
    metadata: payload.metadata ?? {}
  };
}

function assistantChatMessageFromState(state) {
  const toolCalls = [...state.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.callId,
      type: "function",
      function: { name: call.name, arguments: call.arguments }
    }));
  return {
    role: "assistant",
    content: state.text || (toolCalls.length ? null : ""),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {})
  };
}

function applyChatChunkToResponsesState(state, chunk, callbacks = {}) {
  if (!chunk || typeof chunk !== "object") return;
  if (chunk.id) state.chatId = chunk.id;
  if (chunk.model) state.model = chunk.model;
  if (chunk.usage) state.usage = chunk.usage;
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice) return;
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
  const delta = choice.delta || {};
  if (typeof delta.content === "string" && delta.content) {
    if (!state.textStarted) {
      state.textStarted = true;
      state.textOutputIndex = state.nextOutputIndex++;
      state.outputOrder.push({ kind: "text", outputIndex: state.textOutputIndex });
      callbacks.onTextStart?.();
    }
    state.text += delta.content;
    callbacks.onTextDelta?.(delta.content);
  }
  for (const toolDelta of delta.tool_calls || []) {
    const chatIndex = Number(toolDelta.index ?? 0);
    let call = state.toolCalls.get(chatIndex);
    let isNew = false;
    if (!call) {
      isNew = true;
      call = {
        chatIndex,
        outputIndex: state.nextOutputIndex++,
        itemId: `fc_${crypto.randomUUID().replaceAll("-", "")}`,
        callId: toolDelta.id || `call_${crypto.randomUUID().replaceAll("-", "")}`,
        name: toolDelta.function?.name || "",
        arguments: ""
      };
      state.toolCalls.set(chatIndex, call);
      state.outputOrder.push({ kind: "tool", chatIndex, outputIndex: call.outputIndex });
      callbacks.onToolStart?.(call);
    }
    if (toolDelta.id) call.callId = toolDelta.id;
    if (!isNew && toolDelta.function?.name) call.name = `${call.name || ""}${toolDelta.function.name}`;
    const argsDelta = toolDelta.function?.arguments;
    if (typeof argsDelta === "string" && argsDelta) {
      call.arguments += argsDelta;
      callbacks.onToolDelta?.(call, argsDelta);
    }
  }
}

function parseChatSse(buffer, onChunk) {
  return parseSseEvents(buffer, (_event, data) => {
    try {
      const payload = JSON.parse(data);
      if (payload && typeof payload === "object" && !shouldDropSseFrame(`data: ${data}`)) onChunk(payload);
    } catch {
      // Ignore malformed vendor extension frames.
    }
  });
}

function writeResponsesEvent(res, state, type, fields = {}) {
  const event = { type, ...fields, sequence_number: ++state.sequence };
  res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function finishResponsesState(state, baseMessages) {
  state.completedAt = Math.floor(Date.now() / 1000);
  if (state.payload.store !== false) {
    storeResponseContext(state.responseId, [...baseMessages, assistantChatMessageFromState(state)]);
  }
}

function collectResponsesFromChat(req, res, requestUrl, payload, chatPayload, baseMessages) {
  const state = newResponsesState(payload);
  const body = Buffer.from(JSON.stringify(chatPayload));
  let buffer = "";
  const upstream = requestUpstream(req, requestUrl, body, true, (upstreamRes) => {
    const status = upstreamRes.statusCode || 502;
    if (status >= 400) {
      collectResponseBody(upstreamRes)
        .then((bodyText) => sendUpstreamError(res, requestUrl, upstreamRes, bodyText))
        .catch((error) => sendNetworkError(res, requestUrl, error));
      return;
    }
    const contentType = String(upstreamRes.headers["content-type"] || "");
    if (!contentType.includes("text/event-stream")) {
      collectResponseBody(upstreamRes).then((text) => {
        try {
          const completion = JSON.parse(text);
          state.chatId = completion.id || null;
          state.model = completion.model || state.model;
          state.usage = completion.usage || null;
          const choice = completion.choices?.[0] || {};
          state.finishReason = choice.finish_reason || "stop";
          const message = choice.message || {};
          if (typeof message.content === "string" && message.content) {
            applyChatChunkToResponsesState(state, { choices: [{ delta: { content: message.content } }] });
          }
          if (Array.isArray(message.tool_calls)) {
            applyChatChunkToResponsesState(state, { choices: [{ delta: { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } }] });
          }
          finishResponsesState(state, baseMessages);
          sendJson(res, 200, responseObject(state));
        } catch (error) {
          sendNetworkError(res, requestUrl, new Error(`Invalid Chat Completions JSON from Any Router: ${error.message}`));
        }
      }).catch((error) => sendNetworkError(res, requestUrl, error));
      return;
    }
    upstreamRes.setEncoding("utf8");
    upstreamRes.on("data", (chunk) => {
      buffer += chunk;
      buffer = parseChatSse(buffer, (payloadChunk) => applyChatChunkToResponsesState(state, payloadChunk));
    });
    upstreamRes.on("end", () => {
      if (buffer.trim()) buffer = parseChatSse(`${buffer}\n\n`, (payloadChunk) => applyChatChunkToResponsesState(state, payloadChunk));
      if (!state.textStarted && !state.toolCalls.size) {
        stats.emptyStreamsRecovered += 1;
        sendRetryableProxyError(res, requestUrl, 503, "Any Router returned an empty Chat Completions stream while bridging Responses.");
        return;
      }
      finishResponsesState(state, baseMessages);
      sendJson(res, 200, responseObject(state));
    });
    upstreamRes.on("error", (error) => sendNetworkError(res, requestUrl, error));
  }, "/v1/chat/completions");
  upstream.on("error", (error) => sendNetworkError(res, requestUrl, error));
}

function streamResponsesFromChat(req, res, requestUrl, payload, chatPayload, baseMessages) {
  const state = newResponsesState(payload);
  const body = Buffer.from(JSON.stringify(chatPayload));
  let buffer = "";
  let started = false;
  let finished = false;

  function start() {
    if (started) return;
    started = true;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive"
    });
    writeResponsesEvent(res, state, "response.created", { response: responseObject(state, "in_progress") });
    writeResponsesEvent(res, state, "response.in_progress", { response: responseObject(state, "in_progress") });
  }

  function onTextStart() {
    start();
    writeResponsesEvent(res, state, "response.output_item.added", {
      output_index: state.textOutputIndex,
      item: { id: state.textItemId, type: "message", status: "in_progress", role: "assistant", content: [] }
    });
    writeResponsesEvent(res, state, "response.content_part.added", {
      item_id: state.textItemId,
      output_index: state.textOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] }
    });
  }

  function onTextDelta(delta) {
    start();
    writeResponsesEvent(res, state, "response.output_text.delta", {
      item_id: state.textItemId,
      output_index: state.textOutputIndex,
      content_index: 0,
      delta,
      logprobs: []
    });
  }

  function onToolStart(call) {
    start();
    writeResponsesEvent(res, state, "response.output_item.added", {
      output_index: call.outputIndex,
      item: { id: call.itemId, type: "function_call", status: "in_progress", arguments: "", call_id: call.callId, name: call.name }
    });
  }

  function onToolDelta(call, delta) {
    start();
    writeResponsesEvent(res, state, "response.function_call_arguments.delta", {
      item_id: call.itemId,
      output_index: call.outputIndex,
      delta
    });
  }

  function complete() {
    if (finished) return;
    finished = true;
    if (!state.textStarted && !state.toolCalls.size) {
      if (!started) {
        stats.emptyStreamsRecovered += 1;
        sendRetryableProxyError(res, requestUrl, 503, "Any Router returned an empty Chat Completions stream while bridging Responses.");
      } else {
        res.end();
      }
      return;
    }
    start();
    if (state.textStarted) {
      writeResponsesEvent(res, state, "response.output_text.done", {
        item_id: state.textItemId,
        output_index: state.textOutputIndex,
        content_index: 0,
        text: state.text,
        logprobs: []
      });
      writeResponsesEvent(res, state, "response.content_part.done", {
        item_id: state.textItemId,
        output_index: state.textOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: state.text, annotations: [], logprobs: [] }
      });
      writeResponsesEvent(res, state, "response.output_item.done", {
        output_index: state.textOutputIndex,
        item: responsesOutputItems(state).find((item) => item.id === state.textItemId)
      });
    }
    for (const [, call] of [...state.toolCalls.entries()].sort(([a], [b]) => a - b)) {
      writeResponsesEvent(res, state, "response.function_call_arguments.done", {
        item_id: call.itemId,
        output_index: call.outputIndex,
        name: call.name,
        arguments: call.arguments
      });
      writeResponsesEvent(res, state, "response.output_item.done", {
        output_index: call.outputIndex,
        item: responsesOutputItems(state).find((item) => item.id === call.itemId)
      });
    }
    finishResponsesState(state, baseMessages);
    const object = responseObject(state);
    writeResponsesEvent(res, state, object.status === "incomplete" ? "response.incomplete" : "response.completed", { response: object });
    res.end();
  }

  const upstream = requestUpstream(req, requestUrl, body, true, (upstreamRes) => {
    const status = upstreamRes.statusCode || 502;
    if (status >= 400) {
      collectResponseBody(upstreamRes)
        .then((bodyText) => sendUpstreamError(res, requestUrl, upstreamRes, bodyText))
        .catch((error) => sendNetworkError(res, requestUrl, error));
      return;
    }
    const contentType = String(upstreamRes.headers["content-type"] || "");
    if (!contentType.includes("text/event-stream")) {
      collectResponseBody(upstreamRes).then((text) => {
        try {
          const completion = JSON.parse(text);
          state.model = completion.model || state.model;
          state.usage = completion.usage || null;
          const choice = completion.choices?.[0] || {};
          state.finishReason = choice.finish_reason || "stop";
          const message = choice.message || {};
          if (typeof message.content === "string" && message.content) {
            applyChatChunkToResponsesState(state, { choices: [{ delta: { content: message.content } }] }, { onTextStart, onTextDelta });
          }
          if (Array.isArray(message.tool_calls)) {
            applyChatChunkToResponsesState(state, { choices: [{ delta: { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } }] }, { onToolStart, onToolDelta });
          }
          complete();
        } catch (error) {
          if (!started) sendNetworkError(res, requestUrl, new Error(`Invalid Chat Completions JSON from Any Router: ${error.message}`));
          else res.destroy(error);
        }
      }).catch((error) => started ? res.destroy(error) : sendNetworkError(res, requestUrl, error));
      return;
    }
    upstreamRes.setEncoding("utf8");
    upstreamRes.on("data", (chunk) => {
      buffer += chunk;
      buffer = parseChatSse(buffer, (payloadChunk) => applyChatChunkToResponsesState(state, payloadChunk, { onTextStart, onTextDelta, onToolStart, onToolDelta }));
    });
    upstreamRes.on("end", () => {
      if (buffer.trim()) buffer = parseChatSse(`${buffer}\n\n`, (payloadChunk) => applyChatChunkToResponsesState(state, payloadChunk, { onTextStart, onTextDelta, onToolStart, onToolDelta }));
      complete();
    });
    upstreamRes.on("error", (error) => {
      if (!started) sendNetworkError(res, requestUrl, error);
      else res.destroy(error);
    });
  }, "/v1/chat/completions");
  upstream.on("error", (error) => {
    if (!started) sendNetworkError(res, requestUrl, error);
    else res.destroy(error);
  });
}

function handleResponsesRequest(req, res, requestUrl, payload) {
  const { chat, contextMessages } = responsesRequestToChat(payload);
  stats.responsesBridged += 1;
  if (payload.stream === true) {
    streamResponsesFromChat(req, res, requestUrl, payload, chat, contextMessages);
  } else {
    collectResponsesFromChat(req, res, requestUrl, payload, chat, contextMessages);
  }
}

function sendNetworkError(res, requestUrl, error) {
  stats.networkErrors += 1;
  const message = error instanceof Error ? error.message : String(error);
  sendRetryableProxyError(res, requestUrl, 503, `Any Router connection error: ${message}`);
}

function pipeRequest(req, res, requestUrl, body, wantsStream) {
  const upstream = requestUpstream(req, requestUrl, body, wantsStream, (upstreamRes) => {
    const status = upstreamRes.statusCode || 502;
    if (status >= 400) {
      collectResponseBody(upstreamRes)
        .then((bodyText) => sendUpstreamError(res, requestUrl, upstreamRes, bodyText))
        .catch((error) => sendNetworkError(res, requestUrl, error));
      return;
    }

    if (wantsStream || String(upstreamRes.headers["content-type"] || "").includes("text/event-stream")) {
      filteredStreamingResponse(upstreamRes, res, requestUrl);
      return;
    }

    res.writeHead(status, stripHopByHopHeaders(upstreamRes.headers));
    upstreamRes.pipe(res);
    upstreamRes.on("error", (error) => res.destroy(error));
  });
  upstream.on("error", (error) => sendNetworkError(res, requestUrl, error));
}

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  req._proxyRequestId = requestId;
  stats.requests += 1;
  res.setHeader("x-anyrouter-proxy-version", proxyVersion);
  res.setHeader("x-anyrouter-proxy-request-id", requestId);

  res.once("finish", () => log(requestId, "<-CL", `${res.statusCode}`));

  // Record every byte the proxy sends back to the client, so a stream that
  // never terminates is visible in the trace as a missing frame separator.
  if (traceEnabled && req.url !== "/health") {
    const originalWriteHead = res.writeHead.bind(res);
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    let outIndex = 0;

    res.writeHead = (status, ...rest) => {
      const headerArg = rest.find((value) => value && typeof value === "object");
      trace(requestId, "CLIENT-RES", `${status}`);
      trace(requestId, "CLIENT-RES-HEADERS", { ...res.getHeaders(), ...(headerArg || {}) });
      return originalWriteHead(status, ...rest);
    };
    res.write = (chunk, ...rest) => {
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
        trace(requestId, `CLIENT-CHUNK[${outIndex++}]`, chunk.toString("utf8"), { raw: true });
      }
      return originalWrite(chunk, ...rest);
    };
    res.end = (chunk, ...rest) => {
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
        trace(requestId, "CLIENT-END-CHUNK", chunk.toString("utf8"), { raw: true });
      }
      trace(requestId, "CLIENT-END", `status=${res.statusCode} after ${outIndex} chunks`);
      return originalEnd(chunk, ...rest);
    };
  }

  let requestUrl;
  try {
    requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);

    if (requestUrl.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        version: proxyVersion,
        node: nodeRuntimeVersion,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        upstream: upstreamBaseUrl.origin,
        stats: { ...stats }
      });
      return;
    }

    log(requestId, "->CL", `${req.method} ${requestUrl.pathname} auth=${clientToken(req.headers) ? "present" : "MISSING"}`);
    if (logVerbose) log(requestId, "->CL", `headers ${JSON.stringify(req.headers)}`);
    trace(requestId, "CLIENT-REQ", `${req.method} ${req.url}`);
    trace(requestId, "CLIENT-REQ-HEADERS", req.headers);

    if (requestUrl.pathname.startsWith("/v1/") && !isAuthorized(req)) {
      stats.authRejected += 1;
      log(requestId, "->CL", "rejected: local proxy key mismatch");
      sendJson(res, 401, clientErrorShape(requestUrl, "authentication_error", "Invalid local proxy API key."), {
        "www-authenticate": "Bearer"
      });
      return;
    }

    if (requestUrl.pathname === "/v1/models" && req.method === "GET") {
      sendJson(res, 200, modelList());
      return;
    }

    const allowedPaths = new Set([
      "/v1/messages",
      "/v1/messages/count_tokens",
      "/v1/chat/completions",
      "/v1/responses"
    ]);
    if (req.method !== "POST" || !allowedPaths.has(requestUrl.pathname)) {
      sendJson(res, 404, clientErrorShape(
        requestUrl,
        "not_found",
        "Supported endpoints: POST /v1/messages, POST /v1/messages/count_tokens, POST /v1/chat/completions, POST /v1/responses, GET /v1/models, GET /health."
      ));
      return;
    }

    const body = await readBody(req);
    trace(requestId, "CLIENT-REQ-BODY", body.toString("utf8"));
    let payload;
    try {
      payload = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      throw new HttpError(400, "invalid_request_error", "Request body must be valid JSON.");
    }
    const wantsStream = payload.stream === true;
    trace(requestId, "ROUTE", `${requestUrl.pathname} model=${payload.model || "?"} stream=${wantsStream}`);

    if (requestUrl.pathname === "/v1/responses") {
      handleResponsesRequest(req, res, requestUrl, payload);
    } else if (requestUrl.pathname === "/v1/messages" && !wantsStream) {
      collectAnthropicStreamingResponse(req, res, requestUrl, payload);
    } else {
      pipeRequest(req, res, requestUrl, body, wantsStream);
    }
  } catch (error) {
    sendHttpError(res, requestUrl, error);
  }
});

server.requestTimeout = upstreamTimeoutMs + 30000;
server.headersTimeout = 65000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 1000;

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down Any Router Local Proxy v${proxyVersion}.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(port, host, () => {
  console.log(`Any Router Local Proxy v${proxyVersion} listening on http://${host}:${port} with ${nodeRuntimeVersion}`);
  traceInit();
});
