import type { MinionInput, MinionResult, MinionRunner } from './types.mts'

/** Cap on captured crash/timeout output — keeps the tail, where the relevant part usually is. */
const MAX_CAPTURED_OUTPUT_CHARS = 4000

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
      stderr: 'pipe',
    })
    proc.stdin.write(JSON.stringify(input))
    await proc.stdin.end()

    const timedOut = await Promise.race([
      proc.exited.then(() => false),
      Bun.sleep(timeoutMs).then(() => true),
    ])

    if (timedOut) {
      proc.kill()
      await proc.exited
      // Capture whatever Minion printed before being killed — same reasoning
      // as the crashed case below: the container (run with `--rm`) is gone
      // by the time anyone looks, so this is the only record of how far it got.
      const stdout = (await new Response(proc.stdout).text()).trim()
      const stderr = (await new Response(proc.stderr).text()).trim()
      return { status: 'timeout', pr_url: null, output: combineOutput(stdout, stderr) }
    }

    const stdout = (await new Response(proc.stdout).text()).trim()
    const parsed = parseResult(stdout)
    if (parsed) return parsed

    // A non-zero exit with no valid result on stdout is exactly ADR-001's
    // "crashed" — Minion exited without reporting a structured result at
    // all. Capture whatever it did print — stdout, plus stderr, where a
    // Node/Bun uncaught exception's stack trace lands — since the container
    // itself (run with `--rm`) is already gone by the time anyone looks.
    const stderr = (await new Response(proc.stderr).text()).trim()
    return { status: 'crashed', pr_url: null, output: combineOutput(stdout, stderr) }
  }
}

function combineOutput(stdout: string, stderr: string): string | null {
  const combined = [stdout, stderr].filter(Boolean).join('\n---stderr---\n')
  if (!combined) return null
  return combined.length > MAX_CAPTURED_OUTPUT_CHARS
    ? `…(truncated)…\n${combined.slice(-MAX_CAPTURED_OUTPUT_CHARS)}`
    : combined
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
