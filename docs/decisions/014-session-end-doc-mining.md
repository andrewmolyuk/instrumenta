# 014 — Session-end doc mining: everything lands in `docs/todo/`, nothing writes decisions

Date: 2026-08-10. Prior art: an existing repository of mine already runs this exact
pattern by hand (`document-session-learnings.sh`) — this ADR adapts it for Instrumenta
rather than designing from nothing.

## Context

A working session like this one produces decisions, bugs, and open questions that only
survive if someone writes them down before the session ends. That's been done by hand all
session. The ask: a `SessionEnd` hook that mines the transcript automatically and saves
what it finds under `docs/`.

The reference implementation splits its target into two tiers by risk: bugs/todos are
written directly (a `status` field makes a wrong one cheap to correct), while ADR and
knowledge candidates are only staged to an untracked note for a human to promote next
session — because `docs/decisions/` (this repo's equivalent) is a near-immutable
historical record, the hook runs with no one able to review its output before the session
disappears, and a bad unattended guess there is expensive to undo.

## Decision

**One target, not two: everything found lands in `docs/todo/`, and the hook never writes
to `docs/decisions/`.** A candidate architectural decision becomes a `docs/todo/` entry
with `type: adr-candidate` in its frontmatter, not a staged note in a second location.
This is simpler than the reference's two-tier split and keeps the same safety property by
construction — `docs/decisions/` is never a path the hook's sub-call can write to at
all, so there's no immutability risk to reason about per-write. The cost is that
promoting a candidate to a real ADR is a fully manual step next session (read
`docs/todo/`, run `to-adr`-style judgment, write the ADR, close the todo) — no staged
draft to shortcut it, matching how the `docs-consistency-check` skill already expects
findings to be reported and decided by a human, not auto-applied.

**Categories, one destination:** architectural-decision candidates, bugs/gaps, and
generic todos are all `docs/todo/*.md`, distinguished by a `type` field
(`adr-candidate` | `bug` | `todo`), each with a mutable `status`. One file per distinct
item, kebab-case slug.

**Trigger: `SessionEnd` where `reason` is `clear` or `other`/`prompt_input_exit` —
excluding `logout`.** The reference matched only `clear`; this covers "closing or
clearing" as asked, and excludes `logout` because that's an account-wide sign-out, not
the end of work on this project specifically.

**Mechanism, carried over from the reference almost unchanged:** the hook shells out to a
detached, permission-scoped `claude -p` sub-call (`--settings` allow-listing
`Read`/`Grep`/`Glob`/`Edit(docs/todo/**)`, denying `Bash`) so the actual mining is a real
content-authorship pass, not string matching. `async: true` and a background-detached
process (Node/Bun `spawn(..., { detached: true }).unref()`, the JS equivalent of the
reference's `setsid`/`disown`) so `SessionEnd`'s short timeout never blocks the session
tearing down. Two guards, not one: a marker file stops the _same_ session spawning twice,
and an environment flag set on the sub-call stops it spawning _recursively_. The second
was added after the first proved insufficient in practice — the sub-call runs in the
project directory under the project's settings, so its own `SessionEnd` re-entered this
hook with a fresh session id no marker could match, and generations accelerated rather
than converged. The sub-call is instructed
to grep `docs/todo/` and `docs/decisions/` first and skip anything already covered —
dedup lives in the prompt, not in code, same as the reference.

**Model:** Sonnet 5, matching ADR-009's reasoning for the orchestrator's own agents —
this repo's stated bet is effort, not buying quality with a stronger model per role, and
that applies to its own tooling too.

## Consequence for `CLAUDE.md`'s Verification section

This hook's actual output — what it decides is worth writing — is not something a
deterministic gate can check, unlike `block-main-commit.mts` and
`block-co-authored-by.mts`. What _is_ tested: the deterministic logic before the
detached call (reason filtering, marker dedup, transcript-length gate). The content
decision itself is explicitly outside gate coverage, and `CLAUDE.md` already asks to "say
plainly when no gate covers what changed" — this is that case, named up front rather than
discovered later.

## Reversibility

Two-way door. Splitting back into a two-tier staged/direct model later (if `docs/todo/`
turns out to need the extra safety tier for `adr-candidate` items specifically) is a
prompt and destination-path change, not a redesign of the detach/permission mechanism.

## Revisit trigger

`adr-candidate` todos accumulate unreviewed for multiple sessions — evidence the
one-directory model isn't getting looked at any more often than a second, more visible
staging location would have been.
