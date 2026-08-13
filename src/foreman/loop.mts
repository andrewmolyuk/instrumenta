import type { Database } from 'bun:sqlite'
import type { TaskRow } from '../db/index.mts'
import { isStopped, recordAttempt } from '../db/queries.mts'
import type { GitHubConfig } from '../github/closed-prs.mts'
import type { MinionRunner } from '../minion/types.mts'
import type { TaskProvider } from '../task-provider/types.mts'
import { dispatch } from './dispatch.mts'
import { pick, pickSpecific } from './pick.mts'

/**
 * ADR-001 names two mirrored events, at two different points in the loop:
 * "In Progress" the moment a task is dispatched, "Done" once it succeeds.
 * The other four attempt statuses aren't given a Jira mapping by the ADR, so
 * onComplete is free to no-op for them rather than guess one.
 */
export interface StatusMirror {
  onDispatch(jiraKey: string): Promise<void>
  onComplete(row: TaskRow): Promise<void>
}

export const noopStatusMirror: StatusMirror = {
  async onDispatch() {},
  async onComplete() {},
}

export interface LoopDeps {
  db: Database
  taskProvider: TaskProvider
  github: GitHubConfig
  runner: MinionRunner
  statusMirror: StatusMirror
  timeoutMs: number
  pollIntervalMs: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

/**
 * Foreman's loop (architecture.md, ADR-003):
 *   while not stopped: pick -> (sleep if empty) -> dispatch -> record -> mirror
 * `budget`, if set, decrements per completed dispatch and stops the loop at
 * zero, same as the `stopped` flag (ADR-003) — idle iterations don't count
 * against it. `startTicket` applies to the first eligible iteration only.
 */
export async function runLoop(deps: LoopDeps, budget?: number, startTicket?: string): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  let remainingBudget = budget
  let pendingStartTicket = startTicket

  while (!isStopped(deps.db)) {
    let task = null
    if (pendingStartTicket) {
      task = await pickSpecific(deps.db, deps.taskProvider, deps.github, pendingStartTicket, deps.fetchImpl)
      pendingStartTicket = undefined
    }
    if (!task) {
      task = await pick(deps.db, deps.taskProvider, deps.github, deps.fetchImpl)
    }

    if (!task) {
      await sleep(deps.pollIntervalMs)
      continue
    }

    await deps.statusMirror.onDispatch(task.jira_key)
    const row = await dispatch(deps.db, deps.runner, task, deps.timeoutMs)
    recordAttempt(deps.db, row)
    await deps.statusMirror.onComplete(row)

    if (remainingBudget !== undefined) {
      remainingBudget -= 1
      if (remainingBudget <= 0) break
    }
  }
}
