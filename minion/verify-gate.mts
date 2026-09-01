import { access, constants } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { MAX_VERIFY_OUTPUT_CHARS } from './constants.mts'

/**
 * What the gate runs, as a shell command.
 *
 * `npm run verify` by default — the convention architecture.md gives the target
 * project. `MINION_VERIFY_COMMAND` overrides it per deployment, in the same
 * spirit as `NOTES_PATH`, because the convention assumes the target *can* offer
 * a working `verify`, and a target may not.
 *
 * Found live on CGS/webui, whose `verify` script is the literal string `true`.
 * hasVerifyScript saw a script and runVerify ran it, so the gate passed
 * unconditionally on every attempt — ADR-009's protection against committing
 * work that does not build, doing nothing at all. Its real checks are
 * `npm run lint` and `npm run test`; its canonical entry points, `make lint` and
 * `make test`, wrap those in `sudo webuic/webuic.sh`, needing a container and
 * root that a Minion has neither of. The commands underneath are reachable, so
 * a deployment can name them.
 *
 * Run through `sh -c`, so an override can be several checks: `npm run lint &&
 * npm run test`.
 */
export function verifyCommand(): string {
  return process.env.MINION_VERIFY_COMMAND?.trim() || 'npm run verify'
}

/** True if this attempt has a gate to run at all: an override, or the `"verify"` script convention. */
export async function hasVerifyScript(workDir: string): Promise<boolean> {
  if (process.env.MINION_VERIFY_COMMAND?.trim()) return true

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

/** Keeps the tail, where a failing toolchain summarizes what went wrong. */
function truncateTail(text: string): string {
  return text.length > MAX_VERIFY_OUTPUT_CHARS ? `…(truncated)…\n${text.slice(-MAX_VERIFY_OUTPUT_CHARS)}` : text
}

export async function capture(command: string[], workDir: string): Promise<VerifyResult> {
  const proc = Bun.spawn(command, { cwd: workDir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const passed = (await proc.exited) === 0
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { passed, output: truncateTail(`${stdout}${stderr}`.trim()) }
}

/** Runs the gate in `workDir`, capturing its output for a human to see why it failed. */
export async function runVerify(workDir: string): Promise<VerifyResult> {
  return await capture(['sh', '-c', verifyCommand()], workDir)
}

export interface PreCommitResult extends VerifyResult {
  /** False when the target project defines no pre-commit hook at all — nothing extra to gate on. */
  ran: boolean
}

/**
 * Where git would look for hooks in this checkout — honours `core.hooksPath`,
 * which is how Husky installs them (`.husky/_`), so this finds the hooks a
 * target project actually uses rather than only the default `.git/hooks`.
 * Note that Husky sets that config from its own `prepare` script, i.e. during
 * the target project's `npm install` — before that has run there are no hooks
 * to find here, and equally none for `git commit` to run, so the gate and the
 * commit agree either way.
 */
async function hooksDir(workDir: string): Promise<string | null> {
  const proc = Bun.spawn(['git', 'rev-parse', '--git-path', 'hooks'], {
    cwd: workDir,
    stdout: 'pipe',
    stderr: 'ignore',
  })
  if ((await proc.exited) !== 0) return null
  const path = (await new Response(proc.stdout).text()).trim()
  if (!path) return null
  return isAbsolute(path) ? path : join(workDir, path)
}

async function isExecutable(path: string): Promise<boolean> {
  return await access(path, constants.X_OK).then(
    () => true,
    () => false,
  )
}

/**
 * Part two of the gate (ADR-009): runs the target project's own `pre-commit`
 * hook — the checks that will block `git commit` — *before* committing, so a
 * failure is reported as `failed_verify` on an attempt that can still be
 * retried instead of surfacing as a crash at commit time.
 *
 * Found live on KAZ-8390: `npm run verify` passed, then the target repo's Husky
 * `pre-commit` hook (`npm run lint`) rejected the commit over two ESLint errors
 * in a file Claude Code had just added. `commitAndPush` threw, the attempt was
 * recorded `crashed`, and ~$9.7 of correct work was thrown away with nothing
 * pushed — the same class of failure as the `commit-msg`/commitlint crash
 * (docs/todo/foreman-container-crashed-after-dispatch-cause-unknown.md), one
 * hook up. The repo's `verify` script didn't cover lint, so nothing before the
 * commit ever ran what the commit itself would run.
 *
 * Invoked directly rather than through `git hook run pre-commit` (git ≥ 2.36
 * only, and not available on the version used for local development), matching
 * what git itself does: execute the hook file, honouring its shebang, with the
 * repo root as cwd. The executable-bit check is git's own precondition for
 * running a hook too — a non-executable file (or the shipped
 * `pre-commit.sample`, which doesn't match this name anyway) is not a gate.
 *
 * Callers stage the working tree first (see main.mts): `lint-staged`-style
 * hooks only look at the index, so an unstaged tree would make them pass
 * vacuously — a false green worse than the crash this replaces.
 */
export async function runPreCommitHook(workDir: string): Promise<PreCommitResult> {
  const dir = await hooksDir(workDir)
  const hook = dir ? join(dir, 'pre-commit') : null
  if (!hook || !(await isExecutable(hook))) return { ran: false, passed: true, output: '' }

  const result = await capture([hook], workDir)
  return { ran: true, ...result }
}
