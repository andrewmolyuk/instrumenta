import type { MinionInput } from '../src/minion/types.mts'
import { cloneAndBranch, commitAndPush, writeNote } from './git.mts'
import { createPullRequest, type GitHubPrConfig } from './github-pr.mts'
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
 * ProcessMinionRunner parses.
 */
async function main(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text()) as MinionInput
  const repoUrl = requiredEnv('TARGET_REPO_URL')
  const notesPath = process.env.NOTES_PATH ?? 'docs/todo/'
  const workDir = `/tmp/minion-${input.task_id}`

  const github: GitHubPrConfig = {
    owner: requiredEnv('GITHUB_OWNER'),
    repo: requiredEnv('GITHUB_REPO'),
    token: requiredEnv('GITHUB_TOKEN'),
    base: process.env.GITHUB_BASE_BRANCH,
  }

  const deps: MinionDeps = {
    cloneAndBranch,
    implementTask,
    hasVerifyScript,
    runVerify,
    writeNote,
    commitAndPush,
    createPullRequest: (branch, taskInput) => createPullRequest(github, branch, taskInput),
  }

  const result = await runMinion(input, repoUrl, workDir, notesPath, deps)
  console.log(JSON.stringify(result))
}

if (import.meta.main) {
  await main()
}
