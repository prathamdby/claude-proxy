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

  const parseHttpUrl = (value) => {
    let parsed = null;
    if (value) {
      try {
        parsed = new URL(value);
      } catch {
        parsed = null;
      }
    }
    // Anything but http:/https: would silently fall through to the https agent.
    return parsed && (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed : null;
  };

  const readUpstreamsFile = () => {
    const name = "UPSTREAMS_FILE";
    const expected = "a readable regular JSON file containing at least one upstream";
    const filePath = read(name);
    if (!filePath) return invalid(name, expected, filePath);

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      problems.push(`${name}: expected ${expected}, but ${JSON.stringify(filePath)} cannot be read: ${error.message}`);
      return;
    }
    if (!stat.isFile()) {
      problems.push(`${name}: expected ${expected}, but ${JSON.stringify(filePath)} is not a regular file`);
      return;
    }

    let contents;
    try {
      contents = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      problems.push(`${name}: expected ${expected}, but ${JSON.stringify(filePath)} cannot be read: ${error.message}`);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      problems.push(`${name}: expected valid JSON, but ${JSON.stringify(filePath)} could not be parsed: ${error.message}`);
      return;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      problems.push(`${name}: expected a non-empty JSON array of upstreams`);
      return;
    }

    const seenNames = new Set();
    const upstreams = [];
    for (let index = 0; index < parsed.length; index += 1) {
      const entry = parsed[index];
      const prefix = `${name}[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        problems.push(`${prefix}: expected an object with exactly name, base_url and api_key`);
        continue;
      }
      const keys = Object.keys(entry).sort();
      if (keys.join(",") !== "api_key,base_url,name") {
        problems.push(`${prefix}: expected exactly the keys name, base_url and api_key`);
        continue;
      }

      const upstreamName = typeof entry.name === "string" ? entry.name.trim() : undefined;
      let validName = true;
      // Names are written to x-proxy-upstream; Node rejects header values outside
      // printable ASCII, so the same headerValue floor used for api_key applies.
      if (!upstreamName || !headerValue.test(upstreamName)) {
        invalid(`${prefix}.name`, "a non-empty printable ASCII name", upstreamName);
        validName = false;
      } else if (seenNames.has(upstreamName)) {
        problems.push(`${prefix}.name: expected a unique name, but ${JSON.stringify(upstreamName)} is duplicated`);
        validName = false;
      } else {
        seenNames.add(upstreamName);
      }

      const baseUrl = typeof entry.base_url === "string" ? parseHttpUrl(entry.base_url.trim()) : null;
      if (!baseUrl) invalid(`${prefix}.base_url`, "an absolute http:// or https:// URL", entry.base_url);

      const apiKey = typeof entry.api_key === "string" ? entry.api_key : undefined;
      const validApiKey = typeof apiKey === "string"
        && apiKey.length >= 8
        && !/[\u0000-\u001f\u007f]/.test(apiKey)
        && headerValue.test(apiKey);
      if (!validApiKey) invalid(`${prefix}.api_key`, "at least 8 printable ASCII characters", apiKey, true);

      if (validName && upstreamName && baseUrl && validApiKey) upstreams.push({ name: upstreamName, baseUrl, apiKey });
    }
    if (upstreams.length === parsed.length) values.UPSTREAMS = upstreams;
  };

  // The operator fills this in by copying the host out of the ANTHROPIC_BASE_URL
  // they point Claude Code at, so every form that URL can take is accepted: a
  // bare hostname, host:port, a full URL, and an IPv6 literal with or without
  // brackets. Each entry is reduced to its hostname here — the scheme and port
  // are dropped because only the hostname is ever matched — so the comparison at
  // request time is a plain string equality against an already-normalised list.
  const readHostList = (name, expected) => {
    const value = read(name);
    if (!value) return invalid(name, expected, value);
    const hostnames = [];
    for (const entry of value.split(",")) {
      const item = entry.trim();
      if (!item) return invalid(name, expected, value);
      let parsed = null;
      try {
        parsed = item.includes("://") ? new URL(item) : new URL(`http://${item}`);
      } catch {
        // A bare IPv6 literal is only a legal authority once bracketed, so ::1
        // is retried as [::1] rather than reported as a typo.
        try {
          parsed = new URL(`http://[${item}]`);
        } catch {
          parsed = null;
        }
      }
      if (!parsed?.hostname) return invalid(name, expected, value);
      hostnames.push(parsed.hostname.toLowerCase());
    }
    values[name] = Object.freeze(hostnames);
  };

  readText("HOST", "a bind address with no spaces, such as 127.0.0.1 or 0.0.0.0", { pattern: /^\S+$/ });
  readInteger("PORT", "an integer between 1 and 65535", { min: 1, max: 65535 });
  readInteger("HEALTH_PORT", "an integer between 1 and 65535", { min: 1, max: 65535 });
  readHostList(
    "ALLOWED_HOSTS",
    "a comma-separated list of hosts this proxy answers to, such as 127.0.0.1,claude-proxy.203.0.113.10.nip.io"
  );
  readUpstreamsFile();
  // This key is the only thing standing between the public internet and a paid
  // upstream credential, so it has to be generated rather than chosen: a short
  // placeholder is a giveaway once the port is reachable from anywhere.
  readText(
    "LOCAL_PROXY_KEY",
    "at least 32 characters of shared secret for Claude Code to send back; generate one with: openssl rand -base64 32",
    { minLength: 32, secret: true, pattern: headerValue }
  );
  readText("CLAUDE_CODE_VERSION", "a version string such as 2.1.197", { pattern: headerValue });
  readInteger("UPSTREAM_TIMEOUT_MS", `an integer between 1 and ${maxTimeoutMs} (milliseconds)`, { min: 1, max: maxTimeoutMs });
  readInteger("UPSTREAM_COOLDOWN_MS", `an integer between 1 and ${maxTimeoutMs} (milliseconds)`, { min: 1, max: maxTimeoutMs });
  readInteger("RETRY_AFTER_SECONDS", "an integer of at least 1 (seconds)", { min: 1 });
  readInteger("MAX_BODY_BYTES", "an integer of at least 1048576 (1 MiB)", { min: 1024 * 1024 });
  readBoolean("PROXY_LOG", "console request logging");
  readBoolean("PROXY_LOG_VERBOSE", "header and body dumps in the console log");
  readInteger("PROXY_LOG_BODY_LIMIT", "an integer of at least 0 (characters; 0 truncates every logged body to nothing)", { min: 0 });
  readText("PROXY_TRACE_FILE", "a file path for the request trace, such as /tmp/proxy-trace.log");
  readBoolean("PROXY_TRACE", "the verbatim request and response file trace");
  readInteger("PROXY_TRACE_BODY_LIMIT", "an integer of at least 0 (characters; 0 means no truncation)", { min: 0 });

  // Relationships between variables, checked only once both sides actually
  // validated: an unset variable leaves `values[name]` undefined, so comparing
  // unconditionally would report the two ports (or the two keys) as identical
  // whenever neither is set, burying the two real "not set" problems under a
  // third that says something untrue.
  if (values.PORT !== undefined && values.HEALTH_PORT !== undefined && values.PORT === values.HEALTH_PORT) {
    problems.push(`HEALTH_PORT: expected a port of its own, but it is ${values.HEALTH_PORT}, the same port as PORT`);
  }
  // The whole point of the local key is that upstream credentials never leave
  // this process; reusing one as the client-facing key hands it out.
  if (values.LOCAL_PROXY_KEY !== undefined && values.UPSTREAMS !== undefined) {
    for (let index = 0; index < values.UPSTREAMS.length; index += 1) {
      if (values.LOCAL_PROXY_KEY === values.UPSTREAMS[index].apiKey) {
        problems.push(`UPSTREAMS_FILE[${index}].api_key: expected a secret different from LOCAL_PROXY_KEY (the value received is not shown)`);
      }
    }
  }

  if (problems.length > 0) {
    const report = [
      `Local API Proxy cannot start: ${problems.length} configuration problem${problems.length === 1 ? "" : "s"}.`,
      "Every setting is required and none of them has a default value.",
      ...problems.map((problem) => `  - ${problem}`),
      "Fix every setting listed above and start the proxy again.",
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
const healthPort = config.HEALTH_PORT;
const allowedHosts = config.ALLOWED_HOSTS;
const proxyVersion = "5.0.0";
const nodeRuntimeVersion = process.version;
const upstreams = config.UPSTREAMS.map(({ name, baseUrl, apiKey }) => ({
  name,
  baseUrl,
  apiKey,
  coolUntil: 0,
  requests: 0,
  failovers: 0
}));
const localProxyKey = config.LOCAL_PROXY_KEY;
const claudeCodeVersion = config.CLAUDE_CODE_VERSION;
const upstreamTimeoutMs = config.UPSTREAM_TIMEOUT_MS;
const cooldownMs = config.UPSTREAM_COOLDOWN_MS;
const retryAfterSeconds = config.RETRY_AFTER_SECONDS;
const maxBodyBytes = config.MAX_BODY_BYTES;
// Sorted once at startup: upstreams and LOCAL_PROXY_KEY never change after boot,
// and redactSecrets runs on every log line plus every traced SSE chunk.
const redactedSecrets = [
  ...upstreams.map((upstream) => [`UPSTREAM:${upstream.name}`, upstream.apiKey]),
  ["LOCAL_PROXY_KEY", localProxyKey]
].sort((left, right) => right[1].length - left[1].length);

function isClientAbort(error) {
  return Boolean(error && error.code === "PROXY_CLIENT_ABORT");
}

// Betas the gateway is asked for on top of whatever the client sent. Claude Code
// already sends most of these; context-1m-2025-08-07 and web-search-2025-03-05 are
// the two it does not, so this list is a floor rather than a replacement.
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
  failovers: 0,
  droppedSseFrames: 0,
  emptyStreamsRecovered: 0,
  streamsClosedOnTerminalFrame: 0,
  authRejected: 0,
  hostRejected: 0
};

const logEnabled = config.PROXY_LOG;
const logVerbose = config.PROXY_LOG_VERBOSE;
// 0 is a meaningful setting here: every logged body is truncated to nothing.
const logBodyLimit = config.PROXY_LOG_BODY_LIMIT;

function redactSecrets(value) {
  let text = String(value ?? "");
  // The marker names which secret matched but reveals none of it. A prefix would
  // put real key bytes into the console log and the trace file, which is the one
  // thing this function exists to keep out of them. The length floor is a safety
  // net: a pathologically short secret would otherwise match everywhere.
  for (const [name, secret] of redactedSecrets) {
    if (secret && secret.length > 3) text = text.split(secret).join(`[REDACTED:${name}]`);
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
    // The trace holds whole prompts and completions in plaintext, so it is owner
    // only. The mode passed here applies to a file being created; a trace left
    // behind by an earlier run keeps whatever permissions it already had, which
    // is what the explicit chmod is for.
    fs.writeFileSync(traceFile, `# Proxy trace started ${new Date().toISOString()}\n`, { mode: 0o600 });
    fs.chmodSync(traceFile, 0o600);
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

// Digests rather than the raw values: both buffers are then always 32 bytes, so
// the comparison can no longer be short-circuited on length and its timing says
// nothing about how long the real key is.
function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
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
  if (res.headersSent) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...extraHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

// Loopback names for the health listener below, deliberately hardcoded instead
// of read from ALLOWED_HOSTS: that setting exists so the operator can name the
// public hostname their reverse proxy uses, and nothing they put there should be
// able to widen an endpoint that is meant to be reachable from inside the
// container only. The IPv6 entry is bracketed because that is the form
// `new URL()` produces for an IPv6 authority, and matching happens on its output.
const loopbackHosts = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);

// The one definition of "a request this listener is willing to answer", shared
// by both servers so the public port and the health port cannot drift apart.
//
// Matching is on hostname alone. Under Docker the published port routinely
// differs from the port the server binds inside the container, so comparing
// host:port would reject every request that arrived through a remapped port
// while adding nothing: the port a request reached is already decided by which
// socket accepted it.
//
// Returns true when the request has been answered and the caller must stop.
function rejectedByHostGuard(req, res, allowedHostnames) {
  const hostHeader = req.headers.host;
  const origin = req.headers.origin;
  const secFetchSite = req.headers["sec-fetch-site"];
  let rejection = null;

  if (!hostHeader) {
    rejection = "no Host header";
  } else if (origin !== undefined) {
    // No CLI client sends either header and a browser always sends at least one,
    // so their presence means a page is driving the request. Refusing them is
    // what stops DNS rebinding: the attacker's page can point a name at this
    // address, but it cannot strip the headers the browser attaches.
    rejection = `browser Origin ${origin}`;
  } else if (secFetchSite !== undefined) {
    rejection = `browser Sec-Fetch-Site ${secFetchSite}`;
  } else {
    let hostname = null;
    try {
      // Parsed rather than split on ":": this is what makes [::1]:18989 and an
      // ordinary host:port both resolve correctly, and what collapses userinfo
      // smuggling such as 127.0.0.1@evil.com down to the hostname the request
      // will really be routed as. Garbage throws, and throwing is a rejection.
      hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
      hostname = null;
    }
    if (!hostname || !allowedHostnames.includes(hostname)) rejection = `Host ${hostHeader}`;
  }

  if (rejection === null) return false;

  stats.hostRejected += 1;
  // Logged but never echoed: the reply tells a prober nothing about which hosts
  // this proxy does answer to.
  log(req._proxyRequestId || "--------", "->CL", `rejected: ${rejection}`);
  sendJson(res, 403, {
    type: "error",
    error: { type: "forbidden", message: "This proxy does not serve requests for that host." }
  });
  return true;
}

// Every route the proxy serves, with its method, wire dialect and delivery flow.
// The 404 text is derived from the same table so the advertised endpoints cannot
// drift from the served ones, and a served path reached by the wrong method gets
// that same 404 rather than a 405: the reply says nothing about which half of the
// pair a prober guessed right.
const routes = new Map([
  ["/v1/messages",              { method: "POST", dialect: "anthropic", betaQuery: true,  flow: completeMessage }],
  ["/v1/messages/count_tokens", { method: "POST", dialect: "anthropic", betaQuery: false, flow: forwardChatRequest }],
  ["/v1/chat/completions",      { method: "POST", dialect: "openai",    betaQuery: false, flow: forwardChatRequest }],
  ["/v1/responses",             { method: "POST", dialect: "openai",    betaQuery: false, flow: forwardChatRequest }],
  ["/v1/models",                { method: "GET",  dialect: "openai",    betaQuery: false, flow: forwardModelCatalogue }]
]);
const servedRoutesMessage = `Supported endpoints: ${[...routes].map(([path, route]) => `${route.method} ${path}`).join(", ")}.`;

function clientErrorShape(requestUrl, type, message, code = undefined) {
  const dialect = routes.get(requestUrl?.pathname)?.dialect || "anthropic";
  if (dialect === "openai") {
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
  const type = error instanceof HttpError ? error.type : "proxy_error";
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

function buildUpstreamPath(requestUrl, upstream, dialect, betaQuery) {
  let pathname = requestUrl.pathname;
  if (upstream.baseUrl.pathname !== "/") {
    pathname = `${upstream.baseUrl.pathname.replace(/\/$/, "")}${pathname}`;
  }
  const target = new URL(`${pathname}${requestUrl.search}`, upstream.baseUrl);
  if (dialect === "anthropic" && betaQuery && !target.searchParams.has("beta")) {
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

// Connection-scoped headers: meaningful for one hop only, so they are dropped
// in both directions rather than copied onto the next connection.
const hopByHopHeaders = [
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "trailer", "te", "transfer-encoding", "upgrade"
];

// Hop-by-hop plus the ones the proxy must own on the upstream request.
const requestHeadersProxyOwns = new Set([
  ...hopByHopHeaders,
  "host", "content-length", "accept-encoding",
  "authorization", "x-api-key", "api-key"
]);

// Filled in only when the caller omitted them. Claude Code always sends its own,
// so in practice these serve exactly one caller: a bare `curl`, which needs the
// content-type and, on Anthropic paths, anthropic-version before the gateway
// will answer at all.
const bareClientDefaults = {
  "user-agent": `claude-cli/${claudeCodeVersion} (external, sdk-cli)`,
  "content-type": "application/json"
};

function safeUpstreamHeaders(sourceHeaders, bodyLength, wantsStream, upstream, dialect) {
  const headers = {};
  const omit = new Set(requestHeadersProxyOwns);
  if (dialect === "openai") {
    omit.add("anthropic-version");
    omit.add("anthropic-beta");
  }

  // Forward every client header except the ones the proxy has to control.
  for (const [name, value] of Object.entries(sourceHeaders)) {
    const key = name.toLowerCase();
    if (omit.has(key) || value === undefined) continue;
    headers[key] = value;
  }

  for (const [name, value] of Object.entries(bareClientDefaults)) {
    if (headers[name] === undefined) headers[name] = value;
  }

  headers["x-claude-code-session-id"] = sessionId(sourceHeaders);
  headers.authorization = `Bearer ${upstream.apiKey}`;
  if (dialect === "anthropic") {
    if (headers["anthropic-version"] === undefined) headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-beta"] = mergeBetaHeader(sourceHeaders["anthropic-beta"]);
  }
  headers.accept = wantsStream ? "text/event-stream" : sourceHeaders.accept || "application/json";
  headers["accept-encoding"] = "identity";
  headers["content-length"] = bodyLength;
  return headers;
}

function requestUpstream(req, requestUrl, body, wantsStream, route, upstream, onResponse) {
  const transport = upstream.baseUrl.protocol === "http:" ? http : https;
  const requestId = req._proxyRequestId || "--------";
  const upstreamPath = buildUpstreamPath(requestUrl, upstream, route.dialect, route.betaQuery);
  const upstreamHeaders = safeUpstreamHeaders(req.headers, body.length, wantsStream, upstream, route.dialect);
  const startedRequestAt = Date.now();

  log(requestId, "->UP", `${upstream.name} ${req.method} ${upstream.baseUrl.origin}${upstreamPath} (${body.length} bytes, stream=${wantsStream})`);
  if (logVerbose) {
    log(requestId, "->UP", `headers ${JSON.stringify(upstreamHeaders)}`);
    log(requestId, "->UP", `body ${truncate(body.toString("utf8"))}`);
  }
  trace(requestId, "UPSTREAM-REQ", `${upstream.name} ${req.method} ${upstream.baseUrl.origin}${upstreamPath} stream=${wantsStream}`);
  trace(requestId, "UPSTREAM-REQ-HEADERS", upstreamHeaders);
  trace(requestId, "UPSTREAM-REQ-BODY", body.toString("utf8"));

  const upstreamReq = transport.request(
    {
      protocol: upstream.baseUrl.protocol,
      hostname: upstream.baseUrl.hostname,
      port: upstream.baseUrl.port || undefined,
      path: upstreamPath,
      method: req.method,
      headers: upstreamHeaders,
      agent: upstream.baseUrl.protocol === "http:" ? httpAgent : httpsAgent,
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

  upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("Upstream request timed out.")));
  upstreamReq.on("error", (error) => {
    log(requestId, "<-UP", `network error: ${error.message}`);
    trace(requestId, "UPSTREAM-NETERR", error.message);
  });
  upstreamReq.end(body);
  return upstreamReq;
}

function stripHopByHopHeaders(source) {
  const headers = { ...source };
  // content-length goes too: the body is re-framed on the way out.
  for (const name of [...hopByHopHeaders, "content-length"]) delete headers[name];
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

const transientSseErrorMessage = "Upstream returned a transient SSE error.";

// One rule for an `error` event arriving inside a 200 SSE stream, shared by the
// pass-through path and the collecting path so the same gateway failure gets the
// same status whether or not the client asked for a stream. null means the error
// is the gateway's final word and must not be dressed up as retryable.
function sseErrorStatus(error, fallbackType = "") {
  const type = String(error?.type || fallbackType).toLowerCase();
  const text = `${type} ${String(error?.message || "")}`.toLowerCase();
  if (type.includes("rate_limit")) return 429;
  if (transientErrorPatterns.some((pattern) => text.includes(pattern))) return 503;
  if (type.includes("overloaded") || type.includes("unavailable")) return 503;
  return null;
}

function sseErrorInfo(frame) {
  const data = sseFrameData(frame);
  if (!data || data === "[DONE]") return null;
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!payload?.error) return null;
  const status = sseErrorStatus(payload.error, payload.type);
  return status ? { status, message: payload.error.message || transientSseErrorMessage } : null;
}

// Consumes whole frames from `buffer` and returns the unconsumed tail.
function eachSseFrame(buffer, onFrame) {
  while (true) {
    const separator = buffer.match(/\r?\n\r?\n/);
    if (!separator) return buffer;
    const frame = buffer.slice(0, separator.index);
    buffer = buffer.slice(separator.index + separator[0].length);
    onFrame(frame);
  }
}

// Frames that carry a JSON object, with gateway noise already dropped. Every
// consumer wants the parsed payload, so nothing downstream re-checks the shape.
function parseSseEvents(buffer, onPayload) {
  return eachSseFrame(buffer, (frame) => {
    if (shouldDropSseFrame(frame)) {
      stats.droppedSseFrames += 1;
      return;
    }
    const data = sseFrameData(frame);
    if (!data || data === "[DONE]") return;
    try {
      const payload = JSON.parse(data);
      if (payload && typeof payload === "object") onPayload(payload);
    } catch {
      // Ignore malformed vendor extension frames.
    }
  });
}

function collectResponseBody(upstreamRes) {
  const limit = 2 * 1024 * 1024;
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

function sendNetworkError(res, requestUrl, error) {
  if (!isClientAbort(error)) stats.networkErrors += 1;
  const message = error instanceof Error ? error.message : String(error);
  sendRetryableProxyError(res, requestUrl, 503, `Upstream connection error: ${message}`);
}

function classifyUpstreamResponse(upstreamRes, bodyText) {
  const status = upstreamRes.statusCode || 502;
  return status < 400 ? null : errorClassification(status, bodyText);
}

function deliverUpstreamError(res, requestUrl, upstreamRes, bodyText, classification = classifyUpstreamResponse(upstreamRes, bodyText)) {
  if (res.headersSent) return;
  const status = upstreamRes.statusCode || 502;
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
        `Upstream returned a transient ${status}; normalized to 429 so the client can retry.`,
        "rate_limit_exceeded"
      ),
      {
        "retry-after": retryAfterFrom(upstreamRes.headers),
        "cache-control": "no-store",
        "x-proxy-original-status": String(status),
        "x-proxy-classification": classification.reason
      }
    );
    return;
  }

  const headers = stripHopByHopHeaders(upstreamRes.headers);
  headers["cache-control"] = "no-store";
  headers["x-proxy-classification"] = classification.reason;

  if (classification.kind === "retryable") {
    stats.retryablePassed += 1;
    headers["retry-after"] = retryAfterFrom(upstreamRes.headers);
    if (!looksLikeJson(bodyText)) {
      sendJson(
        res,
        status,
        clientErrorShape(requestUrl, status === 429 ? "rate_limit_error" : "api_error", `Upstream returned retryable HTTP ${status}.`),
        headers
      );
      return;
    }
  } else {
    stats.permanentPassed += 1;
  }

  const body = bodyText || JSON.stringify(clientErrorShape(requestUrl, "api_error", `Upstream returned HTTP ${status}.`));
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
  if (!block || block.type !== "tool_use" || typeof block.partial_json !== "string") return;
  const partial = block.partial_json;
  delete block.partial_json;
  if (!partial.trim()) {
    if (block.input === undefined) block.input = {};
    return;
  }
  try {
    block.input = JSON.parse(partial);
  } catch {
    block.input = block.input ?? {};
    block._proxy_partial_json = partial;
  }
}

function buildCollectedAnthropicMessage(state, requestedModel) {
  for (const block of state.blocks) finalizeBlock(block);
  const message = state.message || {};
  return {
    id: message.id || `msg_proxy_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: message.role || "assistant",
    model: message.model || requestedModel,
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
    return payload?.type === "message_stop"
      || payload?.type === "response.completed"
      || payload?.type === "response.incomplete"
      || payload?.type === "response.failed";
  } catch {
    return false;
  }
}

function filteredStreamingResponse(upstreamRes, res, requestUrl, upstream, canFailover, finish) {
  const responseHeaders = stripHopByHopHeaders(upstreamRes.headers);
  responseHeaders["x-proxy-upstream"] = upstream.name;
  let buffer = "";
  let started = false;
  let sawMeaningfulFrame = false;
  // The client has been answered in full; nothing more may be written to it,
  // whether that was an early error, a terminal frame or a socket failure.
  let finished = false;
  upstreamRes.setEncoding("utf8");

  function startResponse() {
    if (started) return;
    started = true;
    res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
    finish({ kind: "committed", healthy: true });
  }

  function handleFrame(frame) {
    if (finished) return;
    if (!started) {
      const earlyError = sseErrorInfo(frame);
      if (earlyError) {
        finished = true;
        if (earlyError.status === 503 && canFailover) {
          finish({ kind: "failover", reason: "sse-error-before-first-token" });
          return;
        }
        res.setHeader("x-proxy-upstream", upstream.name);
        sendRetryableProxyError(res, requestUrl, earlyError.status, earlyError.message, {
          "x-proxy-classification": "sse-error-before-first-token"
        });
        finish({ kind: "delivered", healthy: false, cool: earlyError.status === 503 });
        upstreamRes.destroy();
        return;
      }
    }
    if (shouldDropSseFrame(frame)) {
      stats.droppedSseFrames += 1;
      return;
    }
    const data = sseFrameData(frame);
    if (data && data !== "[DONE]") sawMeaningfulFrame = true;
    if (!sawMeaningfulFrame) return;

    // Gateways pad frames with extra newlines; re-emit exactly one separator so
    // the client always sees well-formed SSE, including on the final frame.
    const normalized = frame.replace(/^[\r\n]+/, "").replace(/[\r\n]+$/, "");
    if (!normalized) return;

    startResponse();
    res.write(`${normalized}\n\n`);

    if (isTerminalSseFrame(normalized)) {
      finished = true;
      stats.streamsClosedOnTerminalFrame += 1;
      res.end();
      upstreamRes.destroy();
    }
  }

  upstreamRes.on("data", (chunk) => {
    buffer = eachSseFrame(buffer + chunk, handleFrame);
  });

  upstreamRes.on("end", () => {
    if (finished) return;
    if (buffer) handleFrame(buffer);
    if (finished) return;
    if (!sawMeaningfulFrame) {
      stats.emptyStreamsRecovered += 1;
      if (canFailover) {
        finish({ kind: "failover", reason: "empty-stream" });
        return;
      }
      res.setHeader("x-proxy-upstream", upstream.name);
      sendRetryableProxyError(res, requestUrl, 503, "Upstream returned an empty SSE stream. Retrying is safe.", {
        "x-proxy-classification": "empty-stream"
      });
      finish({ kind: "delivered", healthy: false, cool: true });
      return;
    }
    if (!started) startResponse();
    res.end();
  });

  upstreamRes.on("error", (error) => {
    if (finished) return;
    if (!isClientAbort(error)) stats.networkErrors += 1;
    if (!started) {
      if (canFailover && !isClientAbort(error)) {
        finish({ kind: "failover", reason: "response-stream-error" });
        return;
      }
      res.setHeader("x-proxy-upstream", upstream.name);
      sendRetryableProxyError(res, requestUrl, 503, `Upstream stream failed before first event: ${error.message}`);
      finish({ kind: "delivered", healthy: false, cool: !isClientAbort(error) });
    } else {
      res.destroy(error);
    }
  });
}

function completeMessage(upstreamRes, res, requestUrl, body, upstream, canFailover, finish) {
  const clientPayload = JSON.parse(body.toString("utf8"));
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
  let finalized = false;

  // Reply as soon as the message is complete. Waiting for the upstream socket
  // to close adds the gateway's full keep-alive idle timeout to every call.
  function finalize() {
    if (finalized) return;
    finalized = true;
    if (state.error) {
      const status = sseErrorStatus(state.error);
      const message = state.error.message;
      if (status === 503 && canFailover) {
        finish({ kind: "failover", reason: "sse-error-before-first-token" });
      } else if (status) {
        res.setHeader("x-proxy-upstream", upstream.name);
        sendRetryableProxyError(res, requestUrl, status, message || transientSseErrorMessage);
        finish({ kind: "delivered", healthy: false, cool: status === 503 });
      } else {
        res.setHeader("x-proxy-upstream", upstream.name);
        sendJson(res, 502, clientErrorShape(requestUrl, "api_error", message || "Upstream stream returned an error."));
        finish({ kind: "delivered", healthy: false, cool: true });
      }
      return;
    }
    if (!state.seenUsefulEvent) {
      stats.emptyStreamsRecovered += 1;
      if (canFailover) {
        finish({ kind: "failover", reason: "empty-stream" });
        return;
      }
      res.setHeader("x-proxy-upstream", upstream.name);
      sendRetryableProxyError(res, requestUrl, 503, "Upstream returned an empty SSE stream while collecting a non-streaming response.");
      finish({ kind: "delivered", healthy: false, cool: true });
      return;
    }
    res.setHeader("x-proxy-upstream", upstream.name);
    sendJson(res, 200, buildCollectedAnthropicMessage(state, clientPayload.model));
    finish({ kind: "delivered", healthy: true });
  }

  upstreamRes.setEncoding("utf8");
  upstreamRes.on("data", (chunk) => {
    if (finalized) return;
    buffer = parseSseEvents(buffer + chunk, (payload) => {
      applyAnthropicSsePayload(state, payload);
      if (payload.type === "message_stop") {
        stats.streamsClosedOnTerminalFrame += 1;
        finalize();
        upstreamRes.destroy();
      }
    });
  });
  upstreamRes.on("end", () => {
    if (finalized) return;
    if (buffer.trim()) parseSseEvents(`${buffer}\n\n`, (payload) => applyAnthropicSsePayload(state, payload));
    finalize();
  });
  upstreamRes.on("error", (error) => {
    if (finalized) return;
    if (canFailover) {
      if (!isClientAbort(error)) stats.networkErrors += 1;
      finalized = true;
      finish({ kind: "failover", reason: "response-stream-error" });
    } else {
      res.setHeader("x-proxy-upstream", upstream.name);
      sendNetworkError(res, requestUrl, error);
      finish({ kind: "delivered", healthy: false, cool: !isClientAbort(error) });
    }
  });
}

function forwardChatRequest(upstreamRes, res, requestUrl, _body, upstream, canFailover, finish, wantsStream) {
  if (wantsStream || String(upstreamRes.headers["content-type"] || "").includes("text/event-stream")) {
    filteredStreamingResponse(upstreamRes, res, requestUrl, upstream, canFailover, finish);
    return;
  }
  const headers = stripHopByHopHeaders(upstreamRes.headers);
  headers["x-proxy-upstream"] = upstream.name;
  res.writeHead(upstreamRes.statusCode, headers);
  finish({ kind: "committed", healthy: true });
  upstreamRes.pipe(res);
  upstreamRes.on("error", (error) => res.destroy(error));
}

// The catalogue belongs to the gateway, including its errors. Forward the
// response byte for byte without classification, rewriting or SSE sanitation.
function forwardModelCatalogue(upstreamRes, res, _requestUrl, _body, upstream, _canFailover, finish) {
  const headers = stripHopByHopHeaders(upstreamRes.headers);
  headers["x-proxy-upstream"] = upstream.name;
  res.writeHead(upstreamRes.statusCode, headers);
  finish({
    kind: "committed",
    healthy: (upstreamRes.statusCode || 502) < 400,
    cool: (upstreamRes.statusCode || 502) >= 500
  });
  upstreamRes.pipe(res);
  upstreamRes.on("error", (error) => res.destroy(error));
}

function upstreamOrder() {
  const now = Date.now();
  const live = upstreams.filter((upstream) => upstream.coolUntil <= now);
  // ponytail: all waiters retry the primary on expiry; single-flight probe if it matters.
  return live.length ? live : upstreams;
}

function attemptUpstream(req, res, requestUrl, body, wantsStream, route, upstream, canFailover) {
  return new Promise((resolve) => {
    let settled = false;
    let outcomeKind = null;
    let upstreamReq = null;
    let upstreamRes = null;

    const clientClosed = () => {
      if (outcomeKind === "delivered") return;
      const abortError = new Error("Client aborted request.");
      abortError.code = "PROXY_CLIENT_ABORT";
      upstreamReq?.destroy(abortError);
      upstreamRes?.destroy(abortError);
      if (!settled) finish({ kind: "delivered", healthy: false });
    };
    req.once("aborted", clientClosed);
    res.once("close", clientClosed);

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      outcomeKind = outcome.kind;
      req.off("aborted", clientClosed);
      if (outcome.kind !== "committed") res.off("close", clientClosed);
      if (outcome.kind === "failover") {
        upstreamReq?.destroy();
        if (upstreamRes && !upstreamRes.complete) upstreamRes.destroy();
      }
      resolve(outcome);
    };

    const networkFailure = (error, reason) => {
      if (settled) return;
      if (!isClientAbort(error)) stats.networkErrors += 1;
      if (canFailover && !isClientAbort(error)) {
        finish({ kind: "failover", reason });
        return;
      }
      res.setHeader("x-proxy-upstream", upstream.name);
      const message = error instanceof Error ? error.message : String(error);
      sendRetryableProxyError(res, requestUrl, 503, `Upstream connection error: ${message}`);
      finish({ kind: "delivered", healthy: false, cool: !isClientAbort(error) });
    };

    upstream.requests += 1;
    upstreamReq = requestUpstream(req, requestUrl, body, wantsStream, route, upstream, async (response) => {
      if (settled) {
        response.destroy();
        return;
      }
      upstreamRes = response;
      const status = response.statusCode || 502;
      if (status >= 500 && canFailover) {
        finish({ kind: "failover", reason: `http-${status}` });
        return;
      }
      if (status >= 400 && route.flow !== forwardModelCatalogue) {
        try {
          const bodyText = await collectResponseBody(response);
          if (settled) return;
          const classification = classifyUpstreamResponse(response, bodyText);
          res.setHeader("x-proxy-upstream", upstream.name);
          deliverUpstreamError(res, requestUrl, response, bodyText, classification);
          finish({ kind: "delivered", healthy: false, cool: status >= 500 });
        } catch (error) {
          networkFailure(error, "response-stream-error");
        }
        return;
      }
      route.flow(response, res, requestUrl, body, upstream, canFailover, finish, wantsStream);
    });
    upstreamReq.on("error", (error) => networkFailure(error, "network-error"));
  });
}

async function proxyRequest(req, res, requestUrl, body, wantsStream, route) {
  const order = upstreamOrder();
  const deadline = Date.now() + upstreamTimeoutMs + 30000;
  for (let index = 0; index < order.length; index += 1) {
    const upstream = order[index];
    const canFailover = index < order.length - 1 && Date.now() < deadline;
    const outcome = await attemptUpstream(req, res, requestUrl, body, wantsStream, route, upstream, canFailover);
    if (outcome.kind === "failover" || outcome.cool) {
      upstream.coolUntil = Date.now() + cooldownMs;
      upstream.failovers += 1;
      stats.failovers += 1;
    }
    if (outcome.kind === "failover") continue;
    if (outcome.healthy) upstream.coolUntil = 0;
    return;
  }
}

const server = http.createServer(async (req, res) => {
  const requestId = crypto.randomUUID();
  req._proxyRequestId = requestId;
  stats.requests += 1;
  res.setHeader("x-proxy-version", proxyVersion);
  res.setHeader("x-proxy-request-id", requestId);

  res.once("finish", () => log(requestId, "<-CL", `${res.statusCode}`));

  // Before anything else, and before the trace tap below: a request this server
  // will not answer should leave no trace file entry for an attacker to grow.
  if (rejectedByHostGuard(req, res, allowedHosts)) return;

  // Record every byte the proxy sends back to the client, so a stream that
  // never terminates is visible in the trace as a missing frame separator.
  if (traceEnabled) {
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
    // Only an allow-listed Host header reaches this line, so there is no
    // missing-header case left for a substitute authority to cover.
    requestUrl = new URL(req.url || "/", `http://${req.headers.host}`);

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

    const route = routes.get(requestUrl.pathname);
    if (route?.method !== req.method) {
      sendJson(res, 404, clientErrorShape(requestUrl, "not_found", servedRoutesMessage));
      return;
    }

    // The catalogue belongs to the gateway. Which models a key can actually
    // reach is its answer to give, and a list maintained here would be a second
    // one to keep true, so the request goes up exactly as it arrived — query
    // string and all — and the reply comes back untouched, errors included: a
    // gateway 429 or 500 about the catalogue is the gateway's answer too, not
    // raw material for the classification pipeline the chat routes need. There
    // is no body on either leg to read, parse or normalise, which is why this
    // returns before the JSON path below rather than being another branch
    // inside it.
    if (route.flow === forwardModelCatalogue) {
      trace(requestId, "ROUTE", requestUrl.pathname);
      await proxyRequest(req, res, requestUrl, Buffer.alloc(0), false, route);
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

    if (route.flow === completeMessage && !wantsStream) {
      const upstreamBody = Buffer.from(JSON.stringify({ ...payload, stream: true }));
      await proxyRequest(req, res, requestUrl, upstreamBody, true, route);
    } else {
      const flow = route.flow === completeMessage ? forwardChatRequest : route.flow;
      await proxyRequest(req, res, requestUrl, body, wantsStream, { ...route, flow });
    }
  } catch (error) {
    sendHttpError(res, requestUrl, error);
  }
});

server.requestTimeout = upstreamTimeoutMs + 30000;
server.headersTimeout = 65000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 1000;

// Health lives on its own listener, and that listener is bound to loopback
// rather than HOST. HOST is 0.0.0.0 inside a container, so serving health from
// the main server would publish uptime, upstream origin and traffic counters to
// the reverse proxy and therefore to the internet. Binding container-loopback
// makes it unreachable from outside by construction, with no auth to get wrong,
// while Docker's HEALTHCHECK — which runs inside the container — still reaches
// it. Keeping it off the main port also keeps a 30s probe out of the trace file.
const healthBindHost = "127.0.0.1";

const healthServer = http.createServer((req, res) => {
  if (rejectedByHostGuard(req, res, loopbackHosts)) return;

  // Split rather than parsed: the probe's exact request target is not this
  // file's to dictate, so /health?probe=1 has to answer like /health.
  const pathname = String(req.url || "/").split("?")[0];
  if (req.method !== "GET" || pathname !== "/health") {
    sendJson(res, 404, {
      type: "error",
      error: { type: "not_found", message: "This listener serves GET /health only." }
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    version: proxyVersion,
    node: nodeRuntimeVersion,
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    upstreams: upstreams.map((upstream) => ({
      name: upstream.name,
      origin: upstream.baseUrl.origin,
      cooling: upstream.coolUntil > Date.now(),
      cool_until: upstream.coolUntil || null,
      requests: upstream.requests,
      failovers: upstream.failovers
    })),
    stats: { ...stats }
  });
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down Local API Proxy v${proxyVersion}.`);
  let closing = 2;
  const closed = () => {
    closing -= 1;
    if (closing === 0) process.exit(0);
  };
  server.close(closed);
  healthServer.close(closed);
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(port, host, () => {
  console.log(`Local API Proxy v${proxyVersion} listening on http://${host}:${port} with ${nodeRuntimeVersion}`);
  console.log(`Answering requests for these hosts only: ${allowedHosts.join(", ")}`);
  traceInit();
});

healthServer.listen(healthPort, healthBindHost, () => {
  console.log(`Health endpoint listening on http://${healthBindHost}:${healthPort}/health (this host only)`);
});
