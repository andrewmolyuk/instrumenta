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
#
# `ffmpeg` is here because tickets arrive as screen recordings, not only
# screenshots, and Claude Code can read an image but not an `.mp4`. Found live
# on a topology-diagram ticket whose only attachment was a 3.4MB video: the
# agent probed eight tools (all absent), rendered the video in Chromium, then
# wrote a Chrome DevTools Protocol client in Node to pull frames out — and was
# stopped by `SecurityError: Tainted canvases may not be exported`, because a
# file:// video taints the canvas it is drawn into. Chromium decodes the video
# fine; it cannot export a frame. `ffmpeg -i v.mp4 -vf fps=1 f_%03d.png` does it
# in one command. `python3` is the third tool that attempt reached for and did
# not find; it is thirteen packages and the agent keeps expecting it.
#
# `chromium` (with fonts) is here because most of this pipeline's tickets are UI
# bugs reported as a screenshot, and without a browser the agent cannot see what
# it is fixing. Found live on RPG-5427: it tried PIL, ImageMagick, ffmpeg, sharp
# and four ways of locating a headless browser, found none, and hand-wrote a
# PNG inflater in Node to measure the attachment — a dozen turns to get pixel
# geometry it could have rendered directly, and still no way to check its own
# fix. `fonts-liberation` is not optional either: headless Chromium with no
# fonts renders text as empty boxes, which is worthless for a text-alignment bug.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates chromium ffmpeg fonts-liberation git python3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code sass clean-css

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY minion ./minion
COPY src/minion/types.mts ./src/minion/types.mts
COPY src/minion/progress.mts ./src/minion/progress.mts
COPY src/task-provider/adf.mts ./src/task-provider/adf.mts
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
# `sass` and `clean-css` ship with the image because a fresh clone has no
# node_modules and the agent needs them before it can render anything. Measured
# on an RPG-5427 attempt: it spent 300s installing sass, another 300s on
# clean-css and 600s on stylelint, all into /tmp, before the target repo's own
# `npm install` had even been run. clean-css is a library rather than a CLI, so
# NODE_PATH below is what makes `require('clean-css')` resolve from any cwd.
#
# /cache is where the git mirror volume mounts (ADR-013). Created here, owned by
# minion, because Docker copies an image directory's ownership onto a fresh named
# volume mounted over it — without this the volume arrives root-owned and the
# non-root user below cannot write the mirror.
RUN useradd --create-home --shell /bin/bash minion \
  && mkdir -p /cache \
  && chown -R minion:minion /app /usr/local/lib/node_modules /usr/local/bin /cache
# Loaded by Claude Code as user-level memory on every run, merged with whatever
# CLAUDE.md the target repository has (the target's is more specific and wins).
# Carried in the image rather than mounted: it is versioned with the prompt it
# complements, so the two cannot drift apart across a deployment.
COPY --chown=minion:minion minion/agent-home/CLAUDE.md /home/minion/.claude/CLAUDE.md

USER minion
ENV HOME=/home/minion
# So a target project's own tooling finds the browser already in the image
# instead of downloading a second copy of it mid-attempt.
ENV CHROME_BIN=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    NODE_PATH=/usr/local/lib/node_modules

ENTRYPOINT ["bun", "minion/main.mts"]
