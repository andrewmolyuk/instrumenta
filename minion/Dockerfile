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

ENTRYPOINT ["bun", "minion/main.mts"]
