import type { MinionInput } from '../src/minion/types.mts'

/**
 * "The agent implements the task" (architecture.md) — the real Claude Code
 * invocation is explicitly out of scope for this slice: it needs live
 * credentials and a real target repo to test meaningfully, and is the
 * highest-risk part of Minion on its own. This attempts
 * `claude --dangerously-skip-permissions -p <description>` if the CLI is on
 * PATH and best-effort only — a missing or failing `claude` binary doesn't
 * abort the run, it just means no changes get made and the verify step (if
 * any) runs against whatever the repo already looked like.
 */
export async function implementTask(
  workDir: string,
  input: MinionInput,
  command: string[] = ['claude', '--dangerously-skip-permissions', '-p', input.description],
): Promise<void> {
  try {
    const proc = Bun.spawn(command, { cwd: workDir, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    await proc.exited
  } catch {
    // Command not available — real invocation is out of scope here.
  }
}
