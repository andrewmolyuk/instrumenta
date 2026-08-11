# Domain Glossary

The ubiquitous language for this project. Terms here are canonical — code, UI copy, and
docs use these words. Implementation details do not belong in this file.

## Task lifecycle

**Task provider**:
The component that aggregates tasks from every source the loop can pull from (an
external tracker, `docs/todo/`, and others added later) into a single "next task." The
loop deals only with this abstraction, not with which source a task came from.

**Claimed**:
A task with an open branch or PR whose name matches the task's slug. It is being worked
on and is not eligible to be picked again while it stays claimed.

**Free**:
A task with no open branch or PR matching its slug. Eligible to be picked next. A
closed, non-merged PR does not keep a task claimed.

**Done**:
A task whose file has been removed from `main`. This happens the moment the PR solving
it is merged — merging, not committing, is what finalizes "done."
