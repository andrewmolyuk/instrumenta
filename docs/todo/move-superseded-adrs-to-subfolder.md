---
type: todo
status: open
date: 2026-08-10
source: session b42aefde-cc6a-4c62-96e8-c373e27962a5
---

# Move superseded ADRs into a subfolder once something loads them programmatically

`docs/decisions/017-knowledge-layer.md` superseded six ADRs (004, 007, 010, 013, 015, 016)
and left them in place with a "Superseded by" banner rather than moving them, so that
`docs-consistency-check`'s worked examples keep resolving by number, and because the
number is the address: "ADR-004" is cited in prose throughout the repo, and a subfolder
makes that resolve two ways depending on whether the ADR is still live. That's the right
call while `docs/decisions/*.md` is read only by
prose-following agents (the consistency-check skill, the SessionEnd dedup grep), both of
which tolerate — and now explicitly skip — superseded files.

The tradeoff was decided, not left open: superseded files stay flat in `docs/decisions/`
until the knowledge port (ADR-003/017) becomes a real, code-level consumer that loads ADR
files as context for a second project. At that point six of seventeen files being dead
weight (35%) stops being cosmetic — it's read as retrieval noise by the exact mechanism
the project's thesis is about precision for. Revisit then; a subfolder move at that point
is ~13 mechanical link updates, not a redesign.
