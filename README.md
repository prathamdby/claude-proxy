# Local API Proxy

A small, zero-dependency Node.js HTTP proxy that sits between Claude Code and an
Anthropic-API-compatible gateway. Claude Code talks to this proxy — on localhost,
or over a public hostname behind Traefik, which is how it is deployed — and the
proxy attaches the upstream credential, normalises the request and forwards it
on.

Everything is a single file, `proxy.mjs`. There are no dependencies, no
`package.json` and nothing to install.

## What it exposes

| Method | Path | Listener | Auth |
| --- | --- | --- | --- |
| POST | `/v1/messages` | public `PORT` | yes |
| POST | `/v1/messages/count_tokens` | public `PORT` | yes |
| POST | `/v1/chat/completions` | public `PORT` | yes |
| POST | `/v1/responses` | public `PORT` | yes |
| GET | `/v1/models` | public `PORT` | yes |
| GET | `/health` | internal `127.0.0.1:HEALTH_PORT` | **no** |

Authenticated routes require `LOCAL_PROXY_KEY`, presented as
`Authorization: Bearer <key>`, `x-api-key` or `api-key`.

Each path answers to the one method listed beside it. Anything else under
`/v1/` is a 404 — an unserved path and a served one reached by another method
get the same reply, which lists every route — but auth runs first, so an
unauthenticated request to either is still a 401.

`/v1/models` is a straight pass-through: the request goes upstream as it
arrived, pagination query and all, and the gateway's answer comes back byte for
byte. The catalogue is therefore whatever your `UPSTREAM_API_KEY` can actually
reach — the proxy keeps no list of its own, and `UPSTREAM_MODEL` appears in the
result only if the gateway lists it.

The public listener additionally requires an allowed `Host` header and rejects
anything that looks like a browser; both are 403. See [Security](#security).

`/health` is not on the public listener at all — requesting it there is a 404.
It is served on a second listener bound to `127.0.0.1:HEALTH_PORT`, the
container's own loopback, which is never published and never routed by Traefik.
Nothing outside the container can reach it by construction, and that is why it
needs no auth: reachability is the control, not a credential. It reports `ok`,
`version` (the proxy's own, `4.1.0`), `node`, `uptime_seconds`, `upstream` and
`stats`. `HEALTH_PORT` must differ from `PORT`.

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
# edit .env: set UPSTREAM_API_KEY to your gateway key, and set ALLOWED_HOSTS to
# the hostname you will point Claude Code at.
# generate LOCAL_PROXY_KEY — it must be at least 32 characters:
openssl rand -base64 32
docker compose up -d
```

`LOCAL_PROXY_KEY` is the only thing standing between the listener and a paid
upstream credential, so it has to be unguessable. Startup rejects anything
shorter than 32 characters; do not invent one by hand.

Check it came up:

```sh
docker compose ps
docker compose logs -f
```

`docker compose ps` showing the container as `healthy` means the healthcheck
reached `/health` on the internal listener. To read the payload:

```sh
docker compose exec proxy node -e "fetch('http://127.0.0.1:'+process.env.HEALTH_PORT+'/health').then(r=>r.text()).then(console.log)"
```

`{"ok":true,...}` means the process is alive and its event loop is responding.
It does **not** mean the gateway is reachable, that your key is valid, or that
the proxy is reachable from outside the container — the handler never contacts
upstream, and the check never leaves the container's loopback. The first real
request through your actual base URL tells you all three.

## Point Claude Code at it

```sh
export ANTHROPIC_BASE_URL=https://claude-proxy.<ip>.nip.io
export ANTHROPIC_AUTH_TOKEN=<the LOCAL_PROXY_KEY value from your .env>
claude
```

Against a local container it is `http://127.0.0.1:18989` instead. Use
`HOST_PORT` in the URL, not `PORT`. They are the same by default.

Either way, the hostname in `ANTHROPIC_BASE_URL` must be listed in
`ALLOWED_HOSTS` or every request comes back 403 — see
[Remote deployment](#remote-deployment) for the mapping.

`ANTHROPIC_AUTH_TOKEN` makes Claude Code send `Authorization: Bearer <token>`,
which is exactly what this proxy checks. Set it to your **local** proxy key, not
your gateway key — the gateway key stays in `.env` and never leaves the
container.

## Environment variables

Set every one of these in `.env`. Values are trimmed; empty counts as missing.
Do not quote them — Compose treats quotes in an env file as part of the value.

| Variable | Meaning | Format / example |
| --- | --- | --- |
| `HOST_PORT` | Port on your machine, bound to `127.0.0.1`. Compose only, not read by the proxy. | `18989` |
| `HOST` | Bind address. **Compose overrides this to `0.0.0.0`**; only used when running directly. | `127.0.0.1` |
| `PORT` | Port inside the container. Keep ≥1024; it runs as a non-root user. | `18989` (1–65535) |
| `HEALTH_PORT` | Port of the internal `/health` listener, bound to `127.0.0.1` inside the container and never published. Must differ from `PORT`. | `18990` (1–65535) |
| `ALLOWED_HOSTS` | Hostnames the public listener will answer for. Any other `Host` is a 403. Comma-separated; each entry may be a bare hostname, `host:port` or a full URL — only the hostname is compared. | `claude-proxy.<ip>.nip.io,127.0.0.1,localhost` |
| `UPSTREAM_BASE_URL` | Gateway every request is forwarded to. `http:`/`https:` only. | `https://anyrouter.top` |
| `UPSTREAM_API_KEY` | Gateway credential, sent as `Authorization: Bearer`. Bills to your account. | ≥8 chars |
| `LOCAL_PROXY_KEY` | Secret Claude Code must present to this proxy. The only gate in front of `UPSTREAM_API_KEY`. | ≥32 chars, from `openssl rand -base64 32` |
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
match, replacing each whole with `[REDACTED:UPSTREAM_API_KEY]` or
`[REDACTED:LOCAL_PROXY_KEY]` — no leading characters of the secret survive. It
does nothing for prompt content, and it will not catch a credential that happens
to appear inside a prompt or a reply.

It ships as `false`. Turn it on only while debugging.

Under Compose the trace lands on a 64 MiB tmpfs that is discarded when the
container stops, so traces never accumulate on your disk. The file is created
mode `0600`, readable only by the user the proxy runs as. Read one while the
container is running:

```sh
docker compose exec proxy cat /tmp/proxy-trace.log
```

If you redirect `PROXY_TRACE_FILE` to a bind mount to keep traces across
restarts, understand that you are writing full prompt text into a host directory.
The `0600` mode follows the file, but the directory you mount is yours to get
right. `.gitignore` already excludes `*.log` and `*.trace` as a backstop.

`PROXY_LOG_VERBOSE=true` similarly dumps inbound client headers and the upstream
header set into stdout, and from there into `docker compose logs`.

## Security

This proxy runs on a public VPS behind Traefik, on a hostname anyone can resolve.
It is not a loopback-only service, and its network position protects nothing.
**`LOCAL_PROXY_KEY` is the sole gate in front of a paid upstream credential.**
Everything below either guards that key or reduces what reaches it.

- **`LOCAL_PROXY_KEY` must be at least 32 characters**, and startup refuses
  anything shorter, so a short or memorable key cannot reach production by
  accident. Generate it with `openssl rand -base64 32`. `UPSTREAM_API_KEY` must
  be at least 8.
- **The key comparison is constant-time regardless of key length.** A wrong key
  and a wrong-length key take the same time to reject, so response timing does
  not leak the key byte by byte.
- **TLS is terminated by Traefik, not by this proxy.** The proxy itself speaks
  plain HTTP, and the hop from Traefik to the container stays on the Docker
  network. Do not publish the container port on `0.0.0.0`: anything that reaches
  the proxy without passing through Traefik also skips TLS, and the key then
  travels in clear.
- **Every request to the public listener must carry an allowed `Host`.** The
  hostname is matched against `ALLOWED_HOSTS` and anything else is a 403. Only
  the hostname is compared; ports and schemes are ignored. This stops nothing
  that already knows the hostname — what it drops is traffic arriving by bare IP
  or under some other name pointed at the same address, which is most of what
  scans a public host.
- **Any request carrying an `origin` or `sec-fetch-site` header is rejected with
  403.** No CLI client sends either; a browser always sends at least one. A page
  on the open web therefore cannot drive this proxy from a visitor's machine.
- **`/health` is unreachable from outside the container.** It is served on a
  second listener bound to `127.0.0.1:HEALTH_PORT`, never published and never
  routed by Traefik, so reachability — not a credential — is the control. The
  upstream origin and traffic counters it reports are never exposed publicly.
- **The trace file is created mode `0600`**, readable only by the user the proxy
  runs as.
- **Log and trace redaction leaks no prefix.** Both configured keys are replaced
  whole with `[REDACTED:UPSTREAM_API_KEY]` and `[REDACTED:LOCAL_PROXY_KEY]`; the
  first characters of a secret are no longer printed alongside the mask, where
  they narrowed the search for anyone reading the logs.
- **`.env` is never committed and never enters the image.** `.gitignore`
  excludes it; `.dockerignore` is an allow-list admitting only `proxy.mjs`, so
  the build context cannot contain a credential to bake into a layer.
- **The container is hardened**: non-root user, read-only root filesystem, all
  capabilities dropped, `no-new-privileges`, and a single 64 MiB tmpfs at
  `/tmp`.
- **The image carries no configuration.** It is byte-identical no matter who
  builds it, and fails immediately if run without an env file.
- Rotate `UPSTREAM_API_KEY` at the gateway — and `LOCAL_PROXY_KEY` here — if it
  has ever been committed, pasted or shared. Removing a key from a file does not
  un-expose it.

### Remote deployment

Deployed with Dokploy: Traefik owns the public hostname, terminates TLS, and
reaches the container over the Docker network.

Traefik forwards the original `Host` header, so the host guard sees the public
hostname and works unchanged behind it — there is nothing to configure on the
proxy side and no need to trust any `X-Forwarded-*` header. The one requirement
is that the hostname you point Claude Code at appears in `ALLOWED_HOSTS`.

Take the entry straight from `ANTHROPIC_BASE_URL`:

| `ANTHROPIC_BASE_URL` | `ALLOWED_HOSTS` entry |
| --- | --- |
| `https://claude-proxy.<ip>.nip.io` | `claude-proxy.<ip>.nip.io` |
| `http://127.0.0.1:18989` | `127.0.0.1` |
| `http://localhost:18989` | `localhost` |

An entry may also be written as `host:port` or as the full URL — the scheme and
port are discarded before matching — so pasting the base URL verbatim works too.
`127.0.0.1` and `localhost` are separate entries; listing one does not cover the
other.

The `<ip>` in that hostname is the VPS address, resolved by nip.io: any name of
the form `<anything>.<ip>.nip.io` resolves to `<ip>`. That is free and needs no
DNS of your own, but it is a shared third-party service — an outage there makes
the proxy unreachable and can block an ACME certificate renewal at the same
time, which is the slower of the two failures to recover from. A domain you
control is steadier for anything long-lived.

### Accepted risks

These were considered and shipped as they are. They are recorded here so the
next reader does not mistake them for oversights.

- **No rate limiting.** Nothing throttles a caller presenting a valid key. If
  `LOCAL_PROXY_KEY` leaks or is brute-forced, spend is unbounded until someone
  notices the bill. Set a spend alert, or a hard cap, at the gateway — that is
  the backstop, and it is the only one.
- **No network-layer restriction.** No IP allow-list, no VPN, no private
  overlay. The listener is reachable from anywhere with a route to the VPS.
- **The hostname is public and discoverable.** `<anything>.<ip>.nip.io` resolves
  for anyone, so the name is derived from the IP rather than being a secret —
  learning the IP is enough to construct it. The host guard is noise reduction,
  not a second factor, and nothing here should be read as one.

## Running without Docker

```sh
set -a; . ./.env; set +a
node proxy.mjs
```

`HOST=127.0.0.1` from `.env` is correct here — the Compose override to `0.0.0.0`
applies only inside a container.

`ALLOWED_HOSTS` still applies, so it has to contain whatever hostname you put in
`ANTHROPIC_BASE_URL`; `127.0.0.1` and `localhost` are separate entries. The
health listener binds `127.0.0.1:HEALTH_PORT` on your own machine, so here you
can reach it directly:

```sh
curl -s "http://127.0.0.1:$HEALTH_PORT/health"
```

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
| Container restart-loops, logs list variables | The proxy's own validation rejected a value's type or range. The message names each one. Common after an upgrade: `LOCAL_PROXY_KEY` under 32 characters, or `HEALTH_PORT` equal to `PORT`. |
| **403 on every request** | The hostname in `ANTHROPIC_BASE_URL` is not in `ALLOWED_HOSTS` — the most likely failure after upgrading. Add it as a bare hostname, without scheme or port, and restart. `127.0.0.1` and `localhost` do not cover each other. |
| 403 from a browser or a web page | The browser guard rejected an `origin` or `sec-fetch-site` header. This proxy serves CLI clients only. |
| 404 on `/health` | It is no longer on the public port. Use `docker compose ps`, or request it from inside the container on `HEALTH_PORT`. |
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
