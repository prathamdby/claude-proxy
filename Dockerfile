# syntax=docker/dockerfile:1

# Node 24.19 is an active LTS line and matches the runtime this proxy was
# developed against. process.version is reported by /health, so changing the
# base image changes what that endpoint says the proxy is running on. It is not
# sent upstream: the proxy no longer synthesizes x-stainless-* headers, and a
# real client's own values were always forwarded in preference anyway.
# Pinned to a minor tag rather than :latest so rebuilds are reproducible.
FROM node:24.19-alpine

WORKDIR /app

# proxy.mjs has no dependencies and there is no package.json, so there is
# nothing to install and no npm layer to cache.
#
# The --chmod is load-bearing, not tidiness. proxy.mjs is mode 0700 in the
# source tree and BuildKit's COPY preserves the source mode while assigning
# root:root ownership. Without it, the unprivileged user below cannot read its
# own entrypoint and the container exits with EACCES on a file that plainly
# exists in the image. 0444 also means the running app cannot rewrite its own
# code, since nothing in this image ever needs to write to /app.
COPY --chmod=0444 proxy.mjs ./

# Drop root. The official node images ship a `node` user at uid/gid 1000.
USER node

# No ENV or ARG config values anywhere in this file, deliberately.
# The image is identical no matter who builds it and carries no credentials,
# no hostnames and no defaults. Every one of the 18 settings is supplied at
# run time; proxy.mjs validates them all before it binds a socket and exits 1
# naming every missing variable at once. Run this image without an env file and
# it fails immediately and loudly, which is the intended behaviour.

# No EXPOSE either: the listening port is configuration (PORT), so hardcoding a
# number here would reintroduce exactly the default this setup removes. The
# published port is declared in docker-compose.yml instead.

# Exec form, not shell form. This is what makes `docker stop` work: proxy.mjs
# installs its own SIGTERM/SIGINT handlers and shuts down cleanly, but only if
# node is PID 1. In shell form, /bin/sh becomes PID 1, does not forward
# SIGTERM, and every stop degrades into a 10 second wait and a SIGKILL.
CMD ["node", "proxy.mjs"]
