---
type: bug
status: open
date: 2026-08-13
source: session 8c4a9ce1-2399-44fc-a492-a9515b69f9c8
---

# Instrumenta's own GitHub repo ruleset blocks rebase-merge via `gh`/API

This is about the GitHub repo Instrumenta's own source lives in (PR review/merge
workflow), not the Bitbucket target-repo pipeline the product implements.

The repo ruleset's `required_signatures` rule is incompatible with `rebase and merge`
performed through the GitHub API/`gh`: GitHub creates a new commit for the rebase and
signs it itself, and that self-signing has been failing consistently (`verified: true`
on the original commit made no difference — confirmed by switching commit signing from
GPG to SSH and re-verifying the key was accepted by GitHub, which did not fix it).
Since the ruleset only allows `rebase` as a merge method (no squash), there's no
alternate merge method to fall back to.

Workaround used repeatedly this session: disable the ruleset (or its
`required_signatures` rule) immediately before each merge. Separately observed: the
ruleset switched itself back from `disabled` to `active` between merges at least twice
without anyone in this session re-enabling it — cause unconfirmed (suspected external
automation or policy sync), not investigated further.

If this keeps recurring, the narrower fix discussed but not applied is to permanently
drop `required_signatures` from the ruleset (keeping `code_scanning`,
`required_linear_history`, etc.) rather than disabling the whole ruleset per merge.
