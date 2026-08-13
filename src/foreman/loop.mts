import type { Database } from 'bun:sqlite'
import type { TaskRow } from '../db/index.mts'
import { getBudget, getStartTicket, isStopped, recordAttempt, setBudget, setStartTicket, setStopped } from '../db/queries.mts'
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
  onIterationError?: (err: unknown) => void
}

/**
 * Foreman's loop (architecture.md, ADR-003): pick -> (sleep if empty) ->
 * dispatch -> record -> mirror, until the `stopped` flag in `foreman_state` is
 * set. `budget` and `start_ticket` live in the same table (ADR-003's control
 * surface, exposed over the API — see api.mts) rather than being fixed
 * arguments here, since a human can change either while this is already
 * running. `budget` is read once per call (a "max-tasks-*this run*" counter,
 * per ADR-003's own wording) and persisted back on each decrement so the API
 * can show live remaining budget; hitting zero sets `stopped` — "the same way
 * the stopped flag does" (ADR-003) — rather than exiting the process, since
 * Foreman's API/UI needs to keep running regardless. `start_ticket` is
 * re-read and consumed every iteration, not just the first, so a human can
 * queue one at any point during a long-running loop.
 *
 * Every iteration is wrapped in try/catch: a transient failure anywhere in
 * pick/dispatch (Jira, GitHub, or Minion itself being unreachable) backs off
 * like an empty queue instead of throwing out of the loop entirely. Found by
 * actually running Foreman's container against an unreachable Jira URL — an
 * uncaught fetch error there crashed the whole process, taking the control
 * API down with it, which defeats the point of it staying reachable through
 * a stop.
 */
export async function runLoop(deps: LoopDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  const onIterationError = deps.onIterationError ?? ((err) => console.error('runLoop iteration failed:', err))
  let remainingBudget = getBudget(deps.db)

  while (!isStopped(deps.db)) {
    try {
      let task = null
      const startTicket = getStartTicket(deps.db)
      if (startTicket) {
        setStartTicket(deps.db, null)
        task = await pickSpecific(deps.db, deps.taskProvider, deps.github, startTicket, deps.fetchImpl)
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

      if (remainingBudget !== null) {
        remainingBudget -= 1
        setBudget(deps.db, remainingBudget)
        if (remainingBudget <= 0) {
          setStopped(deps.db, true)
          break
        }
      }
    } catch (err) {
      onIterationError(err)
      await sleep(deps.pollIntervalMs)
    }
  }
}
