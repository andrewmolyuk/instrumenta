import type { Database } from 'bun:sqlite'
import type { TaskRow } from '../db/index.mts'
import { isStopped, recordAttempt } from '../db/queries.mts'
import type { GitHubConfig } from '../github/closed-prs.mts'
import type { MinionRunner } from '../minion/types.mts'
import type { TaskProvider } from '../task-provider/types.mts'
import { dispatch } from './dispatch.mts'
import { pick, pickSpecific } from './pick.mts'

export interface StatusMirror {
  mirror(row: TaskRow): Promise<void>
}

/**
 * Ships with the loop so its shape is complete and testable now. ADR-001 only
 * names two concrete cases ("In Progress" on dispatch, "Done" on success) —
 * a real Jira-writing mirror, and what the other four statuses map to, is
 * separate, later work rather than something to guess here.
 */
export const noopStatusMirror: StatusMirror = {
  async mirror() {},
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

    const row = await dispatch(deps.db, deps.runner, task, deps.timeoutMs)
    recordAttempt(deps.db, row)
    await deps.statusMirror.mirror(row)

    if (remainingBudget !== undefined) {
      remainingBudget -= 1
      if (remainingBudget <= 0) break
    }
  }
}
