import type { Database } from 'bun:sqlite'
import { closedPrCountForBranch, hasOpenPrForBranch, type BitbucketConfig } from '../bitbucket/closed-prs.mts'
import { giveUpAttemptCount } from '../db/queries.mts'
import type { BacklogItem, TaskProvider } from '../task-provider/types.mts'

/** ADR-001: given up the moment either source crosses this, whichever happens first. */
const GIVE_UP_THRESHOLD = 3

/**
 * Both sources are checked on every call — Bitbucket isn't a fallback used
 * only when SQLite is empty, it can independently trigger give-up (ADR-001).
 */
export async function isGivenUp(
  db: Database,
  bitbucket: BitbucketConfig,
  jiraKey: string,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  const sqliteCount = giveUpAttemptCount(db, jiraKey)
  const closedPrCount = await closedPrCountForBranch(bitbucket, jiraKey, fetchImpl)
  return sqliteCount >= GIVE_UP_THRESHOLD || closedPrCount >= GIVE_UP_THRESHOLD
}

/**
 * ADR-007: an open PR means a human still needs to review/merge it, not that
 * the task is eligible for another dispatch — Jira's own status doesn't move
 * to Done until that human does it themselves, so this check can't be left
 * to the live query the way "given up" and "still open" are.
 */
async function isEligible(
  db: Database,
  bitbucket: BitbucketConfig,
  jiraKey: string,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  if (await isGivenUp(db, bitbucket, jiraKey, fetchImpl)) return false
  if (await hasOpenPrForBranch(bitbucket, jiraKey, fetchImpl)) return false
  return true
}

/**
 * Foreman's Pick step (CONTEXT.md): the first item in the Task Provider's live,
 * ordered backlog that isn't given up. `null` means nothing eligible right now
 * — Foreman's loop sleeps a poll interval and tries again (architecture.md).
 */
export async function pick(
  db: Database,
  taskProvider: TaskProvider,
  bitbucket: BitbucketConfig,
  fetchImpl?: typeof fetch,
): Promise<BacklogItem | null> {
  const backlog = await taskProvider.listBacklog()
  for (const item of backlog) {
    if (await isEligible(db, bitbucket, item.jira_key, fetchImpl)) {
      return item
    }
  }
  return null
}

/**
 * ADR-005's queue[ticket] (amends ADR-003's start[ticket]): `jiraKey` on the
 * next iteration, bypassing normal priority ordering. Eligibility (give-up,
 * and ADR-007's open-PR check) still applies — ADR-003 only says ordering is
 * bypassed, not eligibility itself, so a human forcing back a task that's
 * already hit the give-up threshold, or that already has a PR open, isn't
 * something this implements (see deleteAttempts, db/queries.mts, for the
 * actual way to force one eligible again).
 */
export async function pickSpecific(
  db: Database,
  taskProvider: TaskProvider,
  bitbucket: BitbucketConfig,
  jiraKey: string,
  fetchImpl?: typeof fetch,
): Promise<BacklogItem | null> {
  const backlog = await taskProvider.listBacklog()
  const item = backlog.find((candidate) => candidate.jira_key === jiraKey)
  if (!item) return null
  if (!(await isEligible(db, bitbucket, item.jira_key, fetchImpl))) return null
  return item
}
