---
type: todo
status: open
date: 2026-08-10
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
