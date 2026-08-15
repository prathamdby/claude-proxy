#!/usr/bin/env node
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testApiKey = "test-anyrouter-key-never-leaves-mock";
const localKey = "test-local-proxy-key";
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

// Mirrors Any Router: "\n\n\n" frame separators, and the socket is deliberately
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

const upstreamPort = await listen(upstream);
const probe = http.createServer();
const proxyPort = await listen(probe);
probe.close();
await once(probe, "close");

// proxy.mjs requires every variable and has no defaults, so the suite supplies
// the full set explicitly. No `...process.env` spread: the run has to be
// hermetic, otherwise a developer shell that happens to export these would hide
// a missing variable here and the suite would fail only in CI or in a container.
const traceFilePath = join(tmpdir(), `anyrouter-proxy-test-trace-${process.pid}.log`);
const proxyEnv = {
  HOST: "127.0.0.1",
  PORT: String(proxyPort),
  ANYROUTER_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
  ANYROUTER_API_KEY: testApiKey,
  LOCAL_PROXY_KEY: localKey,
  CLAUDE_CODE_VERSION: "0.0.0-test",
  ANYROUTER_MODEL: "claude-opus-4-8",
  UPSTREAM_TIMEOUT_MS: "300000",
  RETRY_AFTER_SECONDS: "11",
  MAX_BODY_BYTES: "26214400",
  ANYROUTER_WIRE_OS: "TestOS",
  ANYROUTER_WIRE_ARCH: "test-arch",
  ANYROUTER_STAINLESS_VERSION: "0.0.0-test",
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

async function waitForProxy() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/health`);
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

try {
  await waitForProxy();

  // Local API auth is now actually enforced.
  const rejected = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`);
  assert.equal(rejected.status, 401);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.type, "error");

  const modelsResponse = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
    headers: { authorization: `Bearer ${localKey}` }
  });
  const models = await modelsResponse.json();
  assert.equal(modelsResponse.status, 200);
  assert.equal(models.object, "list");
  assert.ok(models.data.some((model) => model.id === "claude-opus-4-8"));

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
  assert.equal(rate.headers.get("x-anyrouter-proxy-original-status"), "403");
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
  assert.equal(permanentModel.headers.get("x-anyrouter-proxy-classification"), "permanent-pattern");

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
  assert.equal(empty.headers.get("x-anyrouter-proxy-classification"), "empty-stream");
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

  const healthResponse = await fetch(`http://127.0.0.1:${proxyPort}/health`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.version, "2.1.0");
  assert.equal(health.node, process.version);
  assert.ok(health.stats.normalizedTo429 >= 2);
  assert.ok(health.stats.droppedSseFrames >= 5);
  assert.ok(health.stats.emptyStreamsRecovered >= 1);
  assert.ok(health.stats.authRejected >= 1);
  assert.ok(health.stats.responsesBridged >= 4);
  assert.ok(health.stats.responsesStoreHits >= 1);

  // Inspect actual upstream wire image.
  const first = captured[0];

  // The proxy owns auth: the local key never reaches the upstream in any form.
  assert.equal(first.headers.authorization, `Bearer ${testApiKey}`);
  assert.notEqual(first.headers.authorization, `Bearer ${localKey}`);
  assert.equal(first.headers["x-api-key"], undefined);
  assert.equal(first.headers.host, `127.0.0.1:${upstreamPort}`);

  // Client headers are forwarded verbatim rather than stripped.
  assert.equal(first.headers["user-agent"], "claude-cli/2.1.233 (external, cli)");
  assert.equal(first.headers["x-stainless-retry-count"], "0");
  assert.equal(first.headers["x-stainless-timeout"], "60");
  assert.equal(first.headers["x-custom-client-header"], "forward-me");

  // Wire-image defaults still fill in headers the client did not send.
  assert.equal(first.headers["x-app"], "cli");
  assert.equal(first.headers["x-stainless-runtime-version"], process.version);
  assert.equal(first.headers["anthropic-version"], "2023-06-01");

  assert.equal(first.headers["x-claude-code-session-id"], preservedSession);
  assert.ok(first.headers["anthropic-beta"].includes("claude-code-20250219"));
  assert.ok(first.headers["anthropic-beta"].includes("context-1m-2025-08-07"));
  assert.ok(first.headers["anthropic-beta"].includes("custom-beta-2099-01-01"));
  assert.equal(first.headers["accept-encoding"], "identity");
  assert.match(first.url, /^\/v1\/messages\?beta=true$/);

  // Startup refuses to run on an incomplete environment, and names every
  // offending variable in one pass instead of one restart per variable.
  const missingVars = await runProxyToExit(envWithout("LOCAL_PROXY_KEY", "UPSTREAM_TIMEOUT_MS"));
  assert.notEqual(missingVars.code, 0);
  assert.match(missingVars.stderr, /LOCAL_PROXY_KEY/);
  assert.match(missingVars.stderr, /UPSTREAM_TIMEOUT_MS/);
  assert.match(missingVars.stderr, /2 environment variable problems/);
  assert.equal(missingVars.stdout, "");

  // Present but unusable fails the same way, and a rejected secret is never
  // echoed back into stderr.
  const invalidVars = await runProxyToExit({
    ...proxyEnv,
    PORT: "abc",
    PROXY_TRACE: "1",
    LOCAL_PROXY_KEY: "too-short"
  });
  assert.notEqual(invalidVars.code, 0);
  assert.match(invalidVars.stderr, /PORT: expected an integer between 1 and 65535, got "abc"/);
  assert.match(invalidVars.stderr, /PROXY_TRACE: expected exactly "true" or "false"/);
  assert.match(invalidVars.stderr, /LOCAL_PROXY_KEY/);
  assert.doesNotMatch(invalidVars.stderr, /too-short/);

  console.log(`All Any Router Local Proxy v2.1.0 tests passed (${captured.length} upstream requests).`);
} finally {
  for (const lingering of lingeringResponses) {
    try { lingering.end(); } catch {}
  }
  proxy.kill("SIGTERM");
  upstream.close();
  try { fs.rmSync(traceFilePath, { force: true }); } catch {}
}
