import { hasOpenPrForBranch } from '../src/bitbucket/closed-prs.mts'
import type { MinionInput } from '../src/minion/types.mts'
import { buildCloneUrl, createPullRequest, type BitbucketPrConfig } from './bitbucket-pr.mts'
import { cloneAndBranch, commitAndPush, hasChanges, stageAll, writeNote } from './git.mts'
import { implementTask } from './implement-task.mts'
import { commentOnTicket, fetchTicket, type MinionJiraConfig } from './jira.mts'
import type { MinionDeps } from './orchestrate.mts'
import { runMinion } from './orchestrate.mts'
import { hasVerifyScript, runPreCommitHook, runVerify } from './verify-gate.mts'

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
    reviewers: process.env.BITBUCKET_PR_REVIEWERS?.split(',')
      .map((uuid) => uuid.trim())
      .filter(Boolean),
  }
  const repoUrl = buildCloneUrl(bitbucket)

  // Minion reads its own ticket (ADR-012), so it needs Jira credentials of its
  // own — passed through MINION_COMMAND's `-e` list like every other secret here.
  const jira: MinionJiraConfig = {
    baseUrl: requiredEnv('JIRA_BASE_URL'),
    email: requiredEnv('JIRA_EMAIL'),
    apiToken: requiredEnv('JIRA_API_TOKEN'),
  }

  const deps: MinionDeps = {
    cloneAndBranch,
    hasOpenPrForBranch: (branch) => hasOpenPrForBranch(bitbucket, branch),
    fetchTicket: (jiraKey, attachmentDir) => fetchTicket(jira, jiraKey, attachmentDir),
    implementTask,
    hasVerifyScript,
    runVerify,
    // Staged first because `lint-staged`-style pre-commit hooks only inspect the
    // index — an unstaged tree makes them pass without checking anything. The
    // same `git add -A` runs again inside commitAndPush, which also picks up
    // whatever an auto-fixing hook (`eslint --fix`, prettier) just rewrote.
    runPreCommitChecks: async (workDir) => {
      await stageAll(workDir)
      return await runPreCommitHook(workDir)
    },
    hasChanges,
    commentOnTicket: (jiraKey, text) => commentOnTicket(jira, jiraKey, text),
    writeNote,
    commitAndPush,
    createPullRequest: (branch, taskInput, ticket, agentReport) =>
      createPullRequest(bitbucket, branch, taskInput, ticket, agentReport),
  }

  const result = await runMinion(input, repoUrl, workDir, notesPath, deps)
  console.log(JSON.stringify(result))
}

if (import.meta.main) {
  await main()
}
