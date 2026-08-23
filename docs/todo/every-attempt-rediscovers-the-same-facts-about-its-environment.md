---
type: todo
status: open
date: 2026-08-23
source: session e51bd41f-5fad-402f-b5b7-ebdb1acf2f4e
---

# Every attempt pays to rediscover facts Minion already has

The implement prompt names one half of the gate and gestures at the other: "`${verifyCommand()}`
… plus whatever the project's pre-commit hook runs" (minion/implement-task.mts:129-134). The
agent cannot act on a gesture, so all three attempts observed on CGS/webui spent steps
opening `.husky/` to find out what that hook actually runs — RPG-6012 at `[10:05]`, RPG-6006
at `[01:01]`, RPG-6004 at `[02:11]`. Minion already resolves this itself: `runPreCommitHook`
(minion/verify-gate.mts) locates the hook via `core.hooksPath` before running it, so the
prompt could simply quote the hook's contents (or say plainly that there is none) and the
rediscovery disappears. The cost is not only the steps: in RPG-6004 the hunt continued past
the gate into `vue-tsc`, which the gate does not run — `[04:00]`–`[05:21]`, a `RangeError`,
a retry with `--stack-size=8000`, then a grep to confirm the pre-existing errors it found
were in other people's files. agent-home/CLAUDE.md's "Run the gate's checks, and no others"
was already there and did not hold; naming the checks is a stronger form of the same
instruction than describing them.

Second, smaller instance of the same waste: the agent's shell keeps its working directory
between commands, so a `cd` into a subdirectory silently breaks every later repo-root-relative
path. RPG-6006 (`[00:18]`, `[00:28]`) and RPG-6004 (`[00:53]`, `[01:06]`) each lost three or
four steps to this and recovered only by `cd`-ing back to the absolute clone path, which
Minion chose and could state. One line in agent-home/CLAUDE.md — the clone is at this
absolute path, your shell's cwd persists, prefer absolute paths — covers it.

Neither of these breaks an attempt; both are pure overhead on every attempt, in a pipeline
where a wasted minute is charged to a budget (ADR-008) and an attempt is not retried
(ADR-015).
