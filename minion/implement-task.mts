import type { MinionInput } from '../src/minion/types.mts'

/** The default argv, split out so it's assertable without actually spawning `claude`. */
export function defaultImplementCommand(input: MinionInput): string[] {
  return ['claude', '--dangerously-skip-permissions', '-p', `${input.jira_key}: ${input.description}`]
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
 * Deliberately best-effort: stdout/stderr are discarded (stdout especially —
 * main.mts's caller writes Minion's one structured MinionResult to its own
 * stdout after this returns, and anything Claude Code printed there would
 * corrupt that JSON), and a missing or failing `claude` binary doesn't abort
 * the run or throw. Whether real work happened is judged downstream by
 * whether there's a verify gate to run and whether it passes
 * (orchestrate.mts) — not by this function's own success.
 */
export async function implementTask(
  workDir: string,
  input: MinionInput,
  command: string[] = defaultImplementCommand(input),
): Promise<void> {
  try {
    const proc = Bun.spawn(command, { cwd: workDir, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    await proc.exited
  } catch {
    // Command not available — caller doesn't treat this as fatal (see above).
  }
}
