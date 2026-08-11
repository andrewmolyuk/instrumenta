/**
 * Pure helpers for document-session-learnings.mts, split out so the logic that
 * decides *whether* and *what* to mine is unit-testable without actually
 * spawning the detached `claude -p` sub-call (that call's output is content, so
 * no test can assert on it — this is the part that isn't).
 */

/** `logout` ends the whole account session, not work on this project — everything else (`clear`, `other`, `prompt_input_exit`, and any future reason) is in scope. */
export function shouldRun(reason: string): boolean {
  return reason !== 'logout'
}

/**
 * Set on the detached `claude -p` sub-call so its own SessionEnd can't fire this
 * hook again. The sub-call runs in the project directory under the project's
 * settings, so without this it ends, triggers the hook, and spawns a third
 * generation — observed accelerating to 12 spawns in 2.5 minutes and not
 * self-limiting. The marker file cannot catch this: it is keyed by session id,
 * and every sub-call gets a fresh one.
 */
export const CHILD_ENV_FLAG = 'DOCUMENT_SESSION_CHILD'

/** True when we are running inside a mining sub-call (or anything it spawned — env is inherited by the whole subtree). */
export function isChildRun(env: Record<string, string | undefined>): boolean {
  return Boolean(env[CHILD_ENV_FLAG])
}

const LOG_PREFIX = 'document-session-learnings-'
const LOG_NAME_RE = /^document-session-learnings-\d{4}-\d{2}\.log$/
/** Current month plus this many previous ones stay on disk. */
export const LOG_RETENTION_MONTHS = 3

/** The log file a run on `date` appends to — one per calendar month, UTC so a run never straddles two names. */
export function logFileName(date: Date): string {
  return `${LOG_PREFIX}${date.toISOString().slice(0, 7)}.log`
}

/**
 * Which of `names` are month logs old enough to drop. Months are compared as
 * `YYYY-MM` strings, which sort chronologically, so no date parsing is involved
 * beyond deriving the cutoff. Anything not matching the month-log pattern is
 * left alone — this only ever deletes files it can prove it wrote.
 */
export function expiredLogFiles(names: string[], now: Date): string[] {
  const cutoff = logFileName(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - LOG_RETENTION_MONTHS, 1)),
  )
  return names.filter((name) => LOG_NAME_RE.test(name) && name < cutoff)
}

type TranscriptEntry = {
  type?: string
  message?: { content?: string | Array<{ type?: string; text?: string }> }
}

/** A single line's worth of user/assistant text, or '' if the line isn't one (or is malformed). */
function textFromLine(line: string): string {
  if (!line.trim()) return ''
  let entry: TranscriptEntry
  try {
    entry = JSON.parse(line)
  } catch {
    return ''
  }
  if (entry.type !== 'user' && entry.type !== 'assistant') return ''
  const content = entry.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('')
  }
  return ''
}

/**
 * Concatenates user/assistant text from a JSONL transcript and keeps only the
 * last `maxChars` characters — the most recent part of a long session, same
 * as the reference implementation's `tail -c`.
 */
export function extractTranscriptText(transcriptContent: string, maxChars: number): string {
  const text = transcriptContent
    .split('\n')
    .map(textFromLine)
    .filter((t) => t.length > 0)
    .join('\n')
  return text.length > maxChars ? text.slice(-maxChars) : text
}

export const MIN_TRANSCRIPT_CHARS = 500

const PROMPT_TEMPLATE = `This session is ending. Review the transcript below and decide whether anything in it
is worth permanently recording in this repo's docs/todo/ directory. Be conservative: this
runs unattended with no one to review your output before the session disappears, so
writing nothing is better than writing something wrong, speculative, or duplicate.

Your file-write permission is path-scoped (enforced, not just requested) to
docs/todo/** — a write anywhere else, including docs/adr/, will be rejected, so
don't attempt it. This hook never writes decisions directly, even for
something that looks like a settled architectural choice: write it as a docs/todo/ entry
with \`type: adr-candidate\` instead, and include the real alternatives that were
discussed so a human can turn it into a proper ADR later without re-deriving them from
the transcript.

Three categories, one destination (docs/todo/), distinguished by frontmatter \`type\`:

1. **adr-candidate** — a decision genuinely settled in this conversation (not just
   discussed as an option), with real alternatives considered and rejected, that
   constrains future work.
2. **bug** — something identified as actually wrong, not a vague "improve X sometime."
3. **todo** — a concrete, actionable gap or follow-up that isn't a bug.

Before writing ANYTHING:
- Grep docs/todo/ and docs/adr/ for existing content covering the same topic. If
  something close already exists, do not create a duplicate — skip it. Ignore any ADR
  carrying a "Superseded by" banner under its title: it is kept for the reasoning that
  produced it, not as a live claim, so it cannot be what already covers a topic.
- If nothing in the conversation clears these bars, do nothing and say so.

One file per distinct item, kebab-case slug, frontmatter:

---
type: adr-candidate | bug | todo
status: open
date: {{DATE}}
source: session {{SESSION_ID}}
---

# <short title>

<one or two sentences: what, and why it matters. For adr-candidate, list the alternatives
considered so a human doesn't have to re-derive them.>

Keep it to genuinely distinct items actually discussed in this conversation — do not
invent alternatives, fixes, or context that weren't actually part of the discussion.

End your final message with exactly one line starting with "RESULT:", e.g.
"RESULT: wrote docs/todo/foo.md, docs/todo/bar.md" / "RESULT: nothing worth documenting
this session." Nothing runs after this call, so that line is the only record of what
happened.

--- Conversation transcript (may be truncated to the most recent portion) ---
{{TRANSCRIPT}}`

export function buildPrompt(dateStr: string, sessionId: string, transcriptText: string): string {
  return PROMPT_TEMPLATE.replace('{{DATE}}', dateStr)
    .replace('{{SESSION_ID}}', sessionId)
    .replace('{{TRANSCRIPT}}', transcriptText)
}

/** Scoped so the sub-call really is read-mostly: it can find and dedup against existing docs but can only write inside docs/todo/. */
export function scopedSettings(): string {
  return JSON.stringify({
    permissions: {
      allow: ['Read', 'Grep', 'Glob', 'Edit(docs/todo/**)'],
      deny: ['Bash'],
      defaultMode: 'dontAsk',
    },
  })
}
