# Instrumenta — vision

## Why it exists

Instrumenta is a toolkit for building and maintaining a product: a Coding agent, a Review
agent, an orchestrator driving task state from issue to verified PR, and a **Cockpit**
for watching and steering tasks, knowledge, and agents.

The core concept is **knowledge that accumulates**: architectural decisions, how the
codebase works, and what review has already caught feed into later tasks, so the
maintainer stops re-supplying the same context every session. Note the payoff is effort,
not defect rate — the measurements below show output quality already near its ceiling.
Everything else serves that.

Agents are held in check by deterministic gates — tests, lint, security. Gates are
necessary but not distinguishing; every comparable tool has them. The knowledge layer is
what the project is actually betting on.

## What this adds over the status quo

An existing repository of mine is already built this way by hand: Claude Code as the
agent, `.claude/hooks/` as the deterministic gates, skills as reusable procedures, and
written memory in decision and knowledge directories. That is most of Instrumenta,
operated manually.

So the delta is two things, and the project is worth building only if they hold:

1. **Autonomy per task** — the loop from issue to green PR runs without the maintainer
   driving each turn.
2. **Retrieval without recall** — the right prior knowledge reaches the agent because the
   system selected it, not because the maintainer remembered which document to point at.

## Scope right now (MVP)

One repository (Instrumenta itself) · Coding + Review agents **wrapping the Claude Agent
SDK, not written from scratch** · orchestrator with a state machine and event store · a
thin knowledge layer · a read-only Cockpit with an intervene control.

**Thin** is load-bearing. A knowledge entry:

- comes only from a confirmed review finding or a failed gate — never from the Coding
  agent describing its own work;
- is either **project-scoped by path** or **shared across projects by finding class**, the
  two retrieved with different keys ([ADR-004](decisions/004-knowledge-scopes.md)) — so
  retrieval stays close to deterministic instead of leaning on embedding similarity;
- carries the commit that produced it, so it can be invalidated when the code moves;
- may carry a `supersedes` pointer to an entry it replaces.

Without these constraints the knowledge base grows on every task and becomes noise within
weeks — the same failure mode as a bloated CLAUDE.md.

**Deferred:** multiple reviewers · risk tiers · policy engine.
**Dropped, not deferred:** knowledge graph.

Anything outside the list above gets discussed before it gets built, even when it looks
like the obvious next step. Rationale for all of it:
[`decisions/001-mvp-shape.md`](decisions/001-mvp-shape.md).

## How we know it's working

Baselines come from two existing repositories of mine, not from this one, which starts
empty. Both are written entirely with Claude Code, so the status quo being
measured is _maintainer-driven Claude Code_, not a human writing code by hand. Measured
on 2026-08-10 over 70 merged PRs — 40 in Repo A (2026-07-16 → 08-05) and 30 in Repo B
(2026-07-24 → 08-09) — plus 54 logged tasks in Repo A.

**North star — human hours per merged PR. Baseline 1.49 h** (59.75 h logged against 40
merged PRs; median 1.0 h per task, from Repo A's hours log). This is the
metric with headroom, and effort is what autonomy is supposed to buy. Single-repository:
Repo B keeps no hours log, so the quality numbers below span both repositories but this
one does not.

**Quality guardrail — first-pass rate must not fall below 91%.** Measured across two
repositories, both written entirely with Claude Code, by whether a corrective commit
landed after the PR was opened:

| First-pass definition                             | Repo A (40 PRs) | Repo B (30 PRs) |
| ------------------------------------------------- | --------------- | --------------- |
| No post-open commit at all                        | 75.0%           | 70.0%           |
| No post-open `fix:` commit                        | 82.5%           | 76.7%           |
| No post-open `fix:` a gate had not already caught | 95.0%           | 86.7%           |

The third row is the one that matters, and it is why quality is a guardrail rather than
the north star: across all 70 PRs, 91.4% needed no correction that a gate had not already
flagged. That is roughly nine points of headroom — and the two repositories disagree by
eight of them, so treat it as a floor to defend rather than a target to chase.
Instrumenta has to win on effort, because output quality has little left to give.

Every other correction was gate-driven, which is the gates doing their job — and exactly
the class of correction Instrumenta's loop should absorb with no human turn at all.

**Direct evidence for the thesis.** The thesis test below asks that a finding of the same
class never recur. It is recurring now, at a measurable rate. Ten corrective commits
across nine of the seventy PRs answer a security-scanner finding. They are not one class —
six distinct `tool:rule` keys — but two of those keys recur across separate PRs, which is
the case the thesis is actually about:

| Rule key                           | Recurrences                                    |
| ---------------------------------- | ---------------------------------------------- |
| `security/detect-object-injection` | B #94, B #97, B #118 — bracket index → `Map`   |
| `xss/no-mixed-html`                | A #118, A #123, B #132 — **across both repos** |

Six of the seventy PRs (8.6%) carry a corrective commit re-solving one of those two rules.
The rest are singletons under their own keys: `raw-html-format` (B #100, three commits
iterating on one finding), `avoid-v-html` (B #101), `node-ssrf` (B #118), and an Opengrep
pwn-request finding in a release workflow (A #100) that was a real vulnerability, not a
false positive.

`xss/no-mixed-html` is the sharper evidence: it crosses the repository boundary, which is
what ADR-004's shared scope exists for. And the third `detect-object-injection` fix names
its own precedent — "what ADR-0018 already settled on the two previous times this came
up." A human wrote that decision down and an agent found it. The thesis is that neither
step should depend on someone remembering. Each recurrence costs a human turn, which is
where the north star and the thesis meet: knowledge does not have to make the code better,
it has to stop a solved finding being re-solved.

**Consequence for the build:** attribution lives in the event store, not in git. Commits
carry no `Co-Authored-By` trailer — a repository rule, enforced by a hook — so git alone
will never say which agent produced what, exactly as in those repositories today. The
orchestrator already records task state; recording which commits each task produced makes
the north star readable without touching commit hygiene. That is why the event store is
in the MVP and not deferred: without it the thesis cannot be measured at all. Attribution
ships with the orchestrator, not after it.

**Thesis test** — a review finding of the same class must not recur. Binary, needs no
baseline, and tests the knowledge layer directly: a recurrence means knowledge was stored
but never retrieved. This is the metric that decides whether the core concept holds.

**Context guardrail** — issue-to-merge time must not grow as the knowledge base does.
Knowledge carries a context cost; if retrieval is quietly bloating prompts, this is where
it shows up first.

**Horizon** — read at 20 completed tasks, which is also the revisit trigger on the
knowledge decision in ADR-001. Re-measure both baselines from the reference repositories
at the same time: they keep moving, and an August baseline is not a fair comparison in
December.
