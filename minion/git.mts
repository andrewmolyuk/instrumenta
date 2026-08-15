import { join } from 'node:path'

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
    throw new Error(`Command failed (${cmd.join(' ')}): ${detail}`)
  }
}

/**
 * Checkout the target project on a branch named after jira_key (architecture.md).
 * Sets a local (repo-scoped, not global) commit identity — a fresh container has
 * none configured, and `git commit` refuses to run without one.
 */
export async function cloneAndBranch(repoUrl: string, branch: string, workDir: string): Promise<void> {
  await run(['git', 'clone', repoUrl, workDir])
  await run(['git', 'checkout', '-b', branch], workDir)
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

/** Stages everything currently in the working tree, commits, and pushes the branch. */
export async function commitAndPush(workDir: string, branch: string, message: string): Promise<void> {
  await run(['git', 'add', '-A'], workDir)
  await run(['git', 'commit', '-m', message], workDir)
  await run(['git', 'push', '-u', 'origin', branch], workDir)
}
