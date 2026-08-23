---
type: bug
status: open
date: 2026-08-23
source: session e51bd41f-5fad-402f-b5b7-ebdb1acf2f4e
---

# `git add -A` ships two kinds of churn Minion itself caused

`stageAll` is a bare `git add -A` (minion/git.mts:212), so anything the attempt happens to
have touched goes into the commit and the PR. Two things reliably do, and RPG-6012 only
escaped both because the agent went looking. **Line endings:** its edits wrote LF into
CRLF files, and `git diff --stat` came back 589 insertions / 592 deletions for what should
have been a handful of lines; the agent noticed at step `[13:19]`, ran `file` over every
changed path, rebuilt the edits with explicit `\r\n`, and the stat collapsed to normal. A
whole-file rewrite passes any gate and is unreviewable, which makes this the one case worth
*blocking* on rather than warning about: compare `git diff --numstat` against `git diff
--ignore-all-space --numstat` after implementTask and refuse to commit when they diverge
wildly. **Lockfiles:** agent-home/CLAUDE.md correctly tells the agent to run the project's
own install, `npm install` rewrote `package-lock.json` with 25 insertions / 50 deletions of
unrelated churn, and the agent reverted it by hand at `[12:58]` (`git show
HEAD:package-lock.json > package-lock.json`). Minion induces that, so Minion should undo
it: restore lockfiles to `HEAD` before staging unless the diff also touches the
corresponding manifest.
