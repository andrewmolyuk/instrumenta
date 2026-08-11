# Instrumenta — vision

## Why it exists

Instrumenta is an agent that autonomously runs a technical project: it picks up the next
task, solves it end to end (code → commit → PR), and leaves behind knowledge that makes
the next task faster. The point is continuous, unattended operation — not one-off help
inside a session someone has to keep driving.

## The loop

1. **Trigger** — the previous task finished, or a new task appeared, or a usage window
   (daily/weekly limit) reopened.
2. **Pick** the next task from the task provider.
3. **Solve** it: implement, commit, open a PR.
4. **Leave knowledge** behind — ADR candidates, glossary terms, todo/bug entries. Partly
   built already: the `document-session-learnings` hook mines a session's transcript into
   `docs/todo/` and `CONTEXT.md` on `SessionEnd`.
5. Wait for the next trigger.

## Task provider

The queue is not one hardcoded source. A provider aggregates tasks from wherever they
legitimately come from — an external tracker, `docs/todo/` (`type: todo` / `type: bug`),
and other sources added later as the need appears. The loop only deals in "the next
task"; it doesn't need to know which source it came from.

## Scope now (MVP)

- **Reusable core** — hooks and skills that apply to any project, installed onto a
  specific target project. Project-specific hooks/skills accumulate on top of that core
  over time, as instrumenta learns the target project's particulars.
- **PR is the endpoint.** The agent opens the PR; merging into the target branch stays a
  human action. Autonomy stops at the PR, for now.
- **One project, one agent, no parallelism.** A single agent instance works a single
  project's queue serially. Running against multiple projects, or multiple tasks at once
  within one project, is out of scope for the MVP.
