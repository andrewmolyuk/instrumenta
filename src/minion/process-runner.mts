import type { MinionInput, MinionResult, MinionRunner } from './types.mts'

/**
 * Starts Minion as a subprocess (in production, `docker run ...`), waits
 * synchronously for it to exit, and reads one structured result from stdout —
 * architecture.md's Minion contract. `command` is injected rather than
 * hardcoded to `docker run`, since nothing about the wait/timeout/parse logic
 * here is actually Docker-specific.
 *
 * `input` goes over stdin as JSON rather than CLI args, so it never shows up
 * in `ps` output (it can carry scoped repo credentials).
 */
export class ProcessMinionRunner implements MinionRunner {
  constructor(private readonly command: string[]) {}

  async run(input: MinionInput, timeoutMs: number): Promise<MinionResult> {
    const proc = Bun.spawn(this.command, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    proc.stdin.write(JSON.stringify(input))
    await proc.stdin.end()

    const timedOut = await Promise.race([
      proc.exited.then(() => false),
      Bun.sleep(timeoutMs).then(() => true),
    ])

    if (timedOut) {
      proc.kill()
      return { status: 'timeout', pr_url: null, output: null }
    }

    const stdout = (await new Response(proc.stdout).text()).trim()
    const parsed = parseResult(stdout)
    // A non-zero exit with no valid result on stdout is exactly ADR-001's
    // "crashed" — Minion exited without reporting a structured result at all.
    return parsed ?? { status: 'crashed', pr_url: null, output: null }
  }
}

function parseResult(stdout: string): MinionResult | null {
  try {
    const parsed = JSON.parse(stdout)
    if (typeof parsed?.status !== 'string') return null
    return { status: parsed.status, pr_url: parsed.pr_url ?? null, output: parsed.output ?? null }
  } catch {
    return null
  }
}
