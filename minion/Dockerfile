# Minion: ephemeral, one per dispatched task (ADR-002). Built here rather than
# reusing Foreman's own image since it needs git + npm (checkout, verify-gate)
# that Foreman's container has no reason to carry. Also ships the Claude Code
# CLI itself — implement-task.mts spawns it to do the actual task work.
FROM oven/bun:1

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git npm \
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
