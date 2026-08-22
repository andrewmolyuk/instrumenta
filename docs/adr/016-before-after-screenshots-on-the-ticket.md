# 016 — Before/after screenshots go on the Jira ticket

Date: 2026-08-22

## Context

Most tickets this pipeline works are UI bugs, and most are reported as a screenshot —
RPG-5427's entire description is one. Since ADR-012 the agent can see that screenshot,
and since Chromium was added to the image it can render the page itself. What a reviewer
still cannot see is whether the fix actually changed what it claims to have changed: the
pull request contains a CSS diff and a written assertion that it works.

A before/after pair answers that in a glance. The question was only where to put it.

## Options considered

- **A** — Attach both images to the pull request.
- **B** — Commit both PNGs to the branch and reference them from the PR description.
- **C** — Attach both to the Jira ticket.

## Decision

**C.** The agent writes `before.png` and `after.png` into `${workDir}-shots`, and Minion
uploads whatever is there to the ticket via `POST /rest/api/3/issue/{key}/attachments`.

- The directory sits *beside* the work tree, not inside it. `commitAndPush` runs
  `git add -A`, so a screenshot written into the clone would be committed and shipped in
  the pull request.
- Filenames are fixed, so nothing has to be reported back: an agent that could not render
  the view leaves the directory empty and `attachToTicket` returns false. Not being a
  visual ticket is the common case, and it costs nothing.
- Both are offered even when the attempt then fails its gate — the pair still shows what
  the agent was looking at.
- The prompt asks for the "before" to be captured *first*, before any edit, and for both
  frames to match. A pair shot at different sizes or after the fact proves nothing.

**Why not A, the pull request:** Bitbucket's UI shows an attachments panel on a PR, but the
API does not expose it — a `GET` on a pull request returns links for `activity`, `approve`,
`comments`, `commits`, `decline`, `diff`, `diffstat`, `html`, `merge`, `request-changes`,
`self` and `statuses`, and nothing for attachments. There is no endpoint to post to.

**Why not B, committing them:** it would put the images where the reviewer already is,
which is the strongest argument for it. But binaries would then merge into the target
repository permanently, growing it by two PNGs per visual ticket forever, to serve a
review that lasts a day.

C also puts them where the person who *reported* the bug is looking, usually with the
screenshot they filed it with — so the comparison sits next to the original complaint.

## Consequences

- The reviewer in Bitbucket has to open the ticket to see the pair, and nothing in the PR
  says it is there. Adding that link was considered and deliberately left out for now; if
  visual tickets become common it is a one-line footer on the PR description.
- Attachments accumulate on the ticket. ADR-015's one-attempt rule caps this at one pair
  per ticket, which is what makes it acceptable; at three attempts it would have been six.
- Minion now writes to Jira in a third way — status mirror (Foreman), comment (ADR-014),
  attachment (here). All from credentials it has held since ADR-012.
- Whether the agent can render a "before" at all is unproven. It has Chromium, but the
  target app needs building and serving, which may not be practical inside an attempt. If
  it usually cannot, this costs a few wasted turns per visual ticket and delivers nothing.

## Reversibility

Two-way door. Deleting `attachToTicket`, the prompt section and the collection step
removes it; nothing depends on the images existing, and nothing else reads the directory.

## Revisit trigger

If agents routinely fail to produce the pair, the blocker is running the target app rather
than anything decided here — fix that or drop the feature, but do not paper over it with
screenshots of something other than the real view. If reviewers ask where the images are,
add the PR footer.
