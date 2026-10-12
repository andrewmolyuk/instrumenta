# Chain specification: ticket triage → coder → reviewer → UI tester

## 1. Ticket triage

**Responsibility**
Reads the source ticket, decides whether it has enough detail for
implementation. If yes — extracts and writes out acceptance criteria
as text. If no — posts the clarifying question to the ticket itself
and the chain ends there for this task. This is not a synchronous
wait: the agent doesn't block and doesn't restart itself — the task
is simply picked up again from scratch the next time the ticket
re-enters the queue (for example, when someone changes its status in
the ticket system).

**Permissions**
- Read-only on project files (no code needed at this step)
- Cannot edit code, cannot commit
- Posts the clarifying comment itself, synchronously, without human
  confirmation — a deliberate exception to the general external-action
  approval rule, justified because a ticket comment is reversible and
  doesn't touch code or production

**MCP access**
- The only agent in the chain with access to the ticket system
  (Jira or equivalent)
- Token scope: read on the ticket, plus write scoped specifically to
  posting a comment (no other ticket operations — status changes,
  assignment, etc. — are reachable with this token)

**Shared resources**
- Reads nothing from `.claude/memory/` (no task context yet)
- Writes nothing to project memory — criteria are passed forward
  through the next agent's spawn prompt, not through a file
- Alongside the extracted criteria, also passes forward the raw text
  of the source ticket — cheap passive context, not meant for every
  agent to read, but so the reviewer can cross-check it against the
  original on the first pass (see section 4) if the extraction
  distorted the meaning somewhere
- Writes `.work/<ticket-id>/state/ticket-snapshot.md` (raw text +
  hash + date) at the moment criteria are extracted — the comparison
  point used when resuming (section 8). This same hash doubles as the
  criteria-generation id — the reviewer's one-time checks (section 4)
  are tied to it directly, no separate identifier is maintained:
  resuming within the same generation doesn't repeat them, a full
  restart with a new generation does

**Model**: a fast/cheap model works — this is a classification task,
no deep reasoning required.


## 2. Coder

**Responsibility**
Writes product code and unit tests against the acceptance criteria it
received. On retries, reads the feedback from the previous attempt
(review comments or screenshot paths) and fixes exactly what's flagged.

**Permissions**
- Always works on the branch named after the ticket (e.g. `KAZ-112`)
  — nobody else works on it in parallel, which is both the task's
  workspace and the safety net for the mechanical test-sanity check
  in the hook (section 3), which would otherwise risk clobbering
  someone else's uncommitted changes
- Read/write on code files
- Can run the linter, unit tests, `git diff`, `git add`, `git commit`
- Destructive database operations, `force push`, `sudo` — blocked by
  the global safety hook, not overridable at the agent level

**MCP access**
- No access to the ticket system — works only with the criteria text
  it was handed
- Read-only database MCP access if needed (inspect the schema), never
  write

**Shared resources**
- On a retry, explicitly receives through the spawn prompt: the
  acceptance criteria (unchanged), review comments or screenshot paths
  from the previous attempt — this is context it wouldn't otherwise
  have, since state doesn't persist across iterations automatically
- Writes: changed files + unit tests to the repository

**Step limit**: higher than the other agents — it needs room to
iterate within its own task.

**Model**: strong — this is where the real reasoning load sits.


## 3. Hook: SubagentStop (after the coder)

Not an agent — a system event handler. Checks the name of whichever
subagent just finished.

**What it does**
- If `coder` finished — first runs the mechanical test-sanity check
  right on the ticket branch via `git stash` (product code is
  temporarily set aside, tests stay): runs the tests — they must
  fail; restores the code, runs again — they must pass. The branch is
  exclusive to this task, so `stash` is safe here — a separate git
  worktree isn't needed.
  - If the check doesn't apply cleanly (conflict on restore) — this
    doesn't vanish silently: a checkpoint is still created (otherwise
    resuming after an unrelated limit would lose code that was
    already written), but it's flagged `unverified`. The flag alone
    doesn't consume an attempt — an attempt is only spent on a
    definitive outcome further down the chain (a fail from the
    reviewer); if the reviewer passes it anyway, the coder's work is
    accepted without spending an attempt. On resume into such a
    checkpoint, the check is retried once (the branch is guaranteed
    exclusive by then, so whatever caused the conflict has likely
    cleared); if it's still inconclusive, we proceed to the reviewer
    with the same flag rather than retrying indefinitely.
  - If the tests pass even without the code (a tautological test) —
    the hook goes straight to the failure counter (section 8) without
    spending a review cycle. This **does** consume one of the three
    attempts: the code has already been written and it doesn't hold
    up — real work that needs redoing, unlike the pre-flight budget
    rejection below, where no work was even attempted.
- Tallies and sums the tokens the coder spent on this attempt,
  appends to `.work/<ticket-id>/state/counter.json` (section 8)
- If the check passes — collects the `git diff` (the list of changed
  files, not just the diff text) and the acceptance criteria,
  records a `coder-passed` checkpoint as its own commit, spawns the
  reviewer
- If someone else finished — no-op (the condition lives inside the
  hook)

**Access**: runs in the session's own context, has no MCP/permissions
of its own — uses whatever the main session already has (git).

**Robustness**: the hook is kept thin — routing and state-writing
only; the heavier logic (the mechanical check itself) lives in a
separate, independently testable script that the hook calls. The
whole dispatcher is wrapped in a top-level try/catch — an uncaught
exception writes a "hook failed" entry to state and follows the same
escalation path as an exhausted attempt limit (section 8), rather
than hanging silently. Every step also has a timeout — a hang counts
as a failure too.


## 4. Reviewer

**Responsibility**
Evaluates the diff against the acceptance criteria and the project's
architectural decisions. Gets a list of changed files from the hook,
not diff text, and reads them in full alongside the surrounding code
— a diff can be locally correct while breaking calling code outside
its own boundaries, which isn't visible from the changed lines alone.

Checks the unit tests on two counts at once: whether a test reflects
the actual outcome described in the acceptance criteria rather than
an implementation detail (otherwise it can pass tautologically), and
whether every acceptance criterion has a test tied to it at all
(criterion → test traceability) — the second catches missing coverage
that the first won't.

On the first pass within the current criteria generation (the hash
from `ticket-snapshot.md`, not the attempt number — resuming within
the same generation doesn't repeat these checks; a new generation
after a full restart runs them again), also cross-checks the
extracted criteria against the raw text of the source ticket (which
it received from the triage agent, not just the finished criteria) —
this catches a case where triage misread the ticket, before that
error survives all three attempts unnoticed.

On the first pass of the same generation, if this is a feature with a
UI check, also cross-checks the UI tester's draft scenario against
the acceptance criteria before it locks in as reusable (no human in
this step — the reviewer itself acts as the confirming party).

**Permissions**
- Read access to the whole repository, not just the diff — cannot
  edit product code
- Can run the linter and static analysis

**MCP access**
- No access to the ticket system
- No database access

**Shared resources**
- Reads `.claude/memory/architecture.md` — cross-checks the diff
  against already-recorded architectural decisions
- Reads `.claude/memory/glossary.md` — for terminology consistency
- Writes nothing to project memory directly — the verdict travels
  through the hook further down the chain

**Output format**: `pass` / `fail`, and on fail, a fail *reason* in
addition to the comment text — specifically, whether the failure is a
**code/test issue** (routes to the coder, section 5) or a **criteria
mismatch** — the ticket cross-check on the first pass caught triage
having misread the ticket (routes back to triage for re-extraction,
not to the coder, since there's no code for the coder to fix here).
Both reasons still consume one of the three attempts — the accounting
stays uniform regardless of which check produced the fail — only the
destination differs.

**Model**: strong — this needs depth of reasoning, not a routine check.


## 5. Hook (after the reviewer)

Checks the review verdict and its fail reason.
- Pass → records a `review-passed` checkpoint as its own commit,
  spawns the UI tester, passes the diff along
- Fail, code/test issue → sends the comments to the failure counter
  (section 8), which routes back to the coder on the next attempt
- Fail, criteria mismatch → routes back to triage for re-extraction
  against the same ticket text (not a full restart in the git/branch
  sense — nothing about the ticket or the branch changed, only the
  extracted criteria need correcting), producing a fresh criteria
  generation and resetting the reviewer's first-pass checks for it.
  This still consumes one of the three attempts.


## 6. UI tester

**Responsibility**
Runs the visual check scenario in a browser, takes screenshots,
compares against expected behavior. Doesn't write or commit tests —
this is a one-off check.

**Permissions**
- Browser automation (clicks, navigation, screenshots)
- Read-only on code — doesn't edit anything in the repository

**MCP access**
- Access to a browser MCP (e.g. Claude in Chrome)
- No access to the ticket system, no write access to the database

**Shared resources**
- On the first pass, drafts a `test-scenario.md`, which the reviewer
  cross-checks in the same cycle (see section 4) — the scenario locks
  in at `.work/<ticket-id>/state/test-scenario.md` only after that,
  with no human involved
- On later iterations, just reads the already-locked scenario
- Writes screenshots to `.work/<ticket-id>/screenshots/`, filename
  pattern `attempt-N_step-M_description.png`
- On a retry, can compare the new screenshot against the previous one
  in the same folder

**Output format**: pass/fail + paths to this attempt's screenshots.


## 7. Hook (after the UI tester)

- Pass → assembles the report, hands it to the main session
- Fail → sends the screenshot paths to the failure counter, which
  routes back to the coder — consumes one of the three attempts, same
  as a code/test-issue review fail


## 8. Failure counter

Not an agent — state tied to a specific task (key: ticket/branch id,
not a global session-wide counter, otherwise parallel tasks would
step on each other — though concurrent runs of the same ticket are
excluded at the process level, so race conditions aren't treated as a
risk here).

**Shared resource**: `.work/<ticket-id>/state/counter.json` — holds
the attempt count, the cumulative token spend across every step of
this attempt (coder, test check, reviewer, UI tester), and the
accumulated feedback (comments + screenshots) to pass to the coder.

The full session of every attempt (the entire coder → hook → reviewer
→ tester exchange, including the prompts themselves — agent
versioning isn't needed separately, the fact is already recorded
verbatim) is saved in full at
`.work/<ticket-id>/state/attempt-N-session.md`. The hook writes these
programmatically, after each step, rather than a separate agent
summarizing after the fact. If the mechanical test check (section 3)
couldn't apply the rollback cleanly, that's captured in the session
record too as "check inconclusive: <reason>" rather than vanishing
silently — the reviewer sees this flag and backs it up with its own
judgment.

**Logic**
- < 3 attempts and within the token budget → back to the coder with
  the full accumulated feedback
- The budget is checked pre-flight, before each step starts, with a
  QoS margin: if the remaining budget is under 5% of the cap, the
  step doesn't start at all, even if there's technically still
  something to spend — braking early, not right up against zero
- `.work/<ticket-id>/state/counter.json` keeps attempts and budget as
  two independent fields, not one counter: a step that never started
  because of budget doesn't spend one of the three attempts — that's
  a separate stop reason, kept distinct for anyone reviewing later
- 3 attempts reached, OR the budget QoS threshold trips (whichever
  comes first) → stop, keeping the last checkpoint reached (see below)

**Resuming on a later run**
- Before continuing from a checkpoint, the ticket's content hash (or
  update date) is compared against
  `.work/<ticket-id>/state/ticket-snapshot.md`, saved by the triage
  agent at the moment criteria were extracted. If the ticket changed
  — the current contents of `state/` and `screenshots/` are moved in
  full, mirroring their structure, into
  `.work/<ticket-id>/stale-<timestamp>/` (not deleted — the "the
  human sees the full history" principle holds through a restart too),
  and work starts over from triage with a new criteria generation
- Also checks whether the main branch has moved ahead of the point
  the `KAZ-112` branch was cut from. If so — the same archiving into
  `stale-<timestamp>/`, and a restart from the current main, with no
  attempt to auto-resolve a potential conflict
- If neither condition triggered — continue from the step after the
  last recorded checkpoint, without repeating the current generation's
  one-time checks (section 4). If the last checkpoint is flagged
  `unverified` — the mechanical test check is retried once before
  continuing further
- Returns to the main session with status "stopped, needs a human",
  linking to every attempt's `attempt-N-session.md` for review

**Upper bound on restarts**
The 3-attempt limit and the budget QoS threshold protect a single
cycle. A restart triggered by a ticket change or branch drift zeroes
out the whole cycle and starts a new one — without an outer limit,
this lets the attempt cap be dodged indefinitely just by editing the
ticket often. `.work/<ticket-id>/restarts.json`, at the ticket's root
level, not inside `state/` (it has to survive every restart it's
meant to cap), limits this to: no more than 2 full restarts per
ticket, i.e. a maximum of 3 cycles of 3 attempts each. Once exhausted
— stop the same way an ordinary attempt limit does, with no further
restarts.


## 9. Main session

**Responsibility**
Dispatcher for the whole chain — decides who to call next (via hooks
or explicitly), assembles the final report, and on a stop, notifies
the human with the full attempt history, not just the last feedback.

**Shared resources**: sees every MCP server and skill in the project
by default (subagents see the same, unless explicitly restricted).


## Permissions table (summary)

| Agent | Writes code | Ticket MCP | Browser MCP | Writes project memory |
|---|---|---|---|---|
| Ticket triage | no | yes (read + comment) | no | no |
| Coder | yes | no | no | no (code only) |
| Reviewer | no | no | no | no |
| UI tester | no | no | yes | screenshots |


---

# Process review

**Strengths**
- Minimal default permissions: the ticket system is reachable by only
  one agent, everyone else works from already-extracted text, not
  direct access — smaller surface for mistakes and leaks
- Explicit role separation at the infrastructure level: the reviewer
  and tester physically cannot edit code — an infrastructure
  guarantee, not a prompt-level agreement
- A numeric safety valve on the coder-review-test cycle guards
  against both infinite looping and unbounded token spend

**Decisions made over the course of review**

1. The failure counter is keyed to the ticket/branch id, not global —
   parallel tasks don't collide.
2. The "needs clarification" loop doesn't wait synchronously: triage
   posts the question and finishes; the task is re-evaluated from
   scratch the next time the ticket re-enters the queue.
3. Triage posts the clarifying comment itself, synchronously, without
   human confirmation — the token is scoped to comment-only write
   access.
4. The reviewer gets the list of changed files and reads them in the
   context of the surrounding code, not just diff text.
5. Unit-test sanity is checked mechanically inside the hook (revert
   the code, tests must fail; restore it, must pass) — only what
   passes this check reaches the reviewer.
6. The full session of every attempt is saved in full alongside the
   screenshots — on a stop, the human sees the whole course of work,
   not just the last feedback.
7. The UI check scenario is cross-checked against the acceptance
   criteria by the reviewer on the first pass, in the same cycle as
   the ordinary diff review — no human involved in this step.
8. The hook writes `retry-state`/session history programmatically,
   after every step — not a separate summarizing agent after the
   fact. The data is already structured (diff, verdict, screenshot
   paths); routing it through another model call risks losing exactly
   what a human needs when reviewing.
9. If the mechanical test check can't apply the rollback cleanly —
   it's flagged "inconclusive" and still goes to the reviewer with
   that flag, rather than vanishing silently or blocking the chain.
10. A tautological test caught by the mechanical check spends an
    attempt — real work needs redoing, unlike a pre-flight budget
    rejection where no work was attempted. A checkpoint flagged
    `unverified` doesn't spend an attempt on its own — only a
    definitive outcome downstream does.
11. The reviewer's one-time checks (ticket cross-check, scenario
    validation) are scoped to the criteria generation (the ticket
    hash), not the attempt number — resuming within a generation
    skips them, a fresh generation after a restart repeats them.
12. On a full restart (ticket changed, or main drifted), existing
    `state/` and `screenshots/` are archived into
    `stale-<timestamp>/` at the ticket's root, mirroring their
    structure — never deleted.
13. An outer cap of 2 full restarts (3 cycles total) lives in
    `restarts.json`, outside `state/`, so it survives the very
    restarts it limits.
14. A reviewer fail specifically caused by a criteria/ticket mismatch
    routes back to triage for re-extraction, not to the coder — the
    coder has no code-level problem to fix in that case. Both fail
    reasons still consume an attempt; only the destination differs.

**Working folder structure**

Everything tied to a specific ticket lives in one place, not scattered
across `.claude/memory/`:

```
.work/<ticket-id>/
├── restarts.json              <- survives restarts, never archived
├── screenshots/
│   └── attempt-N_step-M_description.png
├── state/
│   ├── ticket-snapshot.md     <- hash doubles as the criteria-generation id
│   ├── counter.json
│   ├── test-scenario.md
│   ├── attempt-1-session.md
│   ├── attempt-2-session.md
│   └── attempt-3-session.md
└── stale-<timestamp>/         <- archive on a full restart, mirrors
    ├── state/                    the structure in full, never deleted
    └── screenshots/
```

`.work/` is entirely in `.gitignore` — an ephemeral workspace for one
task, not curated project memory. `.claude/memory/` (glossary,
architecture) stays separate — what should outlive a single ticket and
make sense apart from it. The ticket's folder can be cleaned up or
archived once it's closed (see "still open" below).

**`.work/` as a channel between subagents, not just a log**

The coder, reviewer, and tester all have default read access to
repository files, including `.work/`. That means, on top of data
passed through the spawn prompt (see the agent descriptions above),
any of them can read `.work/<ticket-id>/state/` directly — past
sessions, the locked scenario, the counter's state — if it needs more
context than what the hook explicitly handed it.

The two channels aren't interchangeable:
- The critical minimum (acceptance criteria, the specific feedback
  from the previous attempt) is always explicit in the prompt,
  deterministically. An agent shouldn't have to guess to check a file
  to find out what to change.
- `.work/` is an additional layer for when an agent needs deeper
  history — not a substitute for explicit passing.

**Still open**

- Archiving `.work/<ticket-id>/` once the ticket closes — clean up
  right away, or keep it around for a while in case it reopens. This
  is handled by a separate process as needed, outside this
  specification.

The full architecture review of the system as a whole (hook
resilience, token budget, checkpoint/resume, test traceability, and
the rest) lives in a separate document: `architecture_review.md`
(in Russian) — including the reviewer fail-routing fix above, added
there as decision 28.
