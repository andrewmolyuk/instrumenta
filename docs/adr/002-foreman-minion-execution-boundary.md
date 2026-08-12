# 002 — Foreman and Minion are separate containers; Minion is ephemeral and unattended

Date: 2026-08-12

## Context

Running unattended means Claude Code has to execute without a human approving each
tool call — `--dangerously-skip-permissions`. That removes the interactive safety net
the tool normally relies on, against a codebase instrumenta doesn't own, driven by task
text (a Jira ticket body) that isn't fully trusted input. Something has to compensate
for that. Separately, Foreman's own job — polling, bookkeeping, serving the control
API/UI — has nothing to do with running LLM-directed shell commands, and doesn't need
to share a trust boundary with it.

## Options considered

- **A** — one container doing everything. Simplest to deploy, but collapses two
  different trust boundaries into one process: whatever a maliciously- or accidentally-
  crafted Jira ticket body could influence during unattended execution would then also
  be running in the same process as Foreman's own state and control API, not just
  against the target repository checkout.
- **B (chosen)** — two containers. **Foreman**: long-running, owns SQLite and the
  API/UI, never itself executes target-authored or LLM-directed shell. **Minion**:
  ephemeral, one container per dispatched task, runs Claude Code with
  `--dangerously-skip-permissions` inside, destroyed after.
- **C** — stronger isolation than a plain container (gVisor, Firecracker, a VM per
  task). More containment than B, but more operational cost than is justified at MVP
  scale — one agent, no parallelism, a single operator. A plain container boundary is
  already the accepted compensating control for this exact pattern elsewhere (the same
  approach the DevPilot benchmark harness uses to run baseline Claude Code sessions
  unattended).

## Decision

Minion is started fresh per dispatched task with everything it needs at launch:
`task_id`, `jira_key`, the normalized task description, the attempt number, prior-
attempt context if this is a retry, and credentials scoped to the target repository.
It is destroyed after reporting its result — never reused across tasks.

Inside Minion: checkout the target project on a branch named after `jira_key` (not the
internal UUID); the agent implements the task; look for a `verify` gate already defined
in the target project (missing → write a note at the target project's configured notes
path, don't commit, report `blocked_no_verify`; present → run it, failing blocks the
commit and reports `failed_verify`, passing commits and opens the PR, reporting
`success` with its url). If this is the final allowed attempt and it still doesn't
succeed, Minion itself writes a give-up note at that same path before reporting
`given_up`.

Unlike the `verify` gate, a missing notes-path convention isn't a hard stop — there's a
safe default (`docs/todo/`). A target project can override where Minion writes these
notes via a small config value in its own repository (e.g. `.instrumenta.yml`,
`notes_path: instrumenta/review`); Minion reads it at checkout, same as it looks for
`verify`. Either way, the note is a plain file in an ordinary PR a human reviews — it
doesn't assume the target project already uses instrumenta's own frontmatter
conventions for it.

Minion has no API of its own and pushes no progress mid-run. Foreman starts the
container and waits synchronously for it to exit, then reads one structured result.
There is deliberately no live-status callback channel. Foreman enforces a timeout and
kills Minion if exceeded, recording that run as a failed attempt directly (this is the
specific gap [ADR-001](001-task-state-three-sources.md) needed Foreman's own state to
catch — a crash or hang that never produces a PR is invisible to git alone).

**Why not A:** an attacker- or accident-influenced unattended run and Foreman's own
control plane have no business sharing a process. Splitting them means a bad Minion run
can, at worst, damage its own throwaway container and the target-repo checkout inside
it — not Foreman's bookkeeping or its control surface.

**Why not C:** nothing at MVP scale currently justifies the added operational cost —
no case has been observed or is anticipated yet where a plain container boundary is
insufficient, and the pattern is already validated elsewhere at similar scale.

## Consequences

- Every dispatch pays a fresh container boot and target-repo clone — no warm reuse
  between tasks. Acceptable at MVP's serial, single-task-at-a-time scale.
- No live progress visibility into a running Minion, only the result at exit — a
  deliberate simplicity trade, not an oversight (see architecture.md for what this
  avoids building).
- Foreman needs its own persistent volume for SQLite, independent of Minion's
  lifecycle, since Minion carries no state across runs.

## Reversibility

Two-way door for the container split itself — internal deployment topology, not
anything a target project or a human operator depends on structurally. The choice of
`--dangerously-skip-permissions` plus a container boundary, rather than an interactive
or allowlist-based approval model, is a lighter one-way door: reversing it later means
redesigning Minion's whole invocation and likely its retry/verify flow around
human-in-the-loop tool approval, not just flipping a flag.

## Revisit trigger

If a Minion escape, or any unexpected reach from Minion into Foreman's own state or
API, is ever observed or judged newly plausible (e.g. once running against untrusted
third-party projects rather than ones the operator already trusts), revisit toward
option C or an explicit tool allowlist inside the sandbox rather than relying on
`--dangerously-skip-permissions` plus container isolation alone.
