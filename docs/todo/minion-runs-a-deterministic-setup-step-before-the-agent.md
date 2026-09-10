---
type: adr-candidate
status: open
date: 2026-09-01
source: session 50744b29-8230-49b5-8100-ca360100f433
---

# Minion runs a deterministic setup step between clone and agent start

Minion had no dependency-install step of its own — the agent ran `npm install` itself,
from `minion/agent-home/CLAUDE.md`, inside its own `claude -p` session. That's too late
for skills: Claude Code enumerates a project's skills when the session starts, so any
skill installed after the agent is already running is invisible to it for that entire
attempt. Fixing this required a step Minion runs itself, deterministically, before
`claude -p` starts — telling the agent to install skills in its prompt could not work.

**Decision:** added `minion/setup.mts`, invoked from `orchestrate.mts` after
`cloneAndBranch` and before `implementTask`. Command comes from env `MINION_SETUP_COMMAND`,
run via `sh -c` from the checkout root; if unset, the step is skipped. Failure produces
`crashed` (not a ticket verdict) and the agent never starts, matching the existing
`MINION_VERIFY_COMMAND` pattern.

**Alternatives considered and rejected:**
- Telling the agent to install skills via `agent-home/CLAUDE.md` prompt instructions —
  rejected because skill discovery happens at session start, before the agent can act.
- Running the target project's own `make skills-install` target directly — rejected
  after it crashed a live attempt (KAZ-8877): the target Makefile (`webui`) does
  `include ${PROJECT_TOP}/app/build/app.mk`, and `PROJECT_TOP` is only set inside that
  project's own build container, not Minion's. Any `make` target from a cloned project
  is generally unreachable inside Minion's container for this reason.
- Direct install via the project's `skills` CLI (`npx -y skills experimental_install`,
  installs strictly from `skills-lock.json`) — chosen instead; verified in-container that
  it doesn't touch tracked files other than `skills-lock.json` (reverted with
  `git checkout -- skills-lock.json`).

Also switched the dependency install itself from `npm install` to `npm ci` in the same
command, since `npm install` was rewriting `package-lock.json` with unrelated churn — the
same failure mode already tracked in
[minion-induced-crlf-and-lockfile-churn-in-the-diff.md](minion-induced-crlf-and-lockfile-churn-in-the-diff.md),
just triggered earlier (during setup rather than during the agent's own session).

Current live value of `MINION_SETUP_COMMAND` (webui project, in `.env`, not in repo code):
`npm ci && npx -y skills experimental_install && git checkout -- skills-lock.json`.
