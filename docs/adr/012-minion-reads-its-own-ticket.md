# 012 — Minion reads its own ticket from Jira, attachments included

Date: 2026-08-22

## Context

RPG-5427 is a UI bug — "web UI: SNMP MIB export text is not aligned" — whose Jira
description is a single screenshot and no text at all. Minion was dispatched for it,
ran for 25 minutes, spent $9.69, and opened a pull request titled `RPG-5427: ` with an
empty body. The attempt was recorded as `success`.

Nothing malfunctioned. Every piece behaved as written:

- `MinionInput` carried `description` but not `summary`. `JiraTaskProvider` fetched the
  summary, `BacklogItem` held it, and `dispatch` dropped it one function short of the
  only place it was needed. The agent's prompt was `` `${jira_key}: ${description}` ``.
- `adfToPlainText` extracts text nodes. A `media` node holds its payload in `attrs`, so
  a description that is only a screenshot rendered as `""`.
- The PR title and body were built from that same empty description.
- The verify gate passed, because the gate asks whether the target project's own checks
  pass — never whether the change addresses the ticket.

So the agent was told to fix `RPG-5427: ` and nothing else, and everything downstream
faithfully carried the emptiness through. 114 attempts had run by the time this was
found, every one recorded `success`, $884.95 total.

## Options considered

- **A** — Add `summary` to `MinionInput`. Smallest fix; the empty prompt and empty title
  both go away. Attachments stay invisible.
- **B** — Foreman fetches attachments and passes them to Minion (bytes over stdin, or a
  mounted path). Minion stays credential-free, per ADR-002's sandbox boundary.
- **C** — Give Minion Jira credentials and let it read the whole ticket itself.

## Decision

**C.** Minion reads its own ticket at the start of every attempt.

- `MinionInput` is reduced to the identity of the attempt: `task_id`, `jira_key`,
  `attempt_number`. `BacklogItem` is reduced to `jira_key` and `summary` — what Foreman
  needs to queue and display, nothing more.
- `minion/jira.mts` reads `summary`, `description` and `attachment` from
  `/rest/api/3/issue/{key}`, and downloads each attachment. `MINION_COMMAND` forwards
  `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`.
- Attachments land in `${workDir}-attachments`, deliberately outside the clone:
  `commitAndPush` runs `git add -A`, so anything inside the work tree ships in the PR.
  The prompt lists them by absolute path and tells the agent to read them.
- `adfToPlainText` renders a `media` node as `[image: <filename>]` instead of nothing.
- A failed issue read is fatal to the attempt. Running without the ticket is the
  RPG-5427 failure exactly, and a crash is retryable where a bogus PR is not.

**Why not B, which keeps credentials out of Minion:** it was the recommendation, and it
was overruled deliberately — see Consequences. B needs an attachment transport through
`MinionInput` and a second copy of ticket state in Foreman, to avoid a credential that
the container arguably should hold anyway: Minion is the component doing the work, and
the ticket is its input.

**Why not A:** it fixes the empty title and leaves the actual bug report — a screenshot —
still unreadable. RPG-5427 would still have been attempted on a one-line title.

## Consequences

- **Minion now holds write-capable Jira credentials**, in a container that runs Claude
  Code with `--dangerously-skip-permissions` and full tool access. This is the cost of
  C over B and it is real. Mitigated, not eliminated: `implementTask` strips
  `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` from the environment handed to the
  agent process, which has finished being needed by then. The agent can still reach
  Jira if it finds credentials elsewhere; nothing prevents that, and the container's
  `BITBUCKET_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` remain in its environment because its
  own toolchain needs them. Scope the Jira token to read-only if the deployment can.
- One extra Jira call per attempt, against a ~25-minute run. It also means the agent
  works from the ticket as it reads *now*, not as Foreman read it when building a queue.
- Foreman can no longer show a ticket's description, having stopped fetching it. It does
  not currently display one.
- The agent can now see screenshots, which is what most UI bug reports actually are.
  Whether it uses them well is unproven — no attempt has run against this yet.

## Reversibility

Two-way door, with a caveat. Reverting means restoring `description` to `BacklogItem`
and `MinionInput`, and deleting `minion/jira.mts` — mechanical. The caveat is
operational: the Jira token will have been distributed into Minion's environment on
every deployment that ran this, so reverting the code does not un-distribute it. Rotate
rather than assume.

## Revisit trigger

If a Minion is ever observed touching Jira through the credentials it holds — writing a
comment, transitioning an issue, reading an unrelated ticket — the mitigation has failed
and B should be built. Equally, if attachment fetching turns out to need more than a
token read (OCR, video, large files), the transport belongs in Foreman where the retry
and cost accounting already live.
