#!/usr/bin/env bun
/**
 * PreToolUse guard for Bash — blocks `git commit` carrying a Co-Authored-By trailer.
 *
 * Enforces CLAUDE.md's Workflow rule. `includeCoAuthoredBy: false` in the user's
 * global settings already stops Claude Code adding one on its own; this is the
 * gate that also catches a trailer written into the message by hand.
 *
 * Note the deliberate asymmetry: the `git commit` invocation is detected on the
 * quote-stripped segment (so `grep "git commit"` is not a commit), but the
 * trailer is searched in the raw segment — it lives *inside* the message quotes,
 * which is exactly the text stripQuotes blanks out.
 *
 * Not covered: `git commit -F file` / `--file`, where the message never appears
 * in the command line.
 */
import { isGitCommit, segments } from './shell-utils.mts'

const CO_AUTHORED = /co-authored-by\s*:/i

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
  if (isGitCommit(segment) && CO_AUTHORED.test(segment)) {
    process.stderr.write(
      'Blocked: Co-Authored-By trailers are not used in this repository — ' +
        "see CLAUDE.md's Workflow section. Commit the message without it.\n",
    )
    process.exit(2)
  }
}

process.exit(0)
