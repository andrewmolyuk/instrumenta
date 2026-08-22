import { existsSync } from 'node:fs'
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

/**
 * Where this repo's bare mirror lives inside the cache volume.
 *
 * Derived from the URL's host and path via `new URL`, which drops any
 * `user:password@` for us — the mirror's directory name must not carry the
 * token, and neither must anything written inside it (see updateMirror).
 */
function mirrorPathFor(cacheDir: string, repoUrl: string): string {
  // `new URL` drops any `user:password@` for us, which is the point — but it
  // throws on anything that isn't a URL, and a repo "url" is a plain path in
  // the tests and for anyone pointing Minion at a local remote. Falling back to
  // sanitising the raw string keeps both working; there are no credentials in a
  // path to leak.
  let slug: string
  try {
    const { host, pathname } = new URL(repoUrl)
    slug = `${host}${pathname}`
  } catch {
    slug = repoUrl
  }
  return join(cacheDir, `${slug.replace(/\.git$/, '').replace(/[^a-zA-Z0-9.-]+/g, '-')}.git`)
}

/** The remote with any `user:password@` removed; unchanged if it isn't a URL. */
function withoutCredentials(repoUrl: string): string {
  try {
    const { origin, pathname } = new URL(repoUrl)
    return `${origin}${pathname}`
  } catch {
    return repoUrl
  }
}

/**
 * Brings the bare mirror at `mirrorPath` up to date, creating it if absent.
 *
 * The credentials are passed on the command line every time rather than stored
 * in the mirror's config, so a volume that outlives the container never holds a
 * token. That is also why the fetch names its refspec explicitly: with no
 * `remote.origin.url` to lean on, `git fetch <url>` alone would only update
 * FETCH_HEAD.
 *
 * `--prune` matters more than it looks: without it, a branch deleted on the
 * remote lives forever in the mirror, and `reuseExisting` would keep finding
 * `origin/<jira_key>` for work that no longer exists.
 */
async function updateMirror(mirrorPath: string, repoUrl: string): Promise<void> {
  if (!existsSync(mirrorPath)) {
    await run(['git', 'clone', '--mirror', repoUrl, mirrorPath])
    // Scrub the token `--mirror` just wrote into the mirror's config. The
    // mirror outlives the container on a shared volume; a credential in its
    // config would outlive it too.
    await run(['git', '-C', mirrorPath, 'remote', 'set-url', 'origin', withoutCredentials(repoUrl)])
    return
  }
  await run(['git', '-C', mirrorPath, 'fetch', '--prune', repoUrl, '+refs/heads/*:refs/heads/*'])
}

/**
 * Clones the target repo, through a persistent bare mirror when one is
 * configured (`MINION_GIT_CACHE`, ADR-013).
 *
 * A full clone of the target repository was measured at five to seven minutes —
 * roughly a quarter of a 25-minute attempt — repeated in full on every attempt,
 * because Minion's container is `--rm` and takes its clone with it. Cloning from
 * a local mirror instead is seconds: git hardlinks the objects rather than
 * copying them, so it costs almost no disk either.
 *
 * `origin` is repointed at the real remote afterwards. Without that, the work
 * tree's origin is a path on the cache volume and `git push` would quietly
 * update the mirror instead of Bitbucket.
 *
 * Falls back to a direct clone whenever the cache is unset or unusable: a stale,
 * corrupt or unwritable mirror must cost an attempt some minutes, never the
 * attempt itself.
 */
async function cloneViaCache(repoUrl: string, workDir: string, cacheDir: string): Promise<void> {
  try {
    const mirrorPath = mirrorPathFor(cacheDir, repoUrl)
    await updateMirror(mirrorPath, repoUrl)
    await run(['git', 'clone', mirrorPath, workDir])
    await run(['git', '-C', workDir, 'remote', 'set-url', 'origin', repoUrl])
  } catch (err) {
    console.error(
      `Git cache unusable (${redactCredentials(err instanceof Error ? err.message : String(err))}) — cloning directly.`,
    )
    await run(['git', 'clone', repoUrl, workDir])
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
  const cacheDir = process.env.MINION_GIT_CACHE
  if (cacheDir) await cloneViaCache(repoUrl, workDir, cacheDir)
  else await run(['git', 'clone', repoUrl, workDir])

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
