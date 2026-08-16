---
type: bug
status: resolved
date: 2026-08-16
source: session db97cd55-f412-44b1-9715-e64f9becbf9f
---

# Foreman's `make dev` container exited unexpectedly after finishing a dispatch

During a KAZ-8280 dispatch (started 2026-08-15T21:44:22Z, finished 21:58:46Z per the
recorded attempt row — 14 minutes of real work, ending with `status: crashed`), the
Foreman container itself died sometime after the dispatch finished: `docker ps -a`
showed no Foreman container at all moments later, and because `--rm` was set on the
`dev` target the exited container was auto-removed, so no `docker logs` were available
to diagnose it. The attempt's own `output` field was also empty by the time it was
queried, so the underlying crash reason from that run was unrecoverable at the time.

**Root cause confirmed** on a later KAZ-8280 attempt, once the output-capture fixes
(`f172c80`, `9c0c036`) surfaced the real error: Minion's final commit,
`minion/orchestrate.mts` (`commitAndPush` in `minion/git.mts`), builds its subject from
the raw Jira description — `fix: KAZ-8280: In previous versions checking the "terms and
conditions" once was enough`. The target repo's Husky `commit-msg` hook (commitlint)
rejects that subject under the `subject-case` rule (sentence-case is disallowed by the
conventional-commit preset most target repos use). `commitAndPush`'s `git commit` exits
non-zero, `git.mts`'s `run()` throws, and nothing in `orchestrate.mts` catches it —
so the whole Minion process crashes instead of reporting a structured result, taking the
container down with it. The earlier `fix:`/`chore:` prefix change (`4273006`) fixed the
commit *type* but missed that commitlint also validates the subject *text*, which is
free-form Jira copy and often starts capitalized.

Fixed in two parts on `minion/orchestrate.mts` (`fix/kaz-8280-commitlint-crash` branch):
1. Lowercase the first character of the description before it goes into the commit
   subject, so this specific `subject-case` rejection can't recur.
2. `commitAndPush` failures are now caught in `runMinion` and turned into a structured
   `crashed` result (with the git error captured in `output`) instead of an uncaught
   exception — any other commit-msg hook rule a target repo enforces (line length, scope
   format, ...) will now surface as a clean `crashed` attempt instead of taking the
   container down.

`make dev`'s `docker run -i` (no `-t`) was a red herring — not the cause.
