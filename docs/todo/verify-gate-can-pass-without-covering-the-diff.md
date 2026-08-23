---
type: bug
status: open
date: 2026-08-23
source: session e51bd41f-5fad-402f-b5b7-ebdb1acf2f4e
---

# Nothing records that the gate ran no check against the changed files

`verifyCommand` (minion/verify-gate.mts:25) already documents that CGS/webui's `verify`
script is the literal string `true`, and offers `MINION_VERIFY_COMMAND` as the way out.
All three attempts observed on this target ran with that override unset and all three
recorded `> verify > true` — RPG-6006 at `[01:32]`, RPG-6004 at `[02:44]`, and RPG-6012,
which is the one where it mattered: the prompt printed `npm run verify`, the transcript
shows it resolving to `> verify > true`, and `npm run lint` / `npm run test` ran only
because the agent read `.husky/pre-commit` itself and chose to. Both of those resolve to
`apps/webui2`; all 13 changed files were in `apps/webui`, which declares neither script.
No automated check touched the diff — the other two attempts changed `apps/webui2` files,
which lint and test do cover, so the vacuous `verify` is constant and the coverage is luck.
The attempt was recorded `status: 'success'` with nothing anywhere saying otherwise — the
disclosure in the PR body came from the agent volunteering it, not from the pipeline.

`session.mts:36` already solves the same shape of problem for a different input: an empty
problem statement gets a **⚠ The agent was given no problem statement** banner stamped into
the session record. The cheap equivalent here is a warning line next to **Cost** whenever
`verifyCommand()` is still the default *and* the target's `verify` script body is a no-op
(`true`, `exit 0`, a bare `echo`) — `hasVerifyScript` (line 30) already parses that
`package.json`, so it has the string in hand. Detecting the harder half — a gate whose
checks are real but scoped to a workspace the diff never touched — is a bigger job and
probably not worth attempting; naming the vacuous case is most of the value, since it is
the one that recurs on every attempt against this target.
