# Minion: ephemeral, one per dispatched task (ADR-002). Built here rather than
# reusing Foreman's own image since it needs git + Node/npm (checkout, verify
# gate, and the target project's own toolchain) that Foreman's container has no
# reason to carry. Also ships the Claude Code CLI itself — implement-task.mts
# spawns it to do the actual task work.
#
# Node is the base image, with Bun copied in on top of it, rather than the other
# way round: Debian's own `npm` package pulled Node 20, and target projects'
# devDependencies already require >= 22.18. Found live on KAZ-8739 — the target
# repo's ESLint died on the older runtime ("Unterminated comment" out of
# `node_modules/lodash.merge`), so Claude Code couldn't run the project's checks
# and neither could the gate; the attempt burned 47 minutes and produced nothing.
# Bun comes from its own official image (Minion's own code runs under it) rather
# than from npm, so it's the same binary `oven/bun:1` ships.
FROM oven/bun:1 AS bun

FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# `ca-certificates` is not optional: the base image ships no CA bundle at all
# (no /etc/ssl/certs), and `--no-install-recommends` drops the one git itself
# recommends — so every `git clone https://...` died with "server certificate
# verification failed. CAfile: none CRLfile: none" before the attempt could
# start. Found live on RPG-6017/6029/6036/6040/6043/6044 — eight attempts
# crashed within a second of dispatch, each one a wasted retry.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY minion ./minion
COPY src/minion/types.mts ./src/minion/types.mts
COPY src/db/index.mts ./src/db/index.mts
COPY src/bitbucket/closed-prs.mts ./src/bitbucket/closed-prs.mts

# Claude Code refuses --dangerously-skip-permissions as root/sudo (security
# guardrail on its end) — found live: Minion ran as root by default, so every
# implementTask invocation was silently refusing to start, making no changes
# at all. A real (if throwaway, container-scoped) user works around that.
# Also needs write access to npm's global install location: target projects'
# own `npm install` can reach for global-ish packages (e.g. turbo) as part of
# their own toolchain, and that path is root-owned by default (it's where
# `npm install -g @anthropic-ai/claude-code` above just wrote, as root).
RUN useradd --create-home --shell /bin/bash minion \
  && chown -R minion:minion /app /usr/local/lib/node_modules /usr/local/bin
USER minion
ENV HOME=/home/minion

ENTRYPOINT ["bun", "minion/main.mts"]
