import { decodeProgress, type MinionProgress } from './progress.mts'
import type { MinionInput, MinionResult, MinionRunner } from './types.mts'

/** Cap on captured crash/timeout output — keeps the tail, where the relevant part usually is. */
const MAX_CAPTURED_OUTPUT_CHARS = 16000

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

  async run(
    input: MinionInput,
    timeoutMs: number,
    onProgress?: (progress: MinionProgress) => void,
  ): Promise<MinionResult> {
    const proc = Bun.spawn(this.command, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    proc.stdin.write(JSON.stringify(input))
    await proc.stdin.end()

    // Both pipes are drained from here on, concurrently and while the child is
    // still running, rather than read once it has exited. Two reasons: a
    // progress line is worthless if it only arrives after the attempt is over,
    // and a child whose pipe nobody drains blocks once the OS buffer fills —
    // which a 40-minute Claude Code run reaches easily.
    const stdoutPromise = readAll(proc.stdout)
    const stderrPromise = readAll(proc.stderr, (line) => {
      const progress = decodeProgress(line)
      if (!progress) return 'keep'
      onProgress?.(progress)
      // Dropped from the captured text: these are Minion's live side-channel,
      // and leaving them in would bury the actual stack trace that explains a
      // crash under hundreds of progress lines.
      return 'drop'
    })

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
      const stdout = (await stdoutPromise).trim()
      const stderr = (await stderrPromise).trim()

      // Minion having already printed its structured result means the attempt
      // *finished* — the kill landed on a process that was done reporting (found
      // live on KAZ-8390 and KAZ-8739: both recorded `timeout`, both with a
      // complete MinionResult sitting in the captured output, including a
      // `cost_usd` this path was otherwise throwing away and the pre-commit
      // failure that actually explained the attempt). That result is what
      // happened, so it wins over the timeout this race reports; a genuine hang,
      // killed before Minion could report anything, still has nothing to parse
      // here and stays `timeout`.
      const reported = parseResult(stdout)
      if (reported) return reported

      return { status: 'timeout', pr_url: null, output: combineOutput(stdout, stderr), cost_usd: null, session: null }
    }

    const stdout = (await stdoutPromise).trim()
    const parsed = parseResult(stdout)
    if (parsed) return parsed

    // A non-zero exit with no valid result on stdout is exactly ADR-001's
    // "crashed" — Minion exited without reporting a structured result at
    // all. Capture whatever it did print — stdout, plus stderr, where a
    // Node/Bun uncaught exception's stack trace lands — since the container
    // itself (run with `--rm`) is already gone by the time anyone looks.
    const stderr = (await stderrPromise).trim()
    return { status: 'crashed', pr_url: null, output: combineOutput(stdout, stderr), cost_usd: null, session: null }
  }
}

/**
 * Reads `stream` to completion and returns its text. When `onLine` is given,
 * every complete line is offered to it as it arrives; lines it answers 'drop'
 * to are left out of the returned text.
 */
async function readAll(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => 'keep' | 'drop',
): Promise<string> {
  const decoder = new TextDecoder()
  let pending = ''
  let kept = ''
  const take = (line: string): void => {
    if (!onLine || onLine(line) === 'keep') kept += `${line}\n`
  }
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) take(line)
  }
  if (pending) take(pending)
  return kept
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
    return {
      status: parsed.status,
      pr_url: parsed.pr_url ?? null,
      output: parsed.output ?? null,
      cost_usd: typeof parsed.cost_usd === 'number' ? parsed.cost_usd : null,
      session: typeof parsed.session === 'string' ? parsed.session : null,
    }
  } catch {
    return null
  }
}
