---
type: bug
status: open
date: 2026-08-23
source: session 18fd2ae7-43f9-4f49-bc94-4a50eb11250c
---

# `JiraTaskProvider.listBacklog` ignores `nextPageToken`, starving Pick once the head is exhausted

`listBacklog` (src/task-provider/jira.mts:47) fetches a single page (`maxResults ?? 50`)
and never follows `nextPageToken`, so Pick can only ever see the first 50 tickets matching
the configured JQL no matter how large the backlog is. This was the proximate trigger for
a 2026-08-23 incident where Pick took no tickets on an unlimited budget: all 50 fetched
tickets had a DECLINED PR and were rejected. ADR-016 fixed the give-up rule so a declined
head no longer stalls the loop permanently, but the pagination gap itself is unfixed —
once the current head of a large backlog is worked through (dispatched, or newly
ineligible for some other reason), Pick will again see only the same unpaginated 50 and
stall, even though hundreds of eligible tickets sit further down the query.
