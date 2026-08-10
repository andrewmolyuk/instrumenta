---
type: todo
status: done
date: 2026-08-10
resolved: 2026-08-10
source: manual — docs-consistency-check finding 2, deferred pending access to Repo A/B
---

# Verify the tool:rule breakdown behind vision.md's "one class" of seven corrective commits

`docs/vision.md`'s "Direct evidence for the thesis" table describes seven corrective
commits across Repo A/B as "all one class — security-scanner false positives and
HTML-taint warnings." A read of the one-line descriptions suggests this may actually be
two classes: ~5 commits plausibly share one `tool:rule` (XSS/HTML-taint), while the
pwn-request-vector (Repo A) and object-injection (Repo B) commits look like distinct,
one-off rules under the same broad "scanner false positive" umbrella — not literally
recurring under the same key.

This doesn't affect the retrieval mechanism (ADR-004/007's `tool:rule` key is well
defined either way), only how strong `vision.md`'s motivating narrative actually is. Not
verifiable from this machine — Repo A/B are real repositories, anonymized here, not
accessible in this environment. Check the actual tool/rule identifiers behind those seven
commits from a machine with access, and either tighten `vision.md`'s wording or confirm
"one class" holds as written.

## Resolution (2026-08-10)

Verified against both repositories. "One class" does not hold, and the sample was
undercounted. The seven commits span five distinct `tool:rule` keys; a full in-window
sweep finds ten scanner-driven corrective commits across nine of the seventy PRs, under
six keys:

| Key                                                         | Commits (repo, PR)                                   |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| `xss/no-mixed-html` (eslint-plugin-xss)                     | A #118, A #123, B #132                               |
| `security/detect-object-injection` (eslint-plugin-security) | B #94, B #97, B #118                                 |
| `javascript.express.security.injection.raw-html-format`     | B #100 ×3 (one finding, iterated within a single PR) |
| `avoid-v-html` (Semgrep Vue XSS audit)                      | B #101                                               |
| `node-ssrf`                                                 | B #118                                               |
| Opengrep pwn-request (`workflow_run` + `head_sha`)          | A #100                                               |

Three corrections to the old wording:

1. **The pwn-request commit was a real vulnerability**, not a false positive — a fork PR
   could reach a job holding repo secrets and `packages:write`. It never belonged in a
   false-positive tally.
2. **Two commits were missing** from the table, both in-window and both same-key
   recurrences that strengthen the claim: B #94 (`detect-object-injection`, the first of
   three) and B #132 (`xss/no-mixed-html`, the same rule as Repo A's two).
3. **The recurrence is cross-repository.** `xss/no-mixed-html` fires in both codebases —
   the case [ADR-004](../decisions/004-knowledge-scopes.md)'s shared scope exists for.

The headline 8.6% survives, for different reasons and a different set of PRs: six of
seventy PRs carry a corrective commit re-solving one of the two recurring keys.

Worth keeping in view: B #118's commit message reads "Switched to a Map, which is what
ADR-0018 already settled on the two previous times this came up." A written decision was
retrieved and reapplied by hand on the third occurrence — the thesis working, manually.

`docs/vision.md` rewritten accordingly.
