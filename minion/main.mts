import type { MinionInput } from '../src/minion/types.mts'
import { buildCloneUrl, createPullRequest, type BitbucketPrConfig } from './bitbucket-pr.mts'
import { cloneAndBranch, commitAndPush, writeNote } from './git.mts'
import { implementTask } from './implement-task.mts'
import type { MinionDeps } from './orchestrate.mts'
import { runMinion } from './orchestrate.mts'
import { hasVerifyScript, runVerify } from './verify-gate.mts'

function requiredEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

/**
 * Minion's entrypoint (architecture.md). Reads MinionInput as JSON from
 * stdin, credentials and target-repo config from the container's environment
 * (inherited from Foreman's own env — ProcessMinionRunner doesn't override
 * `env`, so whatever Foreman's container has is what Minion sees too), and
 * writes exactly one MinionResult as JSON to stdout — the structured result
 * ProcessMinionRunner parses. The clone URL is derived from the Bitbucket
 * config (see buildCloneUrl) rather than its own env var, so there's one
 * source of truth for which repo this is.
 */
async function main(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text()) as MinionInput
  const notesPath = process.env.NOTES_PATH ?? 'docs/todo/'
  const workDir = `/tmp/minion-${input.task_id}`

  const bitbucket: BitbucketPrConfig = {
    workspace: requiredEnv('BITBUCKET_WORKSPACE'),
    repoSlug: requiredEnv('BITBUCKET_REPO_SLUG'),
    token: requiredEnv('BITBUCKET_TOKEN'),
    base: process.env.BITBUCKET_BASE_BRANCH,
  }
  const repoUrl = buildCloneUrl(bitbucket)

  const deps: MinionDeps = {
    cloneAndBranch,
    implementTask,
    hasVerifyScript,
    runVerify,
    writeNote,
    commitAndPush,
    createPullRequest: (branch, taskInput) => createPullRequest(bitbucket, branch, taskInput),
  }

  const result = await runMinion(input, repoUrl, workDir, notesPath, deps)
  console.log(JSON.stringify(result))
}

if (import.meta.main) {
  await main()
}
