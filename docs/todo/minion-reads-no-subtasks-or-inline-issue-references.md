---
type: bug
status: open
date: 2026-08-23
source: session e51bd41f-5fad-402f-b5b7-ebdb1acf2f4e
---

# A ticket that points at other issues arrives at the agent as a dangling reference

`fetchTicket` reads `?fields=summary,description,attachment` (minion/jira.mts:72) and
nothing else — no `subtasks`, `issuelinks`, `parent` or `comment` — and `adfToPlainText`
walks only `text`, `hardBreak`, `media` and the block types (src/task-provider/adf.mts:15,
24), so an `inlineCard`, a `blockCard`, a `mention` and the `link` mark on a text node all
render as the empty string. Together these turn a ticket whose body *is* a pointer into a
ticket with no body: RPG-6012's problem statement reached the agent as `Follow subtasks of
.` — the trailing period is where the linked parent issue used to be — plus three bare
subtask titles and no subtask text. The agent said three times in its report that it had
no ticket access, inferred the whole design from YANG trees in the target repo's skills
directory, asked a human to "sanity-check the premise before the details", and shipped a
13-file diff that deletes a working NPB feature on the strength of that guess. Cost $8.51,
and ADR-015 allows no second attempt. For scale: two attempts on the same target the same
day, given tickets whose problem statement was actually present, spent $0.74 (RPG-6006) and
$1.65 (RPG-6004) and each produced a one-file fix with prior art cited — the cost of this
gap is mostly paid in guesswork, not in tokens spent reading.

Two fixes, both small and independently useful. In `adf.mts`, give cards, mentions and link
marks the same treatment `media` already has (line 32 exists because this exact class of
silent loss cost RPG-5427 an attempt) — `attrs.url` / `attrs.text` / the mark's `href`
rendered inline; `tests/adf.test.mts` covers six node types and none of these. In
`jira.mts`, add the missing fields and follow the referenced keys one hop with a shallow
`?fields=summary,description` read each, capped (~10), rendered into the prompt as a
"Related tickets" section the way `attachmentSection` already handles files. Lower stakes
but also lossy in the same walk: `listItem` emits a bare newline so list items are
indistinguishable from prose (which is how RPG-6012's three subtask titles arrived),
`codeBlock` loses its fencing, and table cells concatenate with no separator.
