import { join } from 'node:path'

/** The verify-gate convention: a `"verify"` script in package.json's `scripts`. */
export async function hasVerifyScript(workDir: string): Promise<boolean> {
  const file = Bun.file(join(workDir, 'package.json'))
  if (!(await file.exists())) return false

  const pkg = (await file.json().catch(() => null)) as { scripts?: Record<string, unknown> } | null
  return typeof pkg?.scripts?.verify === 'string'
}

/** Runs `npm run verify` in `workDir`. True only on a clean (zero) exit. */
export async function runVerify(workDir: string): Promise<boolean> {
  const proc = Bun.spawn(['npm', 'run', 'verify'], { cwd: workDir, stdout: 'ignore', stderr: 'ignore' })
  const code = await proc.exited
  return code === 0
}
