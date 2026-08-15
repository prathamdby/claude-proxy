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
const localKey = "Kd4localProxySharedSecretForTests7Wm";
const captured = [];
const lingeringResponses = [];
const preservedSession = "123e4567-e89b-42d3-a456-426614174000";

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

function writeOpenAiToolStream(res) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunks = [
    {
      id: "chat_tool", object: "chat.completion.chunk", model: "glm-5.2",
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_weather", type: "function", function: { name: "get_weather", arguments: '{"city":' } }] }, finish_reason: null }]
    },
    {
      id: "chat_tool", object: "chat.completion.chunk", model: "glm-5.2",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Lahore"}' } }] }, finish_reason: null }]
    },
    {
      id: "chat_tool", object: "chat.completion.chunk", model: "glm-5.2",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 }
    }
  ];
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end('data: [DONE]\n\n');
}

const upstream = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch {}
    captured.push({ url: req.url, headers: req.headers, body, payload });

    if (req.url.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 123 }));
      return;
    }

    if (req.url.startsWith("/v1/messages")) {
      switch (payload.model) {
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

    if (req.url.startsWith("/v1/chat/completions")) {
      if (payload.model === "test-rate-openai") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "用户额度不足", type: "gateway_error" } }));
        return;
      }
      if (payload.model === "test-response-tool") {
        writeOpenAiToolStream(res);
        return;
      }
      writeOpenAiStream(res);
      return;
    }

    res.writeHead(404).end();
  });
});

// Two free ports are needed now: the public one and the health listener's. Both
// probes are held open at the same time before either is released, because
// closing the first one before asking for the second lets the kernel hand back
// the same number twice -- and two identical ports is the one combination the
// proxy refuses to start on.
const upstreamPort = await listen(upstream);
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
const proxyEnv = {
  HOST: "127.0.0.1",
  PORT: String(proxyPort),
  HEALTH_PORT: String(healthPort),
  // Both names the suite reaches this proxy under. Everything else, including
  // the DNS-rebinding names a browser could point at 127.0.0.1, is refused.
  ALLOWED_HOSTS: "127.0.0.1,localhost",
  UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
  UPSTREAM_API_KEY: testApiKey,
  LOCAL_PROXY_KEY: localKey,
  CLAUDE_CODE_VERSION: "0.0.0-test",
  UPSTREAM_MODEL: "claude-opus-4-8",
  UPSTREAM_TIMEOUT_MS: "300000",
  RETRY_AFTER_SECONDS: "11",
  MAX_BODY_BYTES: "26214400",
  RESPONSES_STORE_MAX: "128",
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
      resolve({ code: null, stdout, stderr: String(error) });
    });
    child.once("close", (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr: childStderr });
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

try {
  await waitForProxy();

  // Local API auth is enforced, and it runs before routing: an unauthenticated
  // call to a path the proxy does not serve is still 401, not 404.
  const rejected = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
  assert.equal(rejected.status, 401);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.type, "error");

  // The proxy cannot know which models the gateway carries, so it never invents
  // a catalogue: /v1/models is an ordinary 404. The 404 text is generated from
  // the route table, so it can only ever name paths that are actually served.
  const modelsResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
    headers: { authorization: `Bearer ${localKey}` }
  });
  assert.equal(modelsResponse.status, 404);
  const modelsBody = await modelsResponse.json();
  assert.equal(modelsBody.error.type, "not_found");
  assert.doesNotMatch(modelsBody.error.message, /v1\/models/);
  for (const path of ["/v1/messages", "/v1/messages/count_tokens", "/v1/chat/completions", "/v1/responses"]) {
    assert.ok(modelsBody.error.message.includes(`POST ${path}`), `404 text must name ${path}`);
  }

  // Streaming + SSE sanitation + beta merge + session preservation.
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
  const streamedOpenAi = await post("/v1/chat/completions", {
    model: "glm-5.2",
    stream: true,
    messages: [{ role: "user", content: "Reply OK" }]
  });
  const openAiSse = await streamedOpenAi.text();
  assert.equal(streamedOpenAi.status, 200);
  assert.match(openAiSse, /"choices":/);
  assert.match(openAiSse, /\[DONE\]/);
  assert.doesNotMatch(openAiSse, /billing[._]summary/);
  assert.doesNotMatch(openAiSse, /data:\s*null/);

  // Responses API is bridged through upstream Chat Completions (non-streaming).
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
  assert.equal(responseApiJson.output[0].type, "message");
  assert.equal(responseApiJson.output[0].content[0].text, "OK");
  assert.equal(responseApiJson.usage.input_tokens, 3);
  assert.equal(responseApiJson.usage.output_tokens, 1);
  const bridgedRequest = captured[responsesBefore];
  assert.match(bridgedRequest.url, /^\/v1\/chat\/completions/);
  assert.equal(bridgedRequest.payload.stream, true);
  assert.equal(bridgedRequest.payload.max_tokens, 32);
  assert.deepEqual(bridgedRequest.payload.messages.slice(-2), [
    { role: "system", content: "Be concise." },
    { role: "user", content: "Reply OK" }
  ]);

  // previous_response_id replays stored Chat Completions context.
  const previousResponseFollowup = await post("/v1/responses", {
    model: "glm-5.2",
    previous_response_id: responseApiJson.id,
    input: "Again"
  });
  assert.equal(previousResponseFollowup.status, 200);
  const previousFollowupJson = await previousResponseFollowup.json();
  assert.equal(previousFollowupJson.previous_response_id, responseApiJson.id);
  const previousWire = captured.at(-1).payload.messages;
  assert.equal(previousWire.some((message) => message.role === "system" && message.content === "Be concise."), false);
  assert.equal(previousWire.at(-2).role, "assistant");
  assert.equal(previousWire.at(-2).content, "OK");
  assert.equal(previousWire.at(-1).content, "Again");

  // Responses streaming emits typed Responses SSE events, not chat chunks.
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

  // Responses function definitions and tool calls map both directions.
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
    tool_choice: { type: "function", name: "get_weather" },
    text: { format: { type: "json_schema", name: "weather", schema: { type: "object" }, strict: false } }
  });
  const responseToolJson = await responseTool.json();
  assert.equal(responseTool.status, 200);
  assert.equal(responseToolJson.output[0].type, "function_call");
  assert.equal(responseToolJson.output[0].call_id, "call_weather");
  assert.equal(responseToolJson.output[0].name, "get_weather");
  assert.equal(responseToolJson.output[0].arguments, '{"city":"Lahore"}');
  const toolWire = captured.at(-1).payload;
  assert.equal(toolWire.tools[0].function.name, "get_weather");
  assert.equal(toolWire.tool_choice.function.name, "get_weather");
  assert.equal(toolWire.response_format.type, "json_schema");

  // Unsupported Responses-only built-in tools fail explicitly.
  const unsupportedResponsesTool = await post("/v1/responses", {
    model: "glm-5.2",
    input: "search",
    tools: [{ type: "web_search" }]
  });
  assert.equal(unsupportedResponsesTool.status, 400);
  const unsupportedToolJson = await unsupportedResponsesTool.json();
  assert.match(unsupportedToolJson.error.message, /cannot be represented by Chat Completions/i);

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
  assert.deepEqual(Object.keys(health).sort(), ["node", "ok", "stats", "upstream", "uptime_seconds", "version"]);
  assert.equal(health.ok, true);
  assert.equal(health.version, "4.0.0");
  assert.equal(health.node, process.version);
  assert.equal(health.upstream, `http://127.0.0.1:${upstreamPort}`);
  assert.ok(health.stats.normalizedTo429 >= 2);
  assert.ok(health.stats.droppedSseFrames >= 5);
  assert.ok(health.stats.emptyStreamsRecovered >= 1);
  assert.ok(health.stats.authRejected >= 1);
  assert.ok(health.stats.responsesBridged >= 4);
  assert.ok(health.stats.responsesStoreHits >= 1);

  // Exact rather than a floor: the suite is hermetic, so the requests it made are
  // every request this process has ever seen. An extra rejection here would mean
  // the guard turned away something the suite expected to be served, and a
  // missing one would mean a rejection was answered without being recorded.
  assert.equal(health.stats.hostRejected, hostRejectionsCaused);

  // Inspect actual upstream wire image.
  const first = captured[0];

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
  assert.ok(traceText.includes("[REDACTED:UPSTREAM_API_KEY]"), "upstream key was never redacted in the trace");
  assert.ok(traceText.includes("[REDACTED:LOCAL_PROXY_KEY]"), "local key was never redacted in the trace");

  // Not one character of either secret survives. A marker that kept even a short
  // prefix -- the usual "sk-abc…" courtesy -- would hand anyone who can read this
  // file a head start on the key it is there to protect.
  for (const [name, secret] of [["UPSTREAM_API_KEY", testApiKey], ["LOCAL_PROXY_KEY", localKey]]) {
    assert.ok(!traceText.includes(secret), `${name} appears verbatim in the trace`);
    assert.ok(!traceText.includes(secret.slice(0, 6)), `a prefix of ${name} appears in the trace`);
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
  assert.match(missingVars.stderr, /2 environment variable problems/);
  assert.equal(missingVars.stdout, "");

  // The two variables the guard and the health listener need are required like
  // every other one. Neither may acquire a default: guessing an allow-list or a
  // health port would quietly restore the exposure this pair exists to close.
  const missingGuardVars = await runProxyToExit(envWithout("ALLOWED_HOSTS", "HEALTH_PORT"));
  assert.notEqual(missingGuardVars.code, 0);
  assert.match(missingGuardVars.stderr, /ALLOWED_HOSTS/);
  assert.match(missingGuardVars.stderr, /HEALTH_PORT/);
  assert.match(missingGuardVars.stderr, /2 environment variable problems/);

  // Comparisons between variables may only run once both sides have actually
  // parsed. With PORT and HEALTH_PORT both unset the report must be exactly the
  // two "not set" problems: a bare `values.PORT === values.HEALTH_PORT` finds
  // undefined equal to undefined and adds a third problem saying the two ports
  // collide, which is untrue and sends the operator hunting for a port conflict
  // instead of reading the two real problems above it.
  const bothPortsMissing = await runProxyToExit(envWithout("PORT", "HEALTH_PORT"));
  assert.notEqual(bothPortsMissing.code, 0);
  assert.match(bothPortsMissing.stderr, /2 environment variable problems/);
  assert.doesNotMatch(bothPortsMissing.stderr, /a port of its own/);

  // Health needs a port of its own; sharing PORT would put the counters and the
  // upstream origin it publishes straight back onto the public address.
  const clashingPorts = await runProxyToExit(envWith({ HEALTH_PORT: proxyEnv.PORT }));
  assert.notEqual(clashingPorts.code, 0);
  assert.match(clashingPorts.stderr, /HEALTH_PORT: expected a port of its own/);
  assert.match(clashingPorts.stderr, /1 environment variable problem\./);

  // The local key is the only thing between the open internet and a paid
  // upstream credential, so it has to be generated rather than chosen. A short
  // placeholder is refused, and the operator is handed the command that produces
  // an acceptable one instead of being left to guess at the floor.
  const shortLocalKey = await runProxyToExit(envWith({ LOCAL_PROXY_KEY: "sk-dummy" }));
  assert.notEqual(shortLocalKey.code, 0);
  assert.match(shortLocalKey.stderr, /LOCAL_PROXY_KEY: expected at least 32 characters/);
  assert.match(shortLocalKey.stderr, /openssl rand -base64 32/);
  assert.match(shortLocalKey.stderr, /1 environment variable problem\./);
  assert.doesNotMatch(shortLocalKey.stderr, /sk-dummy/);

  // Reusing the upstream credential as the client-facing key would hand it to
  // every client that connects, which is the one outcome the split prevents.
  const reusedKey = await runProxyToExit(envWith({ LOCAL_PROXY_KEY: testApiKey }));
  assert.notEqual(reusedKey.code, 0);
  assert.match(reusedKey.stderr, /LOCAL_PROXY_KEY: expected a secret of its own/);
  assert.match(reusedKey.stderr, /same value as UPSTREAM_API_KEY/);
  assert.match(reusedKey.stderr, /1 environment variable problem\./);
  assert.ok(!reusedKey.stderr.includes(testApiKey.slice(0, 6)), "the rejected key leaked into stderr");

  // The upstream key has a floor of its own, low enough for the short keys some
  // gateways issue but high enough to catch a truncated paste.
  const shortUpstreamKey = await runProxyToExit(envWith({ UPSTREAM_API_KEY: "Ry3tiny" }));
  assert.notEqual(shortUpstreamKey.code, 0);
  assert.match(shortUpstreamKey.stderr, /UPSTREAM_API_KEY: expected at least 8 characters/);
  assert.match(shortUpstreamKey.stderr, /1 environment variable problem\./);
  assert.doesNotMatch(shortUpstreamKey.stderr, /Ry3tiny/);

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
  assert.match(invalidVars.stderr, /3 environment variable problems/);
  assert.doesNotMatch(invalidVars.stderr, /leaky/);

  console.log(`All Local API Proxy v${health.version} tests passed (${captured.length} upstream requests).`);
} finally {
  for (const lingering of lingeringResponses) {
    try { lingering.end(); } catch {}
  }
  proxy.kill("SIGTERM");
  upstream.close();
  try { fs.rmSync(traceFilePath, { force: true }); } catch {}
}
