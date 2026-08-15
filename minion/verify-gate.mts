import { join } from 'node:path'
import { MAX_VERIFY_OUTPUT_CHARS } from './constants.mts'

/** The verify-gate convention: a `"verify"` script in package.json's `scripts`. */
export async function hasVerifyScript(workDir: string): Promise<boolean> {
  const file = Bun.file(join(workDir, 'package.json'))
  if (!(await file.exists())) return false

  const pkg = (await file.json().catch(() => null)) as { scripts?: Record<string, unknown> } | null
  return typeof pkg?.scripts?.verify === 'string'
}

export interface VerifyResult {
  /** True only on a clean (zero) exit. */
  passed: boolean
  /** Combined stdout+stderr, tail-truncated to MAX_VERIFY_OUTPUT_CHARS — where failures are summarized. */
  output: string
}

/** Runs `npm run verify` in `workDir`, capturing its output for a human (or a retry) to see why it failed. */
export async function runVerify(workDir: string): Promise<VerifyResult> {
  const proc = Bun.spawn(['npm', 'run', 'verify'], { cwd: workDir, stdout: 'pipe', stderr: 'pipe' })
  const passed = (await proc.exited) === 0
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const combined = `${stdout}${stderr}`.trim()
  const output =
    combined.length > MAX_VERIFY_OUTPUT_CHARS
      ? `…(truncated)…\n${combined.slice(-MAX_VERIFY_OUTPUT_CHARS)}`
      : combined
  return { passed, output }
}
