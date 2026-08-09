#!/usr/bin/env bun
/**
 * PreToolUse guard for Bash — blocks `git commit` while on local main.
 *
 * Enforces CLAUDE.md's Workflow rule: never commit on local main, branch first.
 * Matches per command segment with quote-aware parsing so unrelated commands
 * run while sitting on main are never blocked — see shell-utils.mts.
 *
 * Runs under Bun (~29ms) — also verified working under Node >= 23.6 (~60ms),
 * which strips TypeScript types natively. The .mts extension pins ESM
 * regardless of what a future root package.json declares.
 */
import { execFileSync } from 'node:child_process'
import { isGitCommit, segments } from './shell-utils.mts'

/**
 * `git branch --show-current`, not `git rev-parse --abbrev-ref HEAD`: rev-parse
 * fails on a repository with no commits yet, which would silently disable this
 * guard at exactly the moment the first commit is made.
 */
function currentBranch(): string {
  try {
    return execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

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
  if (isGitCommit(segment) && currentBranch() === 'main') {
    process.stderr.write(
      'Blocked: committing directly on main. Create/switch to a feature branch first — ' +
        'see CLAUDE.md\'s Workflow section ("Never commit on local main").\n',
    )
    process.exit(2)
  }
}

process.exit(0)
