import type { Database } from 'bun:sqlite'
import { giveUpAttemptCount } from '../db/queries.mts'
import { closedPrCountForBranch, type GitHubConfig } from '../github/closed-prs.mts'
import type { BacklogItem, TaskProvider } from '../task-provider/types.mts'

/** ADR-001: given up the moment either source crosses this, whichever happens first. */
const GIVE_UP_THRESHOLD = 3

/**
 * Both sources are checked on every call — GitHub isn't a fallback used only
 * when SQLite is empty, it can independently trigger give-up (ADR-001).
 */
export async function isGivenUp(
  db: Database,
  github: GitHubConfig,
  jiraKey: string,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const sqliteCount = giveUpAttemptCount(db, jiraKey)
  const closedPrCount = await closedPrCountForBranch(github, jiraKey, fetchImpl)
  return sqliteCount >= GIVE_UP_THRESHOLD || closedPrCount >= GIVE_UP_THRESHOLD
}

/**
 * Foreman's Pick step (CONTEXT.md): the first item in the Task Provider's live,
 * ordered backlog that isn't given up. `null` means nothing eligible right now
 * — Foreman's loop sleeps a poll interval and tries again (architecture.md).
 */
export async function pick(
  db: Database,
  taskProvider: TaskProvider,
  github: GitHubConfig,
  fetchImpl?: typeof fetch,
): Promise<BacklogItem | null> {
  const backlog = await taskProvider.listBacklog()
  for (const item of backlog) {
    if (!(await isGivenUp(db, github, item.jira_key, fetchImpl))) {
      return item
    }
  }
  return null
}

/**
 * ADR-003's start[ticket]: `jiraKey` on the next iteration, bypassing normal
 * priority ordering. Give-up eligibility still applies — ADR-003 only says
 * ordering is bypassed, not the give-up check, so a human forcing a task back
 * that's already hit the threshold isn't something this implements.
 */
export async function pickSpecific(
  db: Database,
  taskProvider: TaskProvider,
  github: GitHubConfig,
  jiraKey: string,
  fetchImpl?: typeof fetch,
): Promise<BacklogItem | null> {
  const backlog = await taskProvider.listBacklog()
  const item = backlog.find((candidate) => candidate.jira_key === jiraKey)
  if (!item) return null
  if (await isGivenUp(db, github, item.jira_key, fetchImpl)) return null
  return item
}
