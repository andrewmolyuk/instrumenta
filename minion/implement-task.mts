import type { MinionInput } from '../src/minion/types.mts'
import { MAX_IMPLEMENT_OUTPUT_CHARS } from './constants.mts'

/**
 * The default argv, split out so it's assertable without actually spawning `claude`.
 * The explicit "implement it, don't just propose it" instruction exists because,
 * found live: without it, Claude Code investigated a real bug correctly, wrote up a
 * root-cause analysis and a proposed fix, then ended the run asking a human to
 * confirm before proceeding — which nobody was there to answer (this is `-p`,
 * one-shot, unattended), so it made zero file changes despite doing real work.
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
separately after you finish.`
  return ['claude', '--dangerously-skip-permissions', '-p', prompt, '--output-format', 'json']
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
 * Claude Code's `--output-format json` prints one JSON object to stdout —
 * `.result` is its final human-readable text (used as the diagnostic output,
 * in place of the raw JSON blob) and `.total_cost_usd` is its own cost
 * estimate. Falls back to the raw combined stdout+stderr text (the pre-JSON
 * behavior) whenever stdout isn't that shape — a crash, a missing binary, or
 * a test double that doesn't speak this format all still produce something.
 */
async function captureImplementOutput(workDir: string, command: string[]): Promise<ImplementResult> {
  try {
    const proc = Bun.spawn(command, { cwd: workDir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
    const stdout = (await new Response(proc.stdout).text()).trim()
    const stderr = (await new Response(proc.stderr).text()).trim()

    const parsed = parseClaudeCodeResult(stdout)
    const output = parsed ? [parsed.output, stderr].filter(Boolean).join('\n') : [stdout, stderr].filter(Boolean).join('\n')
    const costUsd = parsed?.costUsd ?? null

    return {
      output:
        output.length > MAX_IMPLEMENT_OUTPUT_CHARS
          ? `…(truncated)…\n${output.slice(-MAX_IMPLEMENT_OUTPUT_CHARS)}`
          : output,
      costUsd,
    }
  } catch (err) {
    // Command not available — caller doesn't treat this as fatal (see above).
    return { output: `(claude command failed to start: ${err instanceof Error ? err.message : String(err)})`, costUsd: null }
  }
}

function parseClaudeCodeResult(stdout: string): { output: string; costUsd: number | null } | null {
  try {
    const parsed = JSON.parse(stdout)
    if (typeof parsed?.result !== 'string') return null
    const costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null
    return { output: parsed.result, costUsd }
  } catch {
    return null
  }
}
