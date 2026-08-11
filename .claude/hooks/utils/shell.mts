/**
 * Shared helpers for .claude/hooks scripts.
 *
 * Deliberately simple, best-effort shell parsing — just enough to tell a real
 * subcommand invocation apart from the same text appearing inside a quoted
 * string (a grep pattern, an echoed JSON payload). Not a full shell parser.
 * Without this, `grep -n "git commit" file` would trip a guard that only
 * substring-matches the raw command.
 */

const DOUBLE_QUOTED = /"(?:[^"\\]|\\.)*"/g
const SINGLE_QUOTED = /'[^']*'/g

/** Blank out quoted-string contents, keeping the quote characters and the original length so a later regex's boundary logic still lines up. */
export function stripQuotes(command: string): string {
  const blank = (s: string): string => s[0] + ' '.repeat(s.length - 2) + s[s.length - 1]
  return command.replace(DOUBLE_QUOTED, blank).replace(SINGLE_QUOTED, blank)
}

// Trailing (\s|$) rather than \b: \b matches at a hyphen, so `commit\b` would
// also fire on the real subcommands `git commit-tree` and `git commit-graph`.
const GIT_COMMIT = /(^|\s)git\s+commit(\s|$)/

/** True when a segment really invokes `git commit`, ignoring the same text sitting inside a quoted string. */
export function isGitCommit(segment: string): boolean {
  return GIT_COMMIT.test(stripQuotes(segment))
}

// Trailing (\s|$) so `git merge-base`/`merge-tree`/`merge-file` don't match.
const GIT_MERGE = /(^|\s)git\s+merge(\s|$)/
const GH_PR_MERGE = /(^|\s)gh\s+pr\s+merge(\s|$)/

/** True when a segment really invokes `git merge`, not `merge-base`/`merge-tree`/`merge-file`. */
export function isGitMerge(segment: string): boolean {
  return GIT_MERGE.test(stripQuotes(segment))
}

/** True when a segment really invokes `gh pr merge`. */
export function isGhPrMerge(segment: string): boolean {
  return GH_PR_MERGE.test(stripQuotes(segment))
}

/** Split into logical command segments on ; && || | and newlines outside quotes, returning each segment's original unblanked text. */
export function segments(command: string): string[] {
  const marked = stripQuotes(command)
  const parts: string[] = []
  let last = 0
  let i = 0

  while (i < marked.length) {
    const two = marked.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      parts.push(command.slice(last, i))
      i += 2
      last = i
      continue
    }
    const one = marked[i]
    if (one === ';' || one === '|' || one === '\n') {
      parts.push(command.slice(last, i))
      i += 1
      last = i
      continue
    }
    i += 1
  }
  parts.push(command.slice(last))

  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}
