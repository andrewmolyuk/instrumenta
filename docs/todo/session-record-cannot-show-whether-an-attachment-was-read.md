---
type: bug
status: open
date: 2026-08-23
source: session e51bd41f-5fad-402f-b5b7-ebdb1acf2f4e
---

# The record claims attachments were "read" and renders every image read as `(no output)`

`toolResult` keeps only the text parts of a tool result (minion/implement-task.mts:321,
`part?.type === 'text'`), and a Claude Code image read returns image blocks, not text — so
the join is empty and line 325 renders it `(no output)`. Every attachment read in every
attempt looks like it returned nothing: RPG-6006's `Read: …/1-details.png → (no output)`,
RPG-6004's two `→ (no output)` lines for both PNGs. A genuinely failed read looks exactly
the same (`is_error` would add a `⚠`, but a read that succeeds and yields an image Claude
never looked at closely, or one whose bytes were unreadable, would not), so the transcript
cannot answer the one question it exists to answer on a screenshot-only ticket. Compounding
it, `buildSessionRecord`'s header says **Attachments read:** (minion/session.mts:65) while
what it actually lists is `ticket.attachments` — what `fetchTicket` *downloaded*. Nothing in
the record distinguishes downloaded from looked at.

Both halves are cheap. In `toolResult`, name the non-text parts instead of dropping them
(`[image]`, `[document]`, or the block's `type`) so an image read reads as `→ [image]` and
an empty one still reads as `(no output)`. In `session.mts`, either rename the header to
**Attachments downloaded:** or, better, cross-reference: the transcript now shows which
attachment paths the agent actually opened, so the header can mark the ones it never
touched. This matters most on exactly the ticket class that motivated attachment support in
the first place — RPG-5427, whose entire description was one screenshot — because a silent
regression in image reading would be invisible in the record while the attempt still
produced a confident-looking PR.
