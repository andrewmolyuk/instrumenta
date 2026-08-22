import { join } from 'node:path'
import { redactCredentials } from './redact.mts'

async function run(cmd: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    // git doesn't consistently put its failure reason on stderr — e.g. "nothing to
    // commit" and some auth-related push failures land on stdout — so both streams
    // are captured, not just stderr, or the thrown message can end up empty.
    const stdout = (await new Response(proc.stdout).text()).trim()
    const stderr = (await new Response(proc.stderr).text()).trim()
    const detail = [stdout, stderr].filter(Boolean).join('\n') || '(no output on stdout or stderr)'
    throw new Error(redactCredentials(`Command failed (${cmd.join(' ')}): ${detail}`))
  }
}

/** True if `origin/<branch>` exists in a repo already cloned into `workDir`. */
async function remoteBranchExists(workDir: string, branch: string): Promise<boolean> {
  const proc = Bun.spawn(['git', 'rev-parse', '--verify', '--quiet', `origin/${branch}`], {
    cwd: workDir,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return (await proc.exited) === 0
}

/**
 * Checkout the target project on a branch named after jira_key (architecture.md).
 * Sets a local (repo-scoped, not global) commit identity — a fresh container has
 * none configured, and `git commit` refuses to run without one.
 *
 * `reuseExisting` (true unless the caller already knows this branch has an open
 * PR — see orchestrate.mts): when a remote branch of this name already exists,
 * checks it out instead of branching fresh from the base tip. Without this, a
 * retry after a crash that happened *after* a successful push (e.g. PR creation
 * failing on a bad base-branch config) always re-branches from the base and
 * collides on push — `git push` rejects it as non-fast-forward against the
 * branch the earlier attempt already pushed, every time, until the ticket gives
 * up — even though real, possibly-correct work is sitting on that branch. `git
 * checkout <branch>` DWIMs into tracking `origin/<branch>` here since the clone
 * just above fetched it but never checked it out locally.
 */
export async function cloneAndBranch(
  repoUrl: string,
  branch: string,
  workDir: string,
  reuseExisting: boolean,
): Promise<void> {
  await run(['git', 'clone', repoUrl, workDir])
  if (reuseExisting && (await remoteBranchExists(workDir, branch))) {
    await run(['git', 'checkout', branch], workDir)
  } else {
    await run(['git', 'checkout', '-b', branch], workDir)
  }
  await run(['git', 'config', 'user.name', process.env.MINION_GIT_AUTHOR_NAME ?? 'instrumenta-minion'], workDir)
  await run(
    ['git', 'config', 'user.email', process.env.MINION_GIT_AUTHOR_EMAIL ?? 'minion@instrumenta.invalid'],
    workDir,
  )
}

export async function writeNote(workDir: string, notesPath: string, filename: string, content: string): Promise<void> {
  const dir = join(workDir, notesPath)
  await Bun.write(join(dir, filename), content)
}

/** Stages everything currently in the working tree, without committing. */
export async function stageAll(workDir: string): Promise<void> {
  await run(['git', 'add', '-A'], workDir)
}

/**
 * Stages everything currently in the working tree, commits, and pushes the branch.
 *
 * `--no-verify` (ADR-009): the target project's `pre-commit` checks already ran,
 * once, as part of the gate (`runPreCommitHook`, verify-gate.mts) — letting the
 * commit run them a second time would repeat the project's whole lint/test
 * toolchain for no new information, and a failure at this point is a crash with
 * nothing pushed instead of a retryable `failed_verify`. It also skips
 * `commit-msg` (commitlint): the message this is given is already built to
 * conform (`fix:`/`chore:`, lowercased subject — see orchestrate.mts), and a
 * rule it still trips can no longer take the attempt down with it.
 */
export async function commitAndPush(workDir: string, branch: string, message: string): Promise<void> {
  await stageAll(workDir)
  await run(['git', 'commit', '--no-verify', '-m', message], workDir)
  await run(['git', 'push', '-u', 'origin', branch], workDir)
}
