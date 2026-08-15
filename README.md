# Local API Proxy

A small, zero-dependency Node.js HTTP proxy that sits between Claude Code and an
Anthropic-API-compatible gateway. Claude Code talks to this proxy
on localhost; the proxy attaches the upstream credential, normalises the request
and forwards it on.

Everything is a single file, `proxy.mjs`. There are no dependencies, no
`package.json` and nothing to install.

## What it exposes

| Method | Path | Auth |
| --- | --- | --- |
| POST | `/v1/messages` | yes |
| POST | `/v1/messages/count_tokens` | yes |
| POST | `/v1/chat/completions` | yes |
| POST | `/v1/responses` | yes |
| GET | `/health` | **no** |

Authenticated routes require `LOCAL_PROXY_KEY`, presented as
`Authorization: Bearer <key>`, `x-api-key` or `api-key`.

Anything else under `/v1/` is a 404 — but auth runs first, so an unauthenticated
request to an unserved path is still a 401.

`/health` is deliberately unauthenticated so the container healthcheck can reach
it, and it reports the upstream origin and traffic counters. That is why the
published port is bound to host loopback only — see [Security](#security).

## Configuration

**Every variable is required. Nothing has a default.** A missing or empty value
stops the proxy at startup with a message naming every problem at once, rather
than starting a container that quietly misbehaves. Compose refuses even earlier,
before building anything.

## Prerequisites

- Docker Engine with the Compose v2 plugin (`docker compose version`)
- or, to run it directly, Node.js 18+ (the image pins 24.19)

## Quick start

```sh
cp .env.example .env
# edit .env: set UPSTREAM_API_KEY to your gateway key.
# LOCAL_PROXY_KEY defaults to sk-dummy, which is fine for loopback-only use.
docker compose up -d
```

Check it came up:

```sh
curl -s http://127.0.0.1:18989/health
docker compose logs -f
```

`/health` returning `{"ok":true,...}` means the process is alive and responding.
It does **not** mean the gateway is reachable or that your key is valid — the
handler never contacts upstream. The first real request tells you that.

## Point Claude Code at it

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:18989
export ANTHROPIC_AUTH_TOKEN=<the LOCAL_PROXY_KEY value from your .env>
claude
```

`ANTHROPIC_AUTH_TOKEN` makes Claude Code send `Authorization: Bearer <token>`,
which is exactly what this proxy checks. Set it to your **local** proxy key, not
your gateway key — the gateway key stays in `.env` and never leaves the
container.

Use `HOST_PORT` in the URL, not `PORT`. They are the same by default.

## Environment variables

Set every one of these in `.env`. Values are trimmed; empty counts as missing.
Do not quote them — Compose treats quotes in an env file as part of the value.

| Variable | Meaning | Format / example |
| --- | --- | --- |
| `HOST_PORT` | Port on your machine, bound to `127.0.0.1`. Compose only, not read by the proxy. | `18989` |
| `HOST` | Bind address. **Compose overrides this to `0.0.0.0`**; only used when running directly. | `127.0.0.1` |
| `PORT` | Port inside the container. Keep ≥1024; it runs as a non-root user. | `18989` (1–65535) |
| `UPSTREAM_BASE_URL` | Gateway every request is forwarded to. `http:`/`https:` only. | `https://anyrouter.top` |
| `UPSTREAM_API_KEY` | Gateway credential, sent as `Authorization: Bearer`. Bills to your account. | ≥8 chars |
| `LOCAL_PROXY_KEY` | Secret Claude Code must present to this proxy. | `sk-dummy` |
| `CLAUDE_CODE_VERSION` | Version in the synthesized `User-Agent`, used only when the caller sends none. | `2.1.197` |
| `UPSTREAM_MODEL` | Model used when a request omits `model`. | `claude-opus-4-8` |
| `UPSTREAM_TIMEOUT_MS` | Socket timeout per upstream request. Server timeout is this +30000. | `300000` (≥1) |
| `RETRY_AFTER_SECONDS` | `Retry-After` on 429/5xx when upstream sends none. | `15` (≥1) |
| `MAX_BODY_BYTES` | Largest accepted request body; bigger gets a 413. | `26214400` (≥1048576) |
| `RESPONSES_STORE_MAX` | Conversation contexts kept in memory by the `/v1/responses` bridge. | `128` (≥1) |
| `PROXY_LOG` | Request logging to stdout. | `true` / `false` |
| `PROXY_LOG_VERBOSE` | Adds header and body dumps. Debugging only. | `false` |
| `PROXY_LOG_BODY_LIMIT` | Characters logged before truncation. `0` truncates to nothing. | `800` (≥0) |
| `PROXY_TRACE_FILE` | Trace destination. Must be under `/tmp` in the container. | `/tmp/proxy-trace.log` |
| `PROXY_TRACE` | File tracing. See [Privacy](#privacy). | `true` / `false` |
| `PROXY_TRACE_BODY_LIMIT` | Characters traced before truncation. `0` means **no** truncation. | `4000` (≥0) |

The three boolean flags accept **exactly** `true` or `false`. Not `1`, not `0`,
not `yes`, not `on`. Anything else stops startup rather than being guessed at.

Note the trap in the last row: `PROXY_LOG_BODY_LIMIT=0` truncates every logged
body to nothing, while `PROXY_TRACE_BODY_LIMIT=0` disables truncation entirely.
The two knobs look alike and behave oppositely at zero.

## Privacy

`PROXY_TRACE=true` writes **full request and response bodies** — your complete
prompts and the model's complete replies — plus raw SSE frames, in plaintext, to
`PROXY_TRACE_FILE`. Redaction masks only the two configured keys by exact string
match; it does nothing for prompt content, and it will not catch a credential
that happens to appear inside a prompt or a reply.

It ships as `false`. Turn it on only while debugging.

Under Compose the trace lands on a 64 MiB tmpfs that is discarded when the
container stops, so traces never accumulate on your disk. Read one while the
container is running:

```sh
docker compose exec proxy cat /tmp/proxy-trace.log
```

If you redirect `PROXY_TRACE_FILE` to a bind mount to keep traces across
restarts, understand that you are writing full prompt text into a host directory.
`.gitignore` already excludes `*.log` and `*.trace` as a backstop.

`PROXY_LOG_VERBOSE=true` similarly dumps inbound client headers and the upstream
header set into stdout, and from there into `docker compose logs`.

## Security

- **`.env` is never committed and never enters the image.** `.gitignore`
  excludes it; `.dockerignore` is an allow-list admitting only `proxy.mjs`, so
  the build context cannot contain a credential to bake into a layer.
- **The port is published on `127.0.0.1` only.** A bare `18989:18989` would be
  reachable from the LAN even behind a host firewall, because Docker's publish
  rules are traversed before ufw/firewalld. This process holds a paid upstream
  credential and serves an unauthenticated `/health`.
- **The container is hardened**: non-root user, read-only root filesystem, all
  capabilities dropped, `no-new-privileges`, and a single 64 MiB tmpfs at
  `/tmp`.
- **The image carries no configuration.** It is byte-identical no matter who
  builds it, and fails immediately if run without an env file.
- Rotate `UPSTREAM_API_KEY` at the gateway if it has ever been committed,
  pasted or shared. Removing a key from a file does not un-expose it.

## Running without Docker

```sh
set -a; . ./.env; set +a
node proxy.mjs
```

`HOST=127.0.0.1` from `.env` is correct here — the Compose override to `0.0.0.0`
applies only inside a container.

## Tests

The suite starts the proxy against a local mock gateway; no real credentials and
no network access are involved.

```sh
node test.mjs
```

It supplies its own complete environment, so it does not read `.env` and is not
affected by your shell.

## Common problems

| Symptom | Cause |
| --- | --- |
| Compose exits with `missing in .env` | A variable is unset or empty. Compare `.env` against `.env.example`. |
| Container restart-loops, logs list variables | The proxy's own validation rejected a value's type or range. The message names each one. |
| `curl: connection refused` on the host | `HOST` reached the container as `127.0.0.1`. Compose fixes this; check for a stray `HOST` in a compose override. |
| 401 from the proxy | Claude Code's token does not match `LOCAL_PROXY_KEY`. |
| 401 from upstream, proxy healthy | `UPSTREAM_API_KEY` is wrong or still the placeholder. |
| Tracing enabled but the file is empty | `PROXY_TRACE_FILE` points outside `/tmp`; the root filesystem is read-only. |

## Stopping

```sh
docker compose down
```

The proxy handles `SIGTERM` and shuts down cleanly. Its graceful window is
capped at 5 seconds internally, so a stop during an active stream may record
exit code 1 — that is the in-flight stream being cut, not a fault.
