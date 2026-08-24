---
type: todo
status: open
date: 2026-08-24
source: session e51bd41f-5fad-402f-b5b7-ebdb1acf2f4e
---

# A `given_up` attempt leaves no comment in Jira explaining why

When an attempt ends `given_up`, nothing is posted to the ticket in Jira — a human sees only
that the ticket dropped out of the backlog, with no indication of what failed. This showed up
concretely with RPG-6062: the gate failure was a flake in the target project's own test suite
(`branding-info.spec.ts`, `deviceConfig.spec.ts` — module-level state leaking between tests,
unrelated to the agent's diff — see [ADR-019](../adr/019-a-gate-check-gets-one-retry.md)), and
without a Jira comment naming the failing tests, a human reviewing the ticket has no way to
tell a flake from a real failure without digging into Foreman's attempt history directly.

Discussed alongside ADR-019 (which addresses the retry side of this same incident) but not
implemented — the user chose to ship the retry only. Worth a comment on `given_up` (and
plausibly `failed_verify` generally) that names what failed, so the ticket carries its own
diagnosis instead of relying on someone thinking to check Foreman.
