import { encodeProgress, type MinionProgress } from '../src/minion/progress.mts'
import type { MinionInput } from '../src/minion/types.mts'
import { MAX_IMPLEMENT_OUTPUT_CHARS } from './constants.mts'

/** The model and effort an attempt runs under — resolved once, so the argv and the session report can't disagree. */
export function claudeModel(): string {
  return process.env.MINION_CLAUDE_MODEL ?? 'claude-opus-5[1m]'
}

export function claudeEffort(): string {
  return process.env.MINION_CLAUDE_EFFORT ?? 'high'
}

/**
 * The default argv, split out so it's assertable without actually spawning `claude`.
 * The explicit "implement it, don't just propose it" instruction exists because,
 * found live: without it, Claude Code investigated a real bug correctly, wrote up a
 * root-cause analysis and a proposed fix, then ended the run asking a human to
 * confirm before proceeding — which nobody was there to answer (this is `-p`,
 * one-shot, unattended), so it made zero file changes despite doing real work.
 *
 * The explicit "make the project's own checks pass" instruction exists because,
 * also found live (KAZ-8390): Claude Code finished, reported "npm run lint
 * clean" in its own summary, and the commit was then rejected by the target
 * repo's pre-commit hook over two ESLint errors in a file it had just added —
 * the report was simply wrong, and nothing had asked it to gate on those checks
 * in the first place. Minion re-runs them itself before committing (ADR-009),
 * so this is the cheap loop: fixing a lint error here costs a few tool calls,
 * while finding it in the gate costs the whole attempt.
 *
 * `--model` and `--effort` are set explicitly rather than left to Claude Code's
 * own defaults, so an unattended attempt doesn't silently change model or
 * reasoning depth (and with it cost per attempt, ADR-008) when the CLI's default
 * moves. `claude-opus-5[1m]` is the 1M-context variant of Opus 5 — Minion reads
 * whole target repositories, and running out of context mid-attempt is a wasted
 * attempt. `high` effort is one step below Claude Code's own `xhigh` default:
 * cheaper per attempt, and still in the band Anthropic recommends for
 * long-horizon agentic work. Both are overridable per deployment
 * (`MINION_CLAUDE_MODEL`, `MINION_CLAUDE_EFFORT`) because which model a
 * subscription may use, and how much reasoning a task is worth, are operational
 * choices, not properties of Minion's contract. `--effort` needs a recent Claude
 * Code CLI (the image installs the current one on every build).
 *
 * The explicit "leave the commit to Minion" instruction exists because, also found
 * live: with full tool access, Claude Code sometimes committed its own changes
 * before returning. `orchestrate.mts` always runs its own `commitAndPush` afterward
 * (needed for the no-op case — see implementTask's comment below); running on an
 * already-clean tree, that second commit fails with "nothing to commit," which
 * orchestrate.mts reports as `crashed` even though the real work had already
 * landed in a commit — a false crash on a fully successful attempt.
 */
export function defaultImplementCommand(input: MinionInput): string[] {
  const prompt = `${input.jira_key}: ${input.description}

This is an unattended, one-shot run — there is no human available to answer
questions or approve a plan. Investigate the issue and implement the fix
directly in the codebase yourself. Do not stop to describe or propose a fix
and ask for confirmation; make the actual code changes. Leave the changes
uncommitted — do not run \`git commit\` yourself; committing is handled
separately after you finish.

Before you finish, run this project's own checks over your changes — its
\`verify\`/lint/test/type-check scripts, and whatever its pre-commit hook runs —
and fix everything they report, including problems in files you added. Every one
of those checks is run again before your work is committed, and any failure means
no commit and no pull request, so the whole attempt is wasted. Report a check as
passing only if you actually ran it and saw it pass.`
  return [
    'claude',
    '--dangerously-skip-permissions',
    '--model',
    claudeModel(),
    '--effort',
    claudeEffort(),
    '-p',
    prompt,
    // `stream-json` rather than `json` so the run reports as it goes instead of
    // only at exit: the Cockpit's "Minion now" card shows a live cost and the
    // last few things Claude Code did, and with `json` there is nothing at all
    // to show until the attempt is already over — which, at ~40 minutes an
    // attempt, is exactly when it stops being useful. `--verbose` is not
    // optional decoration: Claude Code refuses `-p --output-format stream-json`
    // without it. The final `result` event carries the same `.result` text and
    // `.total_cost_usd` the single-object form did, so ADR-008's cost capture
    // reads the same field either way.
    '--output-format',
    'stream-json',
    '--verbose',
  ]
}

/**
 * `output` is the same captured diagnostic text this always returned; `costUsd`
 * is Claude Code's own `total_cost_usd` from its `--output-format json` result
 * (docs/todo/measure-claude-api-cost-per-ticket.md) — null whenever that JSON
 * couldn't be parsed (crash, missing binary, non-JSON stdout), not just when
 * cost happens to be zero.
 */
export interface ImplementResult {
  output: string
  costUsd: number | null
  /**
   * One line per stream event — the agent's own trail of tool calls and
   * reasoning, in order. The same lines reported live as progress, kept here
   * so they survive the run: they are what makes an attempt reviewable after
   * the fact, and Claude Code's final `result` text alone is the agent's
   * account of its work rather than a record of it.
   */
  transcript: string[]
}

/**
 * "The agent implements the task" (architecture.md): runs Claude Code
 * unattended, in print mode (`-p`, one-shot, no interactive session) with
 * `--dangerously-skip-permissions` — there's no human present in Minion's
 * sandbox to approve tool calls, matching ADR-002's "ephemeral, sandboxed,
 * runs unattended." Authenticates via `CLAUDE_CODE_OAUTH_TOKEN` in the
 * container's own environment (inherited by Bun.spawn like every other
 * credential here — see ProcessMinionRunner's comment on the same pattern),
 * not a separate config surface. Subscription-based (flat-rate), not
 * `ANTHROPIC_API_KEY` (metered) — see ADR-006.
 *
 * Captures stdout+stderr (tail-truncated) instead of discarding them — found
 * live that a silent no-op run (Claude Code making no file changes at all)
 * was otherwise a total black box, indistinguishable from a real attempt
 * until something downstream failed for an unrelated-looking reason (e.g.
 * `git commit` erroring "nothing to commit"). Never written to Minion's own
 * stdout (main.mts's caller writes Minion's one structured MinionResult to
 * its own stdout after this returns, and anything Claude Code printed there
 * would corrupt that JSON) — but echoed to Minion's own stderr as well as
 * returned to the caller, so it survives even if a later step throws
 * uncaught (bypassing orchestrate.mts's structured return entirely — the
 * exact case that motivated this): ProcessMinionRunner captures Minion's
 * whole-process stdout+stderr as `crashed` output as a fallback, so stderr
 * is the one place this is guaranteed to still be visible.
 *
 * Deliberately best-effort: a missing or failing `claude` binary doesn't
 * abort the run or throw. Whether real work happened is judged downstream by
 * whether there's a verify gate to run and whether it passes
 * (orchestrate.mts) — not by this function's own success.
 */
export async function implementTask(
  workDir: string,
  input: MinionInput,
  command: string[] = defaultImplementCommand(input),
): Promise<ImplementResult> {
  const result = await captureImplementOutput(workDir, command)
  if (result.output) console.error(`--- Claude Code output (${input.jira_key}) ---\n${result.output}`)
  return result
}

/**
 * Reads `stream` to completion, handing each complete line to `onLine` as soon
 * as it arrives rather than after exit — the whole point of stream-json here.
 * Returns the full text as well, so the existing fallback paths still have the
 * raw output to fall back to.
 */
async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<string> {
  const decoder = new TextDecoder()
  let pending = ''
  let full = ''
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true })
    full += text
    pending += text
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line.trim()) onLine(line)
  }
  if (pending.trim()) onLine(pending)
  return full
}

/** Cap on the raw stdout held in memory for the fallback path — a real stream-json run is megabytes of NDJSON that the `result` event makes redundant. */
const MAX_RAW_STDOUT_CHARS = MAX_IMPLEMENT_OUTPUT_CHARS * 2

interface ClaudeEvent {
  type?: unknown
  subtype?: unknown
  result?: unknown
  total_cost_usd?: unknown
  message?: { content?: unknown }
}

/**
 * One short human line describing what an event means, or null for the events
 * worth staying quiet about (tool *results*, above all — they carry whole file
 * contents, and this line ends up in a hover tooltip). Every shape here is
 * probed defensively: this is someone else's stream format, and an unrecognized
 * event costs one skipped progress line, not the attempt.
 */
function summarizeEvent(event: ClaudeEvent): string | null {
  if (event.type === 'system') return event.subtype === 'init' ? 'session started' : null
  if (event.type === 'result') return typeof event.result === 'string' ? 'finished' : 'finished (no result)'
  if (event.type !== 'assistant') return null

  const content = event.message?.content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const firstLine = block.text.trim().split('\n')[0]
      if (firstLine) parts.push(truncate(firstLine, 120))
    }
    if (block?.type === 'tool_use' && typeof block.name === 'string') {
      const input = block.input ?? {}
      const detail = [input.file_path, input.command, input.pattern, input.description].find(
        (v: unknown) => typeof v === 'string' && v.length > 0,
      )
      parts.push(detail ? `${block.name}: ${truncate(String(detail), 100)}` : block.name)
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Runs Claude Code and reads its stream-json stdout as it arrives: each event
 * becomes a progress line on Minion's own stderr (see src/minion/progress.mts
 * for why stderr), while `.result` and `.total_cost_usd` from the final result
 * event become this function's return, exactly as they did when the format was
 * a single `json` object.
 *
 * Falls back to the raw combined stdout+stderr text (the pre-JSON behavior)
 * whenever no event carried a `result` string — a crash, a missing binary, or a
 * test double that doesn't speak this format all still produce something. A
 * lone `{"result":…,"total_cost_usd":…}` object with no `type` is still read as
 * that result, so the older single-object form keeps working too.
 *
 * stdout and stderr are drained concurrently, not one after the other: a child
 * that fills the pipe nobody is reading blocks forever, and a 40-minute Claude
 * Code run produces far more than a pipe buffer holds.
 */
async function captureImplementOutput(workDir: string, command: string[]): Promise<ImplementResult> {
  try {
    const proc = Bun.spawn(command, { cwd: workDir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

    let resultText: string | null = null
    let costUsd: number | null = null
    const transcript: string[] = []

    const [rawStdout, rawStderr] = await Promise.all([
      readLines(proc.stdout, (line) => {
        let event: ClaudeEvent
        try {
          event = JSON.parse(line)
        } catch {
          return
        }
        if (typeof event !== 'object' || event === null) return

        const progress: MinionProgress = {}
        if (typeof event.total_cost_usd === 'number') {
          costUsd = event.total_cost_usd
          progress.cost_usd = costUsd
        }
        if (typeof event.result === 'string') resultText = event.result
        const summary = summarizeEvent(event)
        if (summary) {
          progress.line = summary
          transcript.push(summary)
        }
        if (progress.line !== undefined || progress.cost_usd !== undefined) console.error(encodeProgress(progress))
      }),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    const stdout = tail(rawStdout.trim(), MAX_RAW_STDOUT_CHARS)
    const stderr = rawStderr.trim()
    const output = resultText !== null ? [resultText, stderr].filter(Boolean).join('\n') : [stdout, stderr].filter(Boolean).join('\n')

    return { output: tail(output, MAX_IMPLEMENT_OUTPUT_CHARS), costUsd, transcript }
  } catch (err) {
    // Command not available — caller doesn't treat this as fatal (see above).
    return {
      output: `(claude command failed to start: ${err instanceof Error ? err.message : String(err)})`,
      costUsd: null,
      transcript: [],
    }
  }
}

function tail(text: string, max: number): string {
  return text.length > max ? `…(truncated)…\n${text.slice(-max)}` : text
}
