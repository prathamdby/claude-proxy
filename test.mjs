#!/usr/bin/env node
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Both keys are deliberately unlike each other: neither contains the other and
// they share no six-character prefix, so a redaction assertion on the trace file
// below can tell "this secret leaked" apart from "this text merely resembles
// it". Neither prefix occurs anywhere else in the suite either -- a key starting
// "test-" would collide with the "test-lingering" model id. LOCAL_PROXY_KEY also
// has to clear the proxy's 32-character floor or the proxy refuses to start.
const testApiKey = "Zq7upstreamKeyNeverLeavesTheMock9Xv";
const secondaryApiKey = "Vb8secondaryKeyStaysPrivate4Qn";
const thirdApiKey = "Mc6thirdKeyStaysPrivate2Lp";
const localKey = "Kd4localProxySharedSecretForTests7Wm";
const captured = [];
const secondaryCaptured = [];
const thirdCaptured = [];
const lingeringResponses = [];
const validationOutputs = [];
const lifecycleEvents = [];
let resolveClientAbortStarted;
let resolveClientAbortClosed;
let resolveFailedResponseDestroyed;
const clientAbortStarted = new Promise((resolve) => { resolveClientAbortStarted = resolve; });
const clientAbortClosed = new Promise((resolve) => { resolveClientAbortClosed = resolve; });
const failedResponseDestroyed = new Promise((resolve) => { resolveFailedResponseDestroyed = resolve; });
const preservedSession = "123e4567-e89b-42d3-a456-426614174000";

// The gateway's model catalogue. Both ids are unlike anything else the suite
// sends, so an assertion that the proxy returned this list cannot pass on a
// catalogue the proxy invented from its own configuration.
const upstreamModelCatalogue = {
  data: [
    { type: "model", id: "gateway-alpha", display_name: "Gateway Alpha", created_at: "2026-01-09T00:00:00Z" },
    { type: "model", id: "gateway-beta", display_name: "Gateway Beta", created_at: "2026-02-17T00:00:00Z" }
  ],
  has_more: false,
  first_id: "gateway-alpha",
  last_id: "gateway-beta"
};

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function writeAnthropicTextStream(res, text = "OK") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
  res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
  res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`);
  res.write('data: {"billing":{"request":{"success":true}},"object":"billing.summary"}\n\n');
  res.write('event: ping\ndata: null\n\n');
  res.write('event: billing_summary\ndata: {"billing":{"request":{"success":true}},"object":"billing_summary"}\n\n');
  res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n');
  res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
}

function writeAnthropicToolStream(res) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_tool","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}\n\n');
  res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool_1","name":"lookup","input":{}}}\n\n');
  res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n');
  res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"Lahore\\",\\"units\\":\\"c\\"}"}}\n\n');
  res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
  res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}\n\n');
  res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
}

// Mirrors the gateway: "\n\n\n" frame separators, and the socket is deliberately
// held open after message_stop instead of being closed.
function writeLingeringAnthropicStream(res) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_linger","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n\n');
  res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n\n');
  res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n\n');
  res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n\n');
  res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n\n');
}

function writeOpenAiStream(res) {  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write('data: {"id":"chat_test","object":"chat.completion.chunk","model":"glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n');
  res.write('data: {"billing":{"request":{"success":true}},"object":"billing.summary"}\n\n');
  res.write('data: null\n\n');
  res.write('data: {"billing":{"request":{"success":true}},"object":"billing_summary"}\n\n');
  res.write('data: {"id":"chat_test","object":"chat.completion.chunk","model":"glm-5.2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
  res.end('data: [DONE]\n\n');
}

function writeResponsesJson(res, payload) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "resp_upstream",
    object: "response",
    status: "completed",
    previous_response_id: payload.previous_response_id ?? null,
    output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
    usage: { input_tokens: 3, output_tokens: 1 }
  }));
}

function writeResponsesTextStream(res, text = "OK") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_test","object":"response","status":"in_progress"}}\n\n');
  res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
  res.write('data: {"billing":{"request":{"success":true}},"object":"billing.summary"}\n\n');
  res.write('data: null\n\n');
  res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_test","object":"response","status":"completed"}}\n\n');
}

function writeLingeringResponsesStream(res, terminalType = "response.completed") {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_linger","object":"response","status":"in_progress"}}\n\n\n');
  res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n\n');
  const status = terminalType === "response.completed" ? "completed" : terminalType === "response.incomplete" ? "incomplete" : "failed";
  res.write(`event: ${terminalType}\ndata: ${JSON.stringify({ type: terminalType, response: { id: "resp_linger", object: "response", status } })}\n\n\n`);
}

const upstream = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch {}
    captured.push({ method: req.method, url: req.url, headers: req.headers, body, payload });

    if (req.url.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 123 }));
      return;
    }

    if (req.url.startsWith("/v1/messages")) {
      switch (payload.model) {
        case "test-failover-500":
        case "test-failover-empty-complete":
          if (payload.model === "test-failover-500") {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { type: "api_error", message: "primary unavailable" } }));
          } else {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end('event: ping\ndata: null\n\n');
          }
          return;
        case "test-no-failover-429":
          res.writeHead(429, { "content-type": "application/json", "retry-after": "5" });
          res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "primary rate limit" } }));
          return;
        case "test-no-failover-400":
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "primary rejected request" } }));
          return;
        case "test-destroy-prior":
          res.on("close", () => {
            lifecycleEvents.push("primary-response-destroyed");
            resolveFailedResponseDestroyed();
          });
          res.writeHead(500, { "content-type": "text/plain" });
          res.write("partial primary failure");
          return;
        case "test-client-abort":
          res.on("close", resolveClientAbortClosed);
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.flushHeaders();
          resolveClientAbortStarted();
          return;
        case "test-failover-sse-503":
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"primary overloaded"}}\n\n');
          return;
        case "test-no-failover-sse-429":
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end('event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"primary rate limited"}}\n\n');
          return;
        case "test-failover-empty-stream":
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end('event: ping\ndata: null\n\n');
          return;
        case "test-failover-before-first":
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.flushHeaders();
          res.socket.destroy();
          return;
        case "test-failover-after-first":
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_partial","type":"message","role":"assistant","model":"claude-opus-4-8","content":[]}}\n\n');
          setTimeout(() => res.socket.destroy(), 20);
          return;
        case "test-all-down":
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("primary down");
          return;
        case "test-rate":
          res.writeHead(403, { "content-type": "application/json", "retry-after": "7" });
          res.end(JSON.stringify({ error: { type: "gateway_error", message: "quota exceeded for this key" } }));
          return;
        case "test-permanent-model":
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "model not found" } }));
          return;
        case "test-413":
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "request too large; size limit exceeded" } }));
          return;
        case "test-500-html":
          res.writeHead(500, { "content-type": "text/html" });
          res.end("<html>gateway exploded</html>");
          return;
        case "test-empty":
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"billing":{"request":{"success":true}},"object":"billing.summary"}\n\n');
          res.end('event: ping\ndata: null\n\n');
          return;
        case "test-sse-error":
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"provider overloaded"}}\n\n');
          return;
        case "test-sse-error-typed":
          // Transient only by its error type; the message matches no known phrase.
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"pick a different model"}}\n\n');
          return;
        case "test-tool":
          writeAnthropicToolStream(res);
          return;
        case "test-lingering":
          lingeringResponses.push(res);
          writeLingeringAnthropicStream(res);
          return;
        default:
          writeAnthropicTextStream(res);
          return;
      }
    }

    if (req.url.startsWith("/v1/responses")) {
      switch (payload.model) {
        case "test-failover-responses":
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "primary unavailable", type: "api_error" } }));
          return;
        case "test-all-down":
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("primary down");
          return;
        case "test-rate-responses":
          res.writeHead(403, { "content-type": "application/json", "retry-after": "7" });
          res.end(JSON.stringify({ error: { type: "gateway_error", message: "quota exceeded for this key" } }));
          return;
        case "test-permanent-responses":
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "model not found" } }));
          return;
        case "test-500-html-responses":
          res.writeHead(500, { "content-type": "text/html" });
          res.end("<html>gateway exploded</html>");
          return;
        case "test-empty-responses":
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"billing":{"request":{"success":true}},"object":"billing.summary"}\n\n');
          res.end('event: ping\ndata: null\n\n');
          return;
        case "test-lingering-responses":
          lingeringResponses.push(res);
          writeLingeringResponsesStream(res);
          return;
        case "test-lingering-incomplete":
          lingeringResponses.push(res);
          writeLingeringResponsesStream(res, "response.incomplete");
          return;
        case "test-lingering-failed":
          lingeringResponses.push(res);
          writeLingeringResponsesStream(res, "response.failed");
          return;
        case "test-response-tool":
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "resp_tool",
            object: "response",
            status: "completed",
            output: [{
              type: "function_call",
              call_id: "call_weather",
              name: "get_weather",
              arguments: '{"city":"Lahore"}'
            }]
          }));
          return;
        default:
          if (payload.stream === true) {
            writeResponsesTextStream(res);
            return;
          }
          writeResponsesJson(res, payload);
          return;
      }
    }

    if (req.url.startsWith("/v1/chat/completions")) {
      if (payload.model === "test-failover-chat") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "primary unavailable", type: "api_error" } }));
        return;
      }
      if (payload.model === "test-all-down") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("primary down");
        return;
      }
      if (payload.model === "test-rate-openai") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "用户额度不足", type: "gateway_error" } }));
        return;
      }
      writeOpenAiStream(res);
      return;
    }

    if (req.url.startsWith("/v1/models")) {
      if (req.url.includes("failprimary=1")) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("primary down");
        return;
      }
      if (req.url.includes("force429")) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
        res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "quota" } }));
        return;
      }
      if (req.url.includes("force500html")) {
        res.writeHead(500, { "content-type": "text/html" });
        res.end("<html>gateway exploded</html>");
        return;
      }
      if (req.url.includes("forceempty")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(upstreamModelCatalogue));
      return;
    }

    res.writeHead(404).end();
  });
});

function createBackupUpstream(name, requests) {
  return http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch {}
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, payload });
      if (payload.model === "test-destroy-prior") lifecycleEvents.push(`${name}-request-started`);

      const preserveFailure = new Set([
        "test-500-html", "test-empty", "test-sse-error", "test-sse-error-typed",
        "test-500-html-responses", "test-empty-responses", "test-all-down"
      ]);
      if (preserveFailure.has(payload.model) || req.url.includes("force500html")) {
        if (payload.model?.includes("empty")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end('event: ping\ndata: null\n\n');
        } else if (payload.model?.includes("sse-error")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const message = payload.model === "test-sse-error-typed" ? "pick a different model" : "provider overloaded";
          res.end(`event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"${message}"}}\n\n`);
        } else {
          res.writeHead(500, { "content-type": "text/html" });
          res.end("<html>gateway exploded</html>");
        }
        return;
      }
      if (req.url.includes("forceempty")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("");
        return;
      }

      if (req.url.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 123 }));
      } else if (req.url.startsWith("/v1/messages")) {
        writeAnthropicTextStream(res, name.toUpperCase());
      } else if (req.url.startsWith("/v1/responses")) {
        if (payload.stream === true) writeResponsesTextStream(res, name.toUpperCase());
        else writeResponsesJson(res, payload);
      } else if (req.url.startsWith("/v1/chat/completions")) {
        writeOpenAiStream(res);
      } else if (req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...upstreamModelCatalogue, served_by: name }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
}

const secondary = createBackupUpstream("secondary", secondaryCaptured);
const third = createBackupUpstream("third", thirdCaptured);

// Two free ports are needed now: the public one and the health listener's. Both
// probes are held open at the same time before either is released, because
// closing the first one before asking for the second lets the kernel hand back
// the same number twice -- and two identical ports is the one combination the
// proxy refuses to start on.
const upstreamPort = await listen(upstream);
const secondaryPort = await listen(secondary);
const thirdPort = await listen(third);
const probe = http.createServer();
const healthProbe = http.createServer();
const proxyPort = await listen(probe);
const healthPort = await listen(healthProbe);
probe.close();
healthProbe.close();
// Both listeners are attached before either close is awaited: awaiting the first
// one hands control back to the event loop, and the second server's "close" can
// fire during that turn, with nothing listening for it yet.
await Promise.all([once(probe, "close"), once(healthProbe, "close")]);

// proxy.mjs requires every variable and has no defaults, so the suite supplies
// the full set explicitly. No `...process.env` spread: the run has to be
// hermetic, otherwise a developer shell that happens to export these would hide
// a missing variable here and the suite would fail only in CI or in a container.
const traceFilePath = join(tmpdir(), `proxy-test-trace-${process.pid}.log`);
const upstreamsFilePath = join(tmpdir(), `proxy-test-upstreams-${process.pid}.json`);
const validationPaths = [];
fs.writeFileSync(upstreamsFilePath, JSON.stringify([
  { name: "primary", base_url: `http://127.0.0.1:${upstreamPort}`, api_key: testApiKey },
  { name: "secondary", base_url: `http://127.0.0.1:${secondaryPort}`, api_key: secondaryApiKey },
  { name: "third", base_url: `http://127.0.0.1:${thirdPort}`, api_key: thirdApiKey }
]));
const proxyEnv = {
  HOST: "127.0.0.1",
  PORT: String(proxyPort),
  HEALTH_PORT: String(healthPort),
  // Both names the suite reaches this proxy under. Everything else, including
  // the DNS-rebinding names a browser could point at 127.0.0.1, is refused.
  ALLOWED_HOSTS: "127.0.0.1,localhost",
  UPSTREAMS_FILE: upstreamsFilePath,
  LOCAL_PROXY_KEY: localKey,
  CLAUDE_CODE_VERSION: "0.0.0-test",
  UPSTREAM_TIMEOUT_MS: "300000",
  UPSTREAM_COOLDOWN_MS: "100",
  RETRY_AFTER_SECONDS: "11",
  MAX_BODY_BYTES: "26214400",
  PROXY_LOG: "true",
  PROXY_LOG_VERBOSE: "false",
  PROXY_LOG_BODY_LIMIT: "800",
  PROXY_TRACE_FILE: traceFilePath,
  PROXY_TRACE: "true",
  PROXY_TRACE_BODY_LIMIT: "4000"
};

const proxy = spawn(process.execPath, ["proxy.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: proxyEnv,
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
let stdout = "";
proxy.stdout.setEncoding("utf8");
proxy.stdout.on("data", (chunk) => { stdout += chunk; });
proxy.stderr.setEncoding("utf8");
proxy.stderr.on("data", (chunk) => { stderr += chunk; });

const authHeaders = {
  authorization: `Bearer ${localKey}`,
  "content-type": "application/json"
};

// Readiness is read from the health listener, which is the only place /health is
// served now. It is the second of the proxy's two listeners to be started, so an
// answer here means the public port is already accepting too.
async function waitForProxy() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${healthPort}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Proxy did not start: ${stderr}`);
}

async function post(path, payload, extraHeaders = {}) {
  return fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: "POST",
    headers: { ...authHeaders, ...extraHeaders },
    body: JSON.stringify(payload)
  });
}

// fetch() attaches its own User-Agent and flatly refuses to set Host, so every
// case that needs control over what leaves the client -- the header defaults, and
// all of the Host guard cases -- goes through the raw client instead.
// `setHost: false` is what leaves the Host header off the wire entirely.
function rawRequest({ method = "GET", path = "/", headers = {}, body = undefined, port = proxyPort, omitHost = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      setHost: !omitHost,
      headers: {
        ...headers,
        ...(payload === null ? {} : { "content-length": Buffer.byteLength(payload) })
      }
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on("error", reject);
    request.end(payload ?? undefined);
  });
}

// Every guard rejection has to look the same from outside: one status, one
// shape, and nothing a prober can learn from. Rejections are counted here so the
// stats.hostRejected assertion later can be an exact figure rather than a floor.
let hostRejectionsCaused = 0;
function assertForbidden(response, rejectedValue, why) {
  assert.equal(response.status, 403, `${why} must be refused with 403, got ${response.status}: ${response.text}`);
  const body = JSON.parse(response.text);
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "forbidden");
  // The reply must not echo what was rejected, and must not name what would have
  // been accepted: either one turns the guard into an oracle for the allow-list.
  assert.ok(!response.text.includes(rejectedValue), `403 body echoed ${rejectedValue} back: ${response.text}`);
  assert.doesNotMatch(response.text, /127\.0\.0\.1|localhost/, `403 body named the allow-list: ${response.text}`);
  hostRejectionsCaused += 1;
}

// Runs proxy.mjs to completion with a deliberately broken environment and
// reports how it died. These children exit inside config validation, so they
// never reach server.listen and cannot collide with the proxy under test.
function runProxyToExit(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["proxy.mjs"], {
      cwd: new URL(".", import.meta.url),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let childStderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { childStderr += chunk; });
    const guard = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.once("error", (error) => {
      clearTimeout(guard);
      const result = { code: null, stdout, stderr: String(error) };
      validationOutputs.push(result);
      resolve(result);
    });
    child.once("close", (code) => {
      clearTimeout(guard);
      const result = { code, stdout, stderr: childStderr };
      validationOutputs.push(result);
      resolve(result);
    });
  });
}

function envWithout(...names) {
  const partial = { ...proxyEnv };
  for (const name of names) delete partial[name];
  return partial;
}

// The sibling for values that are present but unusable, rather than absent.
function envWith(overrides) {
  return { ...proxyEnv, ...overrides };
}

function envWithUpstreams(contents) {
  const filePath = join(tmpdir(), `proxy-test-invalid-upstreams-${process.pid}-${validationPaths.length}.json`);
  fs.writeFileSync(filePath, typeof contents === "string" ? contents : JSON.stringify(contents));
  validationPaths.push(filePath);
  return envWith({ UPSTREAMS_FILE: filePath });
}

try {
  await waitForProxy();

  // Local API auth is enforced, and it runs before routing: an unauthenticated
  // call to a path the proxy does not serve is still 401, not 404.
  const rejected = await fetch(`http://127.0.0.1:${proxyPort}/v1/unserved`);
  assert.equal(rejected.status, 401);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.error.type, "authentication_error");

  // The same ordering holds on the new GET route: an unauthenticated
  // /v1/models is 401, and nothing may leave for the gateway. A 404 here
  // would mean routing ran before auth and confirmed the route exists.
  const modelsAuthIndex = captured.length;
  const modelsNoAuth = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?limit=2`);
  assert.equal(modelsNoAuth.status, 401);
  assert.equal(modelsNoAuth.headers.get("www-authenticate"), "Bearer");
  assert.equal((await modelsNoAuth.json()).error.type, "authentication_error");
  const modelsWrongKey = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?limit=2`, {
    headers: { "x-api-key": "not-the-local-key" }
  });
  assert.equal(modelsWrongKey.status, 401);
  assert.equal(captured.length, modelsAuthIndex, "unauthenticated /v1/models reached the gateway");

  // /v1/models is forwarded to the gateway and its answer is returned byte for
  // byte. The catalogue is the gateway's -- these ids exist nowhere in the
  // proxy's configuration, so a list assembled locally could not produce them.
  const modelsIndex = captured.length;
  const modelsResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?limit=2&after_id=gateway-zero`, {
    headers: { authorization: `Bearer ${localKey}` }
  });
  assert.equal(modelsResponse.status, 200);
  assert.match(modelsResponse.headers.get("content-type"), /application\/json/);
  assert.equal(await modelsResponse.text(), JSON.stringify(upstreamModelCatalogue));

  // It reaches upstream as the GET it was, with no body invented for it, and
  // carrying the pagination the client asked for. beta=true is not bolted on:
  // that parameter belongs to /v1/messages and nothing else.
  const modelsRequest = captured[modelsIndex];
  assert.equal(modelsRequest.method, "GET");
  assert.equal(modelsRequest.url, "/v1/models?limit=2&after_id=gateway-zero");
  assert.equal(modelsRequest.body, "");

  // The credential swap is not something the messages routes do on their own:
  // it happens for every forwarded request, including this one.
  assert.equal(modelsRequest.headers.authorization, `Bearer ${testApiKey}`);
  assert.notEqual(modelsRequest.headers.authorization, `Bearer ${localKey}`);
  assert.equal(modelsRequest.headers["x-api-key"], undefined);
  assert.equal(modelsRequest.headers["anthropic-version"], undefined);
  assert.equal(modelsRequest.headers["anthropic-beta"], undefined);

  // Even a GET that arrives carrying a body is forwarded without one: the
  // proxy sends Buffer.alloc(0) regardless, and an encoded query crosses
  // exactly as written. fetch() drops GET bodies, so this uses the raw client.
  const rawModelsIndex = captured.length;
  const rawModels = await rawRequest({
    method: "GET",
    path: "/v1/models?limit=2&after_id=gateway%20zero",
    headers: { authorization: `Bearer ${localKey}` },
    body: '{"x":1}'
  });
  assert.equal(rawModels.status, 200);
  assert.equal(rawModels.text, JSON.stringify(upstreamModelCatalogue));
  const rawModelsRequest = captured[rawModelsIndex];
  assert.equal(rawModelsRequest.method, "GET");
  assert.equal(rawModelsRequest.url, "/v1/models?limit=2&after_id=gateway%20zero");
  assert.equal(rawModelsRequest.body, "");
  assert.equal(rawModelsRequest.headers["content-length"], "0");
  assert.ok(!rawModelsRequest.url.includes("beta=true"), "beta=true belongs to /v1/messages only");

  // The gateway's errors are its own answers too: status, headers and body
  // cross the proxy unchanged, with no classification and no rewrite.
  const models429 = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?force429=1`, {
    headers: { authorization: `Bearer ${localKey}` }
  });
  assert.equal(models429.status, 429);
  assert.equal(models429.headers.get("retry-after"), "7");
  assert.equal(models429.headers.get("x-proxy-classification"), null);
  assert.equal(await models429.text(), JSON.stringify({ error: { type: "rate_limit_error", message: "quota" } }));

  const models500 = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?force500html=1`, {
    headers: { authorization: `Bearer ${localKey}` }
  });
  assert.equal(models500.status, 500);
  assert.match(models500.headers.get("content-type"), /text\/html/);
  assert.equal(models500.headers.get("x-proxy-classification"), null);
  assert.equal(await models500.text(), "<html>gateway exploded</html>");

  const modelsEmpty = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?forceempty=1`, {
    headers: { authorization: `Bearer ${localKey}` }
  });
  assert.equal(modelsEmpty.status, 200);
  assert.equal(await modelsEmpty.text(), "");

  // The preceding all-upstreams-500 case cools every gateway. Let that state
  // expire before the legacy route assertions that intentionally inspect the
  // primary's captured wire image.
  await new Promise((resolve) => setTimeout(resolve, 120));

  // Each path answers to exactly one method, so /v1/models by POST is refused
  // the same way a path that is not served at all is -- one status, one body,
  // nothing that tells a prober which half of the pair they guessed right.
  const modelsByPost = await post("/v1/models", {});
  assert.equal(modelsByPost.status, 404);
  const messagesByGet = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    headers: { authorization: `Bearer ${localKey}` }
  });
  assert.equal(messagesByGet.status, 404);
  const modelsNotFound = await modelsByPost.json();
  const messagesNotFound = await messagesByGet.json();
  assert.equal(modelsNotFound.error.type, "not_found");
  assert.equal(messagesNotFound.error.type, "not_found");
  assert.equal(modelsNotFound.type, undefined);
  assert.equal(messagesNotFound.type, "error");

  // The 404 text is generated from the route table, so it can only ever name
  // routes that are really served -- method included.
  for (const route of [
    "POST /v1/messages",
    "POST /v1/messages/count_tokens",
    "POST /v1/chat/completions",
    "POST /v1/responses",
    "GET /v1/models"
  ]) {
    assert.ok(modelsNotFound.error.message.includes(route), `OpenAI 404 text must name ${route}`);
    assert.ok(messagesNotFound.error.message.includes(route), `Anthropic 404 text must name ${route}`);
  }

  // Streaming + SSE sanitation + beta merge + session preservation.
  const streamedIndex = captured.length;
  const streamedAnthropic = await post("/v1/messages", {
    model: "claude-opus-4-8",
    max_tokens: 8,
    stream: true,
    messages: [{ role: "user", content: "Reply OK" }]
  }, {
    "anthropic-beta": "custom-beta-2099-01-01",
    "x-claude-code-session-id": preservedSession,
    "user-agent": "claude-cli/2.1.233 (external, cli)",
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "60",
    "x-custom-client-header": "forward-me"
  });
  const anthropicSse = await streamedAnthropic.text();
  assert.equal(streamedAnthropic.status, 200);
  assert.match(anthropicSse, /"text":"OK"/);
  assert.match(anthropicSse, /message_stop/);
  assert.doesNotMatch(anthropicSse, /billing[._]summary/);
  assert.doesNotMatch(anthropicSse, /data:\s*null/);

  // A gateway that holds the socket open after message_stop must not stall the
  // client: the proxy closes on the terminal frame, not on socket close.
  const lingerStartedAt = Date.now();
  const lingering = await post("/v1/messages", {
    model: "test-lingering",
    max_tokens: 8,
    stream: true,
    messages: [{ role: "user", content: "x" }]
  });
  const lingeringSse = await lingering.text();
  const lingerMs = Date.now() - lingerStartedAt;
  assert.equal(lingering.status, 200);
  assert.match(lingeringSse, /"text":"OK"/);
  assert.match(lingeringSse, /message_stop/);
  assert.ok(lingerMs < 2000, `stream should end on message_stop, took ${lingerMs}ms`);

  // Frames are re-emitted with exactly one separator, never the upstream's "\n\n\n".
  assert.doesNotMatch(lingeringSse, /\n\n\n/);
  assert.ok(lingeringSse.endsWith("\n\n"), "stream must end with a complete frame separator");
  assert.doesNotMatch(lingeringSse, /\n\nevent:[^\n]*\n\ndata:/);

  // Non-streaming Anthropic collection reconstructs tool_use JSON correctly.
  const toolResponse = await post("/v1/messages", {
    model: "test-tool",
    max_tokens: 64,
    messages: [{ role: "user", content: "Use lookup" }]
  });
  const toolJson = await toolResponse.json();
  assert.equal(toolResponse.status, 200);
  assert.equal(toolJson.content[0].type, "tool_use");
  assert.deepEqual(toolJson.content[0].input, { city: "Lahore", units: "c" });
  assert.equal(toolJson.content[0].partial_json, undefined);

  // OpenAI-compatible streaming remains supported and sanitized.
  const openAiIndex = captured.length;
  const streamedOpenAi = await post("/v1/chat/completions", {
    model: "glm-5.2",
    stream: true,
    messages: [{ role: "user", content: "Reply OK" }]
  }, {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "should-not-be-forwarded"
  });
  const openAiSse = await streamedOpenAi.text();
  assert.equal(streamedOpenAi.status, 200);
  assert.match(openAiSse, /"choices":/);
  assert.match(openAiSse, /\[DONE\]/);
  assert.doesNotMatch(openAiSse, /billing[._]summary/);
  assert.doesNotMatch(openAiSse, /data:\s*null/);
  assert.equal(captured[openAiIndex].headers["anthropic-version"], undefined);
  assert.equal(captured[openAiIndex].headers["anthropic-beta"], undefined);

  // Responses is forwarded to upstream /v1/responses, not rewritten to Chat Completions.
  const responsesBefore = captured.length;
  const responseApi = await post("/v1/responses", {
    model: "glm-5.2",
    instructions: "Be concise.",
    input: "Reply OK",
    max_output_tokens: 32,
    store: true
  });
  const responseApiJson = await responseApi.json();
  assert.equal(responseApi.status, 200);
  assert.equal(responseApiJson.object, "response");
  assert.equal(responseApiJson.status, "completed");
  assert.equal(responseApiJson.id, "resp_upstream");
  assert.equal(responseApiJson.output[0].content[0].text, "OK");
  const responsesWire = captured[responsesBefore];
  assert.match(responsesWire.url, /^\/v1\/responses/);
  assert.equal(responsesWire.payload.input, "Reply OK");
  assert.equal(responsesWire.payload.messages, undefined);
  assert.equal(responsesWire.headers["anthropic-version"], undefined);
  assert.equal(responsesWire.headers["anthropic-beta"], undefined);

  // previous_response_id is forwarded as sent. The gateway owns the chain.
  const previousResponseFollowup = await post("/v1/responses", {
    model: "glm-5.2",
    previous_response_id: "resp_upstream",
    input: "Again"
  });
  assert.equal(previousResponseFollowup.status, 200);
  const previousFollowupJson = await previousResponseFollowup.json();
  assert.equal(previousFollowupJson.previous_response_id, "resp_upstream");
  const previousWire = captured.at(-1);
  assert.match(previousWire.url, /^\/v1\/responses/);
  assert.equal(previousWire.payload.previous_response_id, "resp_upstream");
  assert.equal(previousWire.payload.input, "Again");
  assert.equal(previousWire.payload.messages, undefined);

  // Responses streaming is sanitized and closed on response.completed.
  const streamedResponses = await post("/v1/responses", {
    model: "glm-5.2",
    input: [{ role: "user", content: [{ type: "input_text", text: "Reply OK" }] }],
    stream: true
  });
  const responsesSse = await streamedResponses.text();
  assert.equal(streamedResponses.status, 200);
  assert.match(responsesSse, /event: response\.created/);
  assert.match(responsesSse, /event: response\.output_text\.delta/);
  assert.match(responsesSse, /"delta":"OK"/);
  assert.match(responsesSse, /event: response\.completed/);
  assert.doesNotMatch(responsesSse, /chat\.completion\.chunk/);
  assert.doesNotMatch(responsesSse, /billing[._]summary/);

  const lingerResponsesStartedAt = Date.now();
  const lingeringResponsesCall = await post("/v1/responses", {
    model: "test-lingering-responses",
    input: "x",
    stream: true
  });
  const lingeringResponsesSse = await lingeringResponsesCall.text();
  const lingerResponsesMs = Date.now() - lingerResponsesStartedAt;
  assert.equal(lingeringResponsesCall.status, 200);
  assert.match(lingeringResponsesSse, /response\.completed/);
  assert.ok(lingerResponsesMs < 2000, `responses stream should end on response.completed, took ${lingerResponsesMs}ms`);
  assert.doesNotMatch(lingeringResponsesSse, /\n\n\n/);

  // Tools stay in Responses shape on the wire.
  const responseTool = await post("/v1/responses", {
    model: "test-response-tool",
    input: "Weather?",
    tools: [{
      type: "function",
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      strict: false
    }],
    tool_choice: { type: "function", name: "get_weather" }
  });
  const responseToolJson = await responseTool.json();
  assert.equal(responseTool.status, 200);
  assert.equal(responseToolJson.output[0].type, "function_call");
  assert.equal(responseToolJson.output[0].call_id, "call_weather");
  assert.equal(responseToolJson.output[0].name, "get_weather");
  const toolWire = captured.at(-1).payload;
  assert.equal(toolWire.tools[0].type, "function");
  assert.equal(toolWire.tools[0].name, "get_weather");
  assert.equal(toolWire.tools[0].function, undefined);

  // Built-in tools are forwarded. The proxy does not reject them.
  const webSearch = await post("/v1/responses", {
    model: "glm-5.2",
    input: "search",
    tools: [{ type: "web_search" }]
  });
  assert.equal(webSearch.status, 200);
  assert.equal(captured.at(-1).payload.tools[0].type, "web_search");

  const responsesNoAuth = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.2", input: "x" })
  });
  assert.equal(responsesNoAuth.status, 401);
  assert.equal(responsesNoAuth.headers.get("www-authenticate"), "Bearer");
  const responsesNoAuthJson = await responsesNoAuth.json();
  assert.equal(responsesNoAuthJson.error.type, "authentication_error");
  assert.equal(responsesNoAuthJson.type, undefined);

  const responsesByGet = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    headers: { authorization: `Bearer ${localKey}` }
  });
  assert.equal(responsesByGet.status, 404);
  const responsesByGetJson = await responsesByGet.json();
  assert.equal(responsesByGetJson.error.type, "not_found");
  assert.equal(responsesByGetJson.type, undefined);

  const responsesRate = await post("/v1/responses", { model: "test-rate-responses", input: "x" });
  const responsesRateJson = await responsesRate.json();
  assert.equal(responsesRate.status, 429);
  assert.equal(responsesRate.headers.get("retry-after"), "7");
  assert.equal(responsesRate.headers.get("x-proxy-original-status"), "403");
  assert.equal(responsesRateJson.error.type, "rate_limit_error");
  assert.equal(responsesRateJson.error.code, "rate_limit_exceeded");
  assert.equal(responsesRateJson.type, undefined);

  const responsesPermanent = await post("/v1/responses", { model: "test-permanent-responses", input: "x" });
  assert.equal(responsesPermanent.status, 403);
  assert.equal(responsesPermanent.headers.get("x-proxy-classification"), "permanent-pattern");
  assert.equal((await responsesPermanent.json()).type, undefined);

  const responsesHtml500 = await post("/v1/responses", { model: "test-500-html-responses", input: "x" });
  const responsesHtml500Json = await responsesHtml500.json();
  assert.equal(responsesHtml500.status, 500);
  assert.equal(responsesHtml500.headers.get("retry-after"), "11");
  assert.match(responsesHtml500.headers.get("content-type"), /application\/json/);
  assert.equal(responsesHtml500Json.error.type, "api_error");
  assert.equal(responsesHtml500Json.type, undefined);

  const responsesEmpty = await post("/v1/responses", { model: "test-empty-responses", input: "x", stream: true });
  const responsesEmptyJson = await responsesEmpty.json();
  assert.equal(responsesEmpty.status, 503);
  assert.equal(responsesEmpty.headers.get("retry-after"), "11");
  assert.equal(responsesEmpty.headers.get("x-proxy-classification"), "empty-stream");
  assert.equal(responsesEmptyJson.error.type, "api_error");
  assert.equal(responsesEmptyJson.type, undefined);
  await new Promise((resolve) => setTimeout(resolve, 120));

  for (const [model, terminal] of [
    ["test-lingering-incomplete", "response.incomplete"],
    ["test-lingering-failed", "response.failed"]
  ]) {
    const startedAt = Date.now();
    const response = await post("/v1/responses", { model, input: "x", stream: true });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, new RegExp(terminal.replaceAll(".", "\\.")));
    assert.ok(Date.now() - startedAt < 2000, `${terminal} stream should end on the terminal frame, took ${Date.now() - startedAt}ms`);
    assert.doesNotMatch(text, /\n\n\n/);
  }

  const bogusIdBefore = captured.length;
  const bogusPrevious = await post("/v1/responses", {
    model: "glm-5.2",
    previous_response_id: "resp_bogus_123",
    input: "Again"
  });
  assert.equal(bogusPrevious.status, 200);
  const bogusPreviousJson = await bogusPrevious.json();
  assert.notEqual(bogusPrevious.status, 400);
  assert.ok(!JSON.stringify(bogusPreviousJson).includes("Unknown or expired"));
  assert.equal(captured[bogusIdBefore].payload.previous_response_id, "resp_bogus_123");
  assert.match(captured[bogusIdBefore].url, /^\/v1\/responses/);

  const responsesQueryBefore = captured.length;
  const responsesWithQuery = await post("/v1/responses?foo=bar", {
    model: "glm-5.2",
    input: "x"
  }, {
    "Anthropic-Version": "2023-06-01",
    "Anthropic-Beta": "should-not-be-forwarded"
  });
  assert.equal(responsesWithQuery.status, 200);
  const responsesQueryWire = captured[responsesQueryBefore];
  assert.match(responsesQueryWire.url, /^\/v1\/responses\?foo=bar$/);
  assert.ok(!responsesQueryWire.url.includes("beta="));
  assert.equal(responsesQueryWire.headers["anthropic-version"], undefined);
  assert.equal(responsesQueryWire.headers["anthropic-beta"], undefined);

  // 403 quota/rate-limit -> 429, preserving upstream Retry-After.
  const rate = await post("/v1/messages", {
    model: "test-rate",
    max_tokens: 8,
    stream: true,
    messages: [{ role: "user", content: "x" }]
  });
  const rateJson = await rate.json();
  assert.equal(rate.status, 429);
  assert.equal(rate.headers.get("retry-after"), "7");
  assert.equal(rate.headers.get("x-proxy-original-status"), "403");
  assert.equal(rateJson.error.type, "rate_limit_error");

  // OpenAI clients get an OpenAI-shaped normalized error too.
  const openAiRate = await post("/v1/chat/completions", {
    model: "test-rate-openai",
    stream: true,
    messages: [{ role: "user", content: "x" }]
  });
  const openAiRateJson = await openAiRate.json();
  assert.equal(openAiRate.status, 429);
  assert.equal(openAiRateJson.error.code, "rate_limit_exceeded");
  assert.equal(openAiRateJson.error.type, "rate_limit_error");

  // Permanent failures must never be disguised as retryable.
  const permanentModel = await post("/v1/messages", {
    model: "test-permanent-model",
    max_tokens: 8,
    stream: true,
    messages: [{ role: "user", content: "x" }]
  });
  assert.equal(permanentModel.status, 403);
  assert.equal(permanentModel.headers.get("x-proxy-classification"), "permanent-pattern");

  const tooLarge = await post("/v1/messages", {
    model: "test-413",
    max_tokens: 8,
    stream: true,
    messages: [{ role: "user", content: "x" }]
  });
  assert.equal(tooLarge.status, 413);
  assert.notEqual(tooLarge.status, 429);

  // Retryable HTML/server junk is converted to valid JSON while keeping 5xx.
  const html500 = await post("/v1/messages", {
    model: "test-500-html",
    max_tokens: 8,
    stream: true,
    messages: [{ role: "user", content: "x" }]
  });
  const html500Json = await html500.json();
  assert.equal(html500.status, 500);
  assert.equal(html500.headers.get("retry-after"), "11");
  assert.match(html500.headers.get("content-type"), /application\/json/);
  assert.equal(html500Json.error.type, "api_error");

  // Empty 200 SSE is recovered before response headers are committed.
  const empty = await post("/v1/messages", {
    model: "test-empty",
    max_tokens: 8,
    stream: true,
    messages: [{ role: "user", content: "x" }]
  });
  const emptyJson = await empty.json();
  assert.equal(empty.status, 503);
  assert.equal(empty.headers.get("retry-after"), "11");
  assert.equal(empty.headers.get("x-proxy-classification"), "empty-stream");
  assert.match(emptyJson.error.message, /empty SSE stream/i);

  // A transient SSE error inside HTTP 200 is normalized before first token.
  const sseError = await post("/v1/messages", {
    model: "test-sse-error",
    max_tokens: 8,
    stream: true,
    messages: [{ role: "user", content: "x" }]
  });
  const sseErrorJson = await sseError.json();
  assert.equal(sseError.status, 503);
  assert.match(sseErrorJson.error.message, /overloaded/i);

  // The same SSE error is classified the same way when the client did not ask
  // for a stream. The proxy is collecting the gateway's stream on its behalf, so
  // both paths run one shared rule instead of two that can drift apart -- here
  // the only transient signal is the error type, not any phrase in the message.
  for (const stream of [true, false]) {
    const typedSseError = await post("/v1/messages", {
      model: "test-sse-error-typed",
      max_tokens: 8,
      stream,
      messages: [{ role: "user", content: "x" }]
    });
    const typedSseErrorJson = await typedSseError.json();
    assert.equal(typedSseError.status, 503, `overloaded_error must be retryable with stream=${stream}`);
    assert.equal(typedSseErrorJson.error.message, "pick a different model");
  }
  await new Promise((resolve) => setTimeout(resolve, 120));

  // Anthropic token-count passthrough.
  const tokenCount = await post("/v1/messages/count_tokens", {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(tokenCount.status, 200);
  assert.deepEqual(await tokenCount.json(), { input_tokens: 123 });

  // Invalid JSON is a client 400, not a fake proxy 502.
  const invalidJson = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: authHeaders,
    body: "{broken"
  });
  assert.equal(invalidJson.status, 400);

  // -------------------------------------------------------------------------
  // Host guard. This proxy is meant to sit on a public address, so it answers
  // only for the hostnames it was configured with, and it decides that before it
  // does anything else. Every case here uses the raw client: fetch() will not
  // let a caller set Host.
  // -------------------------------------------------------------------------
  const guardBody = { model: "claude-opus-4-8", max_tokens: 8, messages: [{ role: "user", content: "x" }] };

  // A name that resolves to this address but is not in ALLOWED_HOSTS is refused.
  // This is the shape a DNS rebinding page arrives in, and the shape of a stray
  // virtual host pointed at the port by someone scanning for one.
  assertForbidden(
    await rawRequest({ method: "POST", path: "/v1/messages", headers: { ...authHeaders, host: "evil.com" }, body: guardBody }),
    "evil.com",
    "a Host outside ALLOWED_HOSTS"
  );

  // The configured host takes the ordinary path all the way through to upstream:
  // the guard is a filter, not a wrapper that changes what a served request does.
  const allowedHost = await rawRequest({
    method: "POST",
    path: "/v1/messages",
    headers: { ...authHeaders, host: `127.0.0.1:${proxyPort}` },
    body: guardBody
  });
  assert.equal(allowedHost.status, 200, `an allow-listed Host must be served: ${allowedHost.text}`);
  assert.match(allowedHost.text, /"text":"OK"/);

  // Matching is on hostname alone, so the second allow-list entry works and the
  // port in the Host header is ignored. That is deliberate: with Docker the
  // published port routinely differs from the one the server bound inside the
  // container, and which port a request arrived on is already settled by which
  // socket accepted it.
  const allowedOtherPort = await rawRequest({
    method: "POST",
    path: "/v1/messages",
    headers: { ...authHeaders, host: "localhost:9999" },
    body: guardBody
  });
  assert.equal(allowedOtherPort.status, 200, `hostname matching must ignore the port: ${allowedOtherPort.text}`);

  // Host matching is case-insensitive: ALLOWED_HOSTS is lowercased at startup
  // and the request hostname is lowercased before comparison, so an uppercase
  // Host reaches the same decision -- and the same upstream -- as its lowercase
  // form. Without this the guard would be a bypass waiting on a capital letter.
  const uppercaseHost = await rawRequest({
    method: "POST",
    path: "/v1/messages",
    headers: { ...authHeaders, host: "LOCALHOST:9999" },
    body: guardBody
  });
  assert.equal(uppercaseHost.status, 200, `an uppercase allow-listed Host must be served: ${uppercaseHost.text}`);

  // Userinfo smuggling: everything before "@" is credentials, so this request is
  // really addressed to evil.com. Parsing the Host instead of splitting it on
  // ":" is what collapses it to the hostname routing would actually use.
  assertForbidden(
    await rawRequest({ method: "POST", path: "/v1/messages", headers: { ...authHeaders, host: "127.0.0.1@evil.com" }, body: guardBody }),
    "127.0.0.1@evil.com",
    "userinfo smuggled into Host"
  );

  // Garbage no parser can turn into a hostname is a rejection, not a 500: the
  // guard treats a throw as a refusal rather than letting it reach the handler.
  assertForbidden(
    await rawRequest({ method: "POST", path: "/v1/messages", headers: { ...authHeaders, host: "::::" }, body: guardBody }),
    "::::",
    "an unparseable Host"
  );

  // A request with no Host header at all never reaches the guard. Node's own
  // server runs with requireHostHeader on, so an HTTP/1.1 request without one is
  // answered 400 by the HTTP parser before the request handler is called. It is
  // still rejected -- just one layer below this proxy, which is why the expected
  // status is 400 and why this rejection is not counted in stats.hostRejected.
  const missingHost = await rawRequest({
    method: "POST",
    path: "/v1/messages",
    omitHost: true,
    headers: authHeaders,
    body: guardBody
  });
  assert.equal(missingHost.status, 400, `a request with no Host header must be rejected, got ${missingHost.status}`);

  // No CLI client sends Origin or Sec-Fetch-Site and a browser always sends at
  // least one, so their presence means a page is driving the request. Refusing
  // them is the other half of the rebinding defence: an attacker's page can aim
  // a name at this address, but it cannot make the browser drop these headers.
  assertForbidden(
    await rawRequest({
      method: "POST",
      path: "/v1/messages",
      headers: { ...authHeaders, host: `127.0.0.1:${proxyPort}`, origin: "https://evil.example" },
      body: guardBody
    }),
    "https://evil.example",
    "a browser Origin"
  );
  assertForbidden(
    await rawRequest({
      method: "POST",
      path: "/v1/messages",
      headers: { ...authHeaders, host: `127.0.0.1:${proxyPort}`, "sec-fetch-site": "cross-site" },
      body: guardBody
    }),
    "cross-site",
    "a browser Sec-Fetch-Site"
  );

  // The guard runs before authentication, so a wrong host with no credentials is
  // 403 and never reaches the key comparison. If auth ran first this would be
  // 401, which would confirm to a prober that an API lives here at all.
  const evilNoAuth = await rawRequest({
    method: "POST",
    path: "/v1/messages",
    headers: { "content-type": "application/json", host: "evil.com" },
    body: guardBody
  });
  assert.notEqual(evilNoAuth.status, 401, "the host guard must run before auth, not after");
  assertForbidden(evilNoAuth, "evil.com", "an unauthenticated request from a rejected host");

  // Rejected probes must not grow the trace file: the public server returns
  // before the trace tap is wired, and the health listener never traces at all.
  // A prober who can read the trace should learn nothing about which hosts or
  // browser headers this proxy refuses, so the file size is captured here and
  // checked unchanged after a burst of rejections on both listeners.
  const traceSizeBeforeProbes = fs.statSync(traceFilePath).size;
  assertForbidden(
    await rawRequest({ method: "POST", path: "/v1/messages", headers: { ...authHeaders, host: "evil.com" }, body: guardBody }),
    "evil.com",
    "a host-rejected probe on the public port"
  );
  assertForbidden(
    await rawRequest({ method: "POST", path: "/v1/messages", headers: { ...authHeaders, host: `127.0.0.1:${proxyPort}`, "sec-fetch-site": "cross-site" }, body: guardBody }),
    "cross-site",
    "a Sec-Fetch-Site probe on the public port"
  );
  assertForbidden(
    await rawRequest({ path: "/health", port: healthPort, headers: { host: "evil.com" } }),
    "evil.com",
    "a host-rejected probe on the health port"
  );
  assert.equal(fs.statSync(traceFilePath).size, traceSizeBeforeProbes, "host-rejected requests left trace file entries");

  // -------------------------------------------------------------------------
  // Priority-ordered failover. Each failure case starts after the short test
  // cooldown so the primary is eligible; cooldown behavior itself is asserted
  // separately below.
  // -------------------------------------------------------------------------
  const waitForCooldown = () => new Promise((resolve) => setTimeout(resolve, 120));
  await waitForCooldown();

  const failover500 = await post("/v1/messages", {
    model: "test-failover-500",
    max_tokens: 8,
    messages: [{ role: "user", content: "x" }]
  });
  assert.equal(failover500.status, 200);
  assert.equal(failover500.headers.get("x-proxy-upstream"), "secondary");
  assert.match(await failover500.text(), /SECONDARY/);

  const primaryBeforeCooldownSkip = captured.length;
  const cooldownSkip = await post("/v1/messages", {
    model: "claude-opus-4-8",
    max_tokens: 8,
    messages: [{ role: "user", content: "x" }]
  });
  assert.equal(cooldownSkip.headers.get("x-proxy-upstream"), "secondary");
  assert.equal(captured.length, primaryBeforeCooldownSkip, "a cooling primary was retried");

  await waitForCooldown();
  const expiredCooldown4xx = await post("/v1/messages", {
    model: "test-no-failover-429",
    max_tokens: 8,
    messages: [{ role: "user", content: "x" }]
  });
  assert.equal(expiredCooldown4xx.status, 429);
  const healthAfter4xx = await (await fetch(`http://127.0.0.1:${healthPort}/health`)).json();
  assert.equal(healthAfter4xx.upstreams[0].cooling, false);
  assert.equal(typeof healthAfter4xx.upstreams[0].cool_until, "number", "a delivered 4xx cleared cooldown state");

  const primaryBeforeExpiry = captured.length;
  const cooldownExpired = await post("/v1/messages", {
    model: "claude-opus-4-8",
    max_tokens: 8,
    messages: [{ role: "user", content: "x" }]
  });
  assert.equal(cooldownExpired.headers.get("x-proxy-upstream"), "primary");
  assert.equal(captured.length, primaryBeforeExpiry + 1);
  const healthAfterSuccess = await (await fetch(`http://127.0.0.1:${healthPort}/health`)).json();
  assert.equal(healthAfterSuccess.upstreams[0].cool_until, null);

  await post("/v1/messages", {
    model: "test-failover-500",
    max_tokens: 8,
    messages: [{ role: "user", content: "x" }]
  });
  await waitForCooldown();
  const primaryBeforeConcurrentExpiry = captured.length;
  const concurrentExpiry = await Promise.all(Array.from({ length: 4 }, () => post("/v1/messages", {
    model: "claude-opus-4-8",
    max_tokens: 8,
    messages: [{ role: "user", content: "x" }]
  })));
  assert.ok(concurrentExpiry.every((response) => response.headers.get("x-proxy-upstream") === "primary"));
  assert.equal(captured.length, primaryBeforeConcurrentExpiry + 4);

  for (const [model, expectedStatus] of [["test-no-failover-429", 429], ["test-no-failover-400", 400], ["test-rate", 429]]) {
    const backupBefore = secondaryCaptured.length + thirdCaptured.length;
    const response = await post("/v1/messages", {
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "x" }]
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get("x-proxy-upstream"), "primary");
    assert.equal(secondaryCaptured.length + thirdCaptured.length, backupBefore, `${model} incorrectly failed over`);
  }

  for (const [model, stream] of [["test-failover-before-first", true], ["test-failover-empty-stream", true], ["test-failover-empty-complete", false], ["test-failover-sse-503", true]]) {
    await waitForCooldown();
    const response = await post("/v1/messages", {
      model,
      max_tokens: 8,
      stream,
      messages: [{ role: "user", content: "x" }]
    });
    assert.equal(response.status, 200, `${model} did not fail over`);
    assert.equal(response.headers.get("x-proxy-upstream"), "secondary");
    assert.match(await response.text(), /SECONDARY/);
  }

  await waitForCooldown();
  const backupBeforeSse429 = secondaryCaptured.length + thirdCaptured.length;
  const sse429 = await post("/v1/messages", {
    model: "test-no-failover-sse-429",
    max_tokens: 8,
    stream: true,
    messages: [{ role: "user", content: "x" }]
  });
  assert.equal(sse429.status, 429);
  assert.equal(sse429.headers.get("x-proxy-upstream"), "primary");
  assert.equal(secondaryCaptured.length + thirdCaptured.length, backupBeforeSse429);

  await waitForCooldown();
  const backupBeforePartial = secondaryCaptured.length + thirdCaptured.length;
  const partial = await post("/v1/messages", {
    model: "test-failover-after-first",
    max_tokens: 8,
    stream: true,
    messages: [{ role: "user", content: "x" }]
  });
  assert.equal(partial.status, 200);
  assert.equal(partial.headers.get("x-proxy-upstream"), "primary");
  await assert.rejects(partial.text());
  assert.equal(secondaryCaptured.length + thirdCaptured.length, backupBeforePartial, "a committed stream failed over");

  for (const [path, payload] of [
    ["/v1/chat/completions", { model: "test-failover-chat", stream: true, messages: [{ role: "user", content: "x" }] }],
    ["/v1/responses", { model: "test-failover-responses", input: "x", stream: true }]
  ]) {
    await waitForCooldown();
    const response = await post(path, payload);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-proxy-upstream"), "secondary");
  }

  await waitForCooldown();
  const modelsFailover = await fetch(`http://127.0.0.1:${proxyPort}/v1/models?failprimary=1`, { headers: { authorization: `Bearer ${localKey}` } });
  assert.equal(modelsFailover.status, 200);
  assert.equal(modelsFailover.headers.get("x-proxy-upstream"), "secondary");
  assert.equal((await modelsFailover.json()).served_by, "secondary");

  await waitForCooldown();
  const allDown = await post("/v1/chat/completions", {
    model: "test-all-down",
    stream: false,
    messages: [{ role: "user", content: "x" }]
  });
  assert.equal(allDown.status, 500);
  assert.equal(allDown.headers.get("x-proxy-upstream"), "third");
  assert.equal((await allDown.json()).error.type, "api_error");

  await waitForCooldown();
  const secondaryBeforeDestroyedResponse = secondaryCaptured.length;
  const destroyedResponse = await post("/v1/messages", {
    model: "test-destroy-prior",
    max_tokens: 8,
    messages: [{ role: "user", content: "x" }]
  });
  assert.equal(destroyedResponse.headers.get("x-proxy-upstream"), "secondary");
  await failedResponseDestroyed;
  assert.equal(secondaryCaptured.length, secondaryBeforeDestroyedResponse + 1, "backup started before the failed response was destroyed");
  assert.deepEqual(lifecycleEvents, ["primary-response-destroyed", "secondary-request-started"]);

  await waitForCooldown();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  try {
    const refused = await post("/v1/messages", {
      model: "claude-opus-4-8",
      max_tokens: 8,
      messages: [{ role: "user", content: "x" }]
    });
    assert.equal(refused.status, 200);
    assert.equal(refused.headers.get("x-proxy-upstream"), "secondary");
  } finally {
    await new Promise((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(upstreamPort, "127.0.0.1", () => {
        upstream.off("error", reject);
        resolve();
      });
    });
  }

  await waitForCooldown();
  const backupBeforeAbort = secondaryCaptured.length + thirdCaptured.length;
  const abortRequest = http.request({
    hostname: "127.0.0.1",
    port: proxyPort,
    path: "/v1/messages",
    method: "POST",
    headers: { ...authHeaders, host: `127.0.0.1:${proxyPort}` }
  });
  abortRequest.on("error", () => {});
  abortRequest.end(JSON.stringify({
    model: "test-client-abort",
    max_tokens: 8,
    stream: true,
    messages: [{ role: "user", content: "x" }]
  }));
  await clientAbortStarted;
  abortRequest.destroy();
  await clientAbortClosed;
  assert.equal(secondaryCaptured.length + thirdCaptured.length, backupBeforeAbort, "a client abort triggered failover");

  await waitForCooldown();

  // -------------------------------------------------------------------------
  // Health moved off the public port onto its own loopback-only listener.
  // -------------------------------------------------------------------------

  // On the main port /health is now an ordinary unserved path, and the 404 text
  // -- generated from the route table -- no longer advertises that it exists.
  const mainPortHealth = await fetch(`http://127.0.0.1:${proxyPort}/health`);
  assert.equal(mainPortHealth.status, 404);
  const mainPortHealthJson = await mainPortHealth.json();
  assert.equal(mainPortHealthJson.error.type, "not_found");
  assert.doesNotMatch(mainPortHealthJson.error.message, /health/i);

  // Docker's HEALTHCHECK runs inside the container and may write the request
  // target however it likes, so a query string has to answer like a bare path.
  const probeQuery = await fetch(`http://127.0.0.1:${healthPort}/health?probe=1`);
  assert.equal(probeQuery.status, 200);
  assert.equal((await probeQuery.json()).ok, true);

  // The same guard runs on the health listener, against a hardcoded loopback
  // list rather than ALLOWED_HOSTS: nothing an operator puts in that variable
  // can widen an endpoint meant to be reachable from inside the container only.
  assertForbidden(
    await rawRequest({ path: "/health", port: healthPort, headers: { host: "evil.com" } }),
    "evil.com",
    "a non-loopback Host on the health port"
  );

  // Nothing but GET /health lives on that listener; it is not a second API.
  const healthPost = await rawRequest({ method: "POST", path: "/health", port: healthPort, body: {} });
  assert.equal(healthPost.status, 404);
  assert.equal(JSON.parse(healthPost.text).error.type, "not_found");

  // The listener answers exactly GET /health. A trailing slash, an extra path
  // segment, or a non-GET method all fall through to the same 404 every other
  // unserved target gets, so nothing about the health endpoint leaks through a
  // near-miss. HEAD is checked by status only: Node sends no body for HEAD, so
  // parsing one would assert against an empty string.
  const healthHead = await rawRequest({ method: "HEAD", path: "/health", port: healthPort });
  assert.equal(healthHead.status, 404, "HEAD /health must not be served");
  const healthTrailingSlash = await rawRequest({ path: "/health/", port: healthPort });
  assert.equal(healthTrailingSlash.status, 404);
  assert.equal(JSON.parse(healthTrailingSlash.text).error.type, "not_found");
  const healthExtra = await rawRequest({ path: "/health/extra", port: healthPort });
  assert.equal(healthExtra.status, 404);
  assert.equal(JSON.parse(healthExtra.text).error.type, "not_found");
  // A query string of any length is ignored, not just a single key=value pair,
  // so Docker's HEALTHCHECK can write the target however it likes.
  const healthMultiQuery = await fetch(`http://127.0.0.1:${healthPort}/health?probe=1&x=2`);
  assert.equal(healthMultiQuery.status, 200);
  assert.equal((await healthMultiQuery.json()).ok, true);

  // IPv6 loopback is bracketed in loopbackHosts because that is the form
  // new URL() produces for an IPv6 authority, and matching runs on its output.
  // A health probe that arrives with a bracketed IPv6 Host -- with or without a
  // port -- is accepted, pinning the bracket handling against a future drift.
  const ipv6Health = await rawRequest({ path: "/health", port: healthPort, headers: { host: "[::1]" } });
  assert.equal(ipv6Health.status, 200, `a bracketed IPv6 loopback Host must be served on the health port: ${ipv6Health.text}`);
  const ipv6HealthPort = await rawRequest({ path: "/health", port: healthPort, headers: { host: `[::1]:${healthPort}` } });
  assert.equal(ipv6HealthPort.status, 200, `a bracketed IPv6 loopback Host with a port must be served on the health port: ${ipv6HealthPort.text}`);

  // Health carries no credentials at all, which is only safe because the socket
  // is bound to 127.0.0.1 rather than to HOST: on 0.0.0.0 this would publish
  // uptime, the upstream origin and traffic counters to the whole internet.
  const healthResponse = await fetch(`http://127.0.0.1:${healthPort}/health`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(Object.keys(health).sort(), ["node", "ok", "stats", "upstreams", "uptime_seconds", "version"]);
  assert.equal(health.ok, true);
  assert.equal(health.version, "5.0.0");
  assert.equal(health.node, process.version);
  assert.deepEqual(health.upstreams.map(({ name, origin }) => ({ name, origin })), [
    { name: "primary", origin: `http://127.0.0.1:${upstreamPort}` },
    { name: "secondary", origin: `http://127.0.0.1:${secondaryPort}` },
    { name: "third", origin: `http://127.0.0.1:${thirdPort}` }
  ]);
  assert.ok(health.upstreams.every((entry) => !Object.hasOwn(entry, "api_key")));
  assert.ok(health.stats.normalizedTo429 >= 2);
  assert.ok(health.stats.droppedSseFrames >= 5);
  assert.ok(health.stats.emptyStreamsRecovered >= 1);
  assert.ok(health.stats.authRejected >= 1);

  // Exact rather than a floor: the suite is hermetic, so the requests it made are
  // every request this process has ever seen. An extra rejection here would mean
  // the guard turned away something the suite expected to be served, and a
  // missing one would mean a rejection was answered without being recorded.
  assert.equal(health.stats.hostRejected, hostRejectionsCaused);

  // Inspect actual upstream wire image: the streamed /v1/messages call above,
  // found by the index taken just before it was made rather than by assuming it
  // is the first request the gateway ever saw.
  const first = captured[streamedIndex];

  // The proxy owns auth: the local key never reaches the upstream in any form.
  assert.equal(first.headers.authorization, `Bearer ${testApiKey}`);
  assert.notEqual(first.headers.authorization, `Bearer ${localKey}`);
  assert.equal(first.headers["x-api-key"], undefined);
  assert.equal(first.headers.host, `127.0.0.1:${upstreamPort}`);

  // Client headers are forwarded verbatim rather than stripped: the gateway sees
  // the caller's own identity, never one synthesized on its behalf.
  assert.equal(first.headers["user-agent"], "claude-cli/2.1.233 (external, cli)");
  assert.equal(first.headers["x-stainless-retry-count"], "0");
  assert.equal(first.headers["x-stainless-timeout"], "60");
  assert.equal(first.headers["x-custom-client-header"], "forward-me");

  // For a client that sent its own identity, the only headers filled in are the
  // two the gateway requires before it will answer at all.
  assert.equal(first.headers["anthropic-version"], "2023-06-01");
  assert.equal(first.headers["content-type"], "application/json");

  // Nothing is invented for headers the client did not send.
  assert.equal(first.headers["x-stainless-os"], undefined);
  assert.equal(first.headers["x-stainless-arch"], undefined);
  assert.equal(first.headers["x-stainless-package-version"], undefined);
  assert.equal(first.headers["x-app"], undefined);

  // ...but a bare client that sends neither still gets a usable request upstream:
  // the synthesized User-Agent plus the content-type and anthropic-version the
  // gateway requires. This is the only path these defaults exist for, and the raw
  // client is how the suite gets to be that bare -- fetch() always signs its own
  // requests with a User-Agent.
  const bareResponse = await rawRequest({
    method: "POST",
    path: "/v1/messages",
    headers: { authorization: `Bearer ${localKey}` },
    body: { model: "claude-opus-4-8", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }
  });
  assert.equal(bareResponse.status, 200, `bare client got ${bareResponse.status}: ${bareResponse.text}`);
  const bare = captured.at(-1);
  assert.equal(bare.headers["user-agent"], "claude-cli/0.0.0-test (external, sdk-cli)");
  assert.equal(bare.headers["anthropic-version"], "2023-06-01");
  assert.equal(bare.headers["content-type"], "application/json");
  assert.equal(bare.headers["x-stainless-os"], undefined);

  assert.equal(first.headers["x-claude-code-session-id"], preservedSession);
  assert.ok(first.headers["anthropic-beta"].includes("claude-code-20250219"));
  assert.ok(first.headers["anthropic-beta"].includes("context-1m-2025-08-07"));
  assert.ok(first.headers["anthropic-beta"].includes("custom-beta-2099-01-01"));
  assert.equal(first.headers["accept-encoding"], "identity");
  assert.match(first.url, /^\/v1\/messages\?beta=true$/);

  // -------------------------------------------------------------------------
  // The trace file. It holds whole prompts and completions in plaintext and it
  // records the headers of both legs, so both API keys pass through it.
  // -------------------------------------------------------------------------

  // Owner-only on disk: on a shared host, mode 0644 would hand every local
  // account the conversations this proxy carried.
  const traceMode = fs.statSync(traceFilePath).mode & 0o777;
  assert.equal(traceMode, 0o600, `trace file mode is 0${traceMode.toString(8)}, expected 0600`);

  const traceText = fs.readFileSync(traceFilePath, "utf8");

  // Rejected Host and browser-header values never reach the trace: the guard
  // returns before the trace tap is wired on the public server, and the health
  // listener never traces. A prober cannot read back what was refused.
  assert.ok(!traceText.includes("evil.com"), "a rejected Host value leaked into the trace");
  assert.ok(!traceText.includes("evil.example"), "a rejected Origin value leaked into the trace");
  assert.ok(!traceText.includes("cross-site"), "a rejected Sec-Fetch-Site value leaked into the trace");

  // The markers prove redaction actually ran on both legs. Without them, the
  // absence assertions below would also pass on an empty or truncated file.
  for (const name of ["primary", "secondary", "third"]) {
    assert.ok(traceText.includes(`[REDACTED:UPSTREAM:${name}]`), `${name} key was never redacted in the trace`);
  }
  assert.ok(traceText.includes("[REDACTED:LOCAL_PROXY_KEY]"), "local key was never redacted in the trace");

  // Not one character of either secret survives. A marker that kept even a short
  // prefix -- the usual "sk-abc…" courtesy -- would hand anyone who can read this
  // file a head start on the key it is there to protect.
  for (const [name, secret] of [["primary api_key", testApiKey], ["secondary api_key", secondaryApiKey], ["third api_key", thirdApiKey], ["LOCAL_PROXY_KEY", localKey]]) {
    assert.ok(!traceText.includes(secret), `${name} appears verbatim in the trace`);
    assert.ok(!traceText.includes(secret.slice(0, 6)), `a prefix of ${name} appears in the trace`);
    assert.ok(!stdout.includes(secret), `${name} appears verbatim in stdout`);
    assert.ok(!stderr.includes(secret), `${name} appears verbatim in stderr`);
  }

  // -------------------------------------------------------------------------
  // Startup configuration. Every case below dies inside config validation.
  // -------------------------------------------------------------------------

  // Startup refuses to run on an incomplete environment, and names every
  // offending variable in one pass instead of one restart per variable.
  const missingVars = await runProxyToExit(envWithout("LOCAL_PROXY_KEY", "UPSTREAM_TIMEOUT_MS"));
  assert.notEqual(missingVars.code, 0);
  assert.match(missingVars.stderr, /LOCAL_PROXY_KEY/);
  assert.match(missingVars.stderr, /UPSTREAM_TIMEOUT_MS/);
  assert.match(missingVars.stderr, /2 configuration problems/);
  assert.equal(missingVars.stdout, "");

  // The two variables the guard and the health listener need are required like
  // every other one. Neither may acquire a default: guessing an allow-list or a
  // health port would quietly restore the exposure this pair exists to close.
  const missingGuardVars = await runProxyToExit(envWithout("ALLOWED_HOSTS", "HEALTH_PORT"));
  assert.notEqual(missingGuardVars.code, 0);
  assert.match(missingGuardVars.stderr, /ALLOWED_HOSTS/);
  assert.match(missingGuardVars.stderr, /HEALTH_PORT/);
  assert.match(missingGuardVars.stderr, /2 configuration problems/);

  // Comparisons between variables may only run once both sides have actually
  // parsed. With PORT and HEALTH_PORT both unset the report must be exactly the
  // two "not set" problems: a bare `values.PORT === values.HEALTH_PORT` finds
  // undefined equal to undefined and adds a third problem saying the two ports
  // collide, which is untrue and sends the operator hunting for a port conflict
  // instead of reading the two real problems above it.
  const bothPortsMissing = await runProxyToExit(envWithout("PORT", "HEALTH_PORT"));
  assert.notEqual(bothPortsMissing.code, 0);
  assert.match(bothPortsMissing.stderr, /2 configuration problems/);
  assert.doesNotMatch(bothPortsMissing.stderr, /a port of its own/);

  // Health needs a port of its own; sharing PORT would put the counters and the
  // upstream origin it publishes straight back onto the public address.
  const clashingPorts = await runProxyToExit(envWith({ HEALTH_PORT: proxyEnv.PORT }));
  assert.notEqual(clashingPorts.code, 0);
  assert.match(clashingPorts.stderr, /HEALTH_PORT: expected a port of its own/);
  assert.match(clashingPorts.stderr, /1 configuration problem\./);

  // The local key is the only thing between the open internet and a paid
  // upstream credential, so it has to be generated rather than chosen. A short
  // placeholder is refused, and the operator is handed the command that produces
  // an acceptable one instead of being left to guess at the floor.
  const shortLocalKey = await runProxyToExit(envWith({ LOCAL_PROXY_KEY: "sk-dummy" }));
  assert.notEqual(shortLocalKey.code, 0);
  assert.match(shortLocalKey.stderr, /LOCAL_PROXY_KEY: expected at least 32 characters/);
  assert.match(shortLocalKey.stderr, /openssl rand -base64 32/);
  assert.match(shortLocalKey.stderr, /1 configuration problem\./);
  assert.doesNotMatch(shortLocalKey.stderr, /sk-dummy/);

  // Reusing the upstream credential as the client-facing key would hand it to
  // every client that connects, which is the one outcome the split prevents.
  const reusedKey = await runProxyToExit(envWith({ LOCAL_PROXY_KEY: testApiKey }));
  assert.notEqual(reusedKey.code, 0);
  assert.match(reusedKey.stderr, /UPSTREAMS_FILE\[0\]\.api_key: expected a secret different from LOCAL_PROXY_KEY/);
  assert.match(reusedKey.stderr, /1 configuration problem\./);
  assert.ok(!reusedKey.stderr.includes(testApiKey.slice(0, 6)), "the rejected key leaked into stderr");

  const missingUpstreams = await runProxyToExit(envWith({ UPSTREAMS_FILE: join(tmpdir(), `proxy-test-missing-${process.pid}.json`) }));
  assert.notEqual(missingUpstreams.code, 0);
  assert.match(missingUpstreams.stderr, /UPSTREAMS_FILE: expected a readable regular JSON file/);

  const upstreamDirectory = fs.mkdtempSync(join(tmpdir(), `proxy-test-upstreams-dir-${process.pid}-`));
  validationPaths.push(upstreamDirectory);
  const directoryUpstreams = await runProxyToExit(envWith({ UPSTREAMS_FILE: upstreamDirectory }));
  assert.notEqual(directoryUpstreams.code, 0);
  assert.match(directoryUpstreams.stderr, /is not a regular file/);

  const malformedUpstreams = await runProxyToExit(envWithUpstreams("{broken"));
  assert.notEqual(malformedUpstreams.code, 0);
  assert.match(malformedUpstreams.stderr, /expected valid JSON/);

  const emptyUpstreams = await runProxyToExit(envWithUpstreams([]));
  assert.notEqual(emptyUpstreams.code, 0);
  assert.match(emptyUpstreams.stderr, /expected a non-empty JSON array/);

  const duplicateName = await runProxyToExit(envWithUpstreams([
    { name: "same", base_url: "https://one.example", api_key: "DuplicateKeyOne" },
    { name: "same", base_url: "https://two.example", api_key: "DuplicateKeyTwo" }
  ]));
  assert.notEqual(duplicateName.code, 0);
  assert.match(duplicateName.stderr, /expected a unique name/);

  const badBaseUrl = await runProxyToExit(envWithUpstreams([
    { name: "bad-url", base_url: "ftp://gateway.example", api_key: "ValidKeyForBadUrl" }
  ]));
  assert.notEqual(badBaseUrl.code, 0);
  assert.match(badBaseUrl.stderr, /UPSTREAMS_FILE\[0\]\.base_url: expected an absolute http:\/\/ or https:\/\/ URL/);

  // The upstream key has a floor of its own, low enough for the short keys some
  // gateways issue but high enough to catch a truncated paste.
  const shortSecret = "Ry3tiny";
  const shortUpstreamKey = await runProxyToExit(envWithUpstreams([
    { name: "short-key", base_url: "https://gateway.example", api_key: shortSecret }
  ]));
  assert.notEqual(shortUpstreamKey.code, 0);
  assert.match(shortUpstreamKey.stderr, /UPSTREAMS_FILE\[0\]\.api_key: expected at least 8 printable ASCII characters/);
  assert.match(shortUpstreamKey.stderr, /1 configuration problem\./);
  assert.doesNotMatch(shortUpstreamKey.stderr, new RegExp(shortSecret));

  // Present but unusable fails the same way, and a rejected secret is never
  // echoed back into stderr -- stderr ends up in container logs. This value is
  // long enough to clear the 32-character floor and still fails, because it
  // carries a newline: a control character is refused on its own, since the
  // value ends up in an HTTP header. Keeping it above the floor is what makes
  // the control-character rule the thing under test here rather than the length.
  const invalidVars = await runProxyToExit(envWith({
    PORT: "abc",
    PROXY_TRACE: "1",
    LOCAL_PROXY_KEY: "Wq5leakyEmbeddedNewlineSecretPad\nTail"
  }));
  assert.notEqual(invalidVars.code, 0);
  assert.match(invalidVars.stderr, /PORT: expected an integer between 1 and 65535, got "abc"/);
  assert.match(invalidVars.stderr, /PROXY_TRACE: expected exactly "true" or "false"/);
  assert.match(invalidVars.stderr, /LOCAL_PROXY_KEY/);
  // Exactly the three variables this case broke, and no fourth: what is reported
  // has to be the injected failures themselves, not a knock-on problem derived
  // from one of them.
  assert.match(invalidVars.stderr, /3 configuration problems/);
  assert.doesNotMatch(invalidVars.stderr, /leaky/);

  const validationOutput = validationOutputs.map(({ stdout: childStdout, stderr: childStderr }) => `${childStdout}\n${childStderr}`).join("\n");
  for (const secret of [testApiKey, secondaryApiKey, thirdApiKey, "DuplicateKeyOne", "DuplicateKeyTwo", "ValidKeyForBadUrl", shortSecret]) {
    assert.ok(!validationOutput.includes(secret), `api_key ${secret.slice(0, 4)}... leaked during validation`);
  }

  console.log(`All Local API Proxy v${health.version} tests passed (${captured.length} upstream requests).`);
} finally {
  for (const lingering of lingeringResponses) {
    try { lingering.end(); } catch {}
  }
  proxy.kill("SIGTERM");
  upstream.close();
  secondary.close();
  third.close();
  try { fs.rmSync(traceFilePath, { force: true }); } catch {}
  try { fs.rmSync(upstreamsFilePath, { force: true }); } catch {}
  for (const validationPath of validationPaths) {
    try { fs.rmSync(validationPath, { force: true, recursive: true }); } catch {}
  }
}
