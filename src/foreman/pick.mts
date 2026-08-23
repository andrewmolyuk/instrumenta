import type { Database } from 'bun:sqlite'
import { hasBlockingPrForBranch, type BitbucketConfig } from '../bitbucket/closed-prs.mts'
import { giveUpAttemptCount, hasNoChangeAttempt } from '../db/queries.mts'
import type { BacklogItem, TaskProvider } from '../task-provider/types.mts'

/**
 * Given up the moment Foreman's own recorded attempts reach this (ADR-001,
 * lowered from 3 to 1 by ADR-015).
 *
 * Must stay equal to MAX_ATTEMPTS in minion/constants.mts; a test asserts it.
 */
export const GIVE_UP_THRESHOLD = 1

/**
 * ADR-016: Foreman's own SQLite is the only give-up source. A declined PR used
 * to count too (ADR-001's third source, at ADR-015's threshold of 1), which
 * retired the ticket for good on a single human decline — with 245 tickets in
 * the live backlog and a declined PR on every one of the 50 Pick can see, that
 * left the loop polling an empty-looking queue forever. A decline is a verdict
 * on one attempt's diff, not on the ticket.
 */
export function isGivenUp(db: Database, jiraKey: string): boolean {
  return giveUpAttemptCount(db, jiraKey) >= GIVE_UP_THRESHOLD
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
  if (isGivenUp(db, jiraKey)) return false
  // ADR-014: a `no_change` conclusion is terminal after one attempt, and is not
  // part of the give-up count — without this the ticket stays in the backlog
  // with no PR and Pick selects it again on the next iteration, indefinitely.
  if (hasNoChangeAttempt(db, jiraKey)) return false
  if (await hasBlockingPrForBranch(bitbucket, jiraKey, fetchImpl)) return false
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
  // Deliberately not the give-up check: naming a ticket by hand *is* the
  // override, for a ticket whose recorded attempt already failed once
  // (ADR-015 put the threshold at 1). deleteAttempts is the other way back,
  // and since ADR-016 it clears the whole of give-up rather than half of it.
  //
  // The open-or-merged guard stays. It isn't a judgement about the work's
  // quality: an open PR is unreviewed commits on the branch that a redispatch
  // would push over, and a merged one is work already delivered.
  if (await hasBlockingPrForBranch(bitbucket, item.jira_key, fetchImpl)) return null
  return item
}
