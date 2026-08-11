#!/usr/bin/env bun
/**
 * PreToolUse guard for Bash — blocks `git merge` and `gh pr merge` invocations
 * that would create a merge commit.
 *
 * Enforces CLAUDE.md's Workflow rule: history stays linear. `git merge` is
 * required to carry --ff-only — anything else, including a plain `git merge`,
 * risks a merge commit the moment the branch isn't already fast-forwardable.
 * `gh pr merge` is required to carry --rebase — --merge and --squash are also
 * blocked, since a bare `gh pr merge` (no flag at all) can still fall back to
 * the repository's default merge method and produce a merge commit.
 */
import { isGhPrMerge, isGitMerge, segments, stripQuotes } from './utils/shell.mts'

const FF_ONLY = /--ff-only\b/
const REBASE = /--rebase\b/

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function commandFrom(raw: string): string {
  try {
    return JSON.parse(raw || '{}')?.tool_input?.command ?? ''
  } catch {
    return ''
  }
}

const command = commandFrom(await readStdin())

for (const segment of segments(command)) {
  const stripped = stripQuotes(segment)

  if (isGitMerge(segment) && !FF_ONLY.test(stripped)) {
    process.stderr.write(
      'Blocked: `git merge` requires --ff-only — without it, it can still create a merge ' +
        'commit. See CLAUDE.md\'s Workflow section ("Keep history linear"). Rebase onto the ' +
        'target branch first, then merge with --ff-only.\n',
    )
    process.exit(2)
  }

  if (isGhPrMerge(segment) && !REBASE.test(stripped)) {
    process.stderr.write(
      'Blocked: `gh pr merge` requires --rebase — without it (or with --merge/--squash) it ' +
        'can still produce a merge commit. See CLAUDE.md\'s Workflow section ' +
        '("Keep history linear").\n',
    )
    process.exit(2)
  }
}

process.exit(0)
