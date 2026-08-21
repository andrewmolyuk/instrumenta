import type { Database } from 'bun:sqlite'
import type { TaskRow } from '../db/index.mts'
import {
  appendCurrentProgress,
  getBudget,
  getQueueTicket,
  isStopped,
  recordAttempt,
  setBudget,
  setCurrentTask,
  setQueueTicket,
  setStopped,
} from '../db/queries.mts'
import type { BitbucketConfig } from '../bitbucket/closed-prs.mts'
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
  bitbucket: BitbucketConfig
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
 * set. `budget` and `queue_ticket` live in the same table (ADR-003's control
 * surface, exposed over the API — see api.mts) rather than being fixed
 * arguments here, since a human can change either while this is already
 * running. `budget` (a "max-tasks-*this run*" counter, per ADR-003's own
 * wording) is therefore re-read from the database every iteration, not cached
 * across the call, and persisted back on each decrement so the API can show
 * live remaining budget; hitting zero sets `stopped` — "the same way the
 * stopped flag does" (ADR-003) — rather than exiting the process, since
 * Foreman's API/UI needs to keep running regardless.
 *
 * Re-reading is the whole point rather than an implementation detail. Reported
 * live as "unlimited budget stopped execution": the budget used to be read once
 * on entry, so a human lifting it — to unlimited, or just to a bigger number —
 * while a dispatch was in flight changed nothing. The loop counted its stale
 * copy down to zero and stopped, and its own decrement wrote that finite number
 * back over the null the human had set, so even the UI disagreed with them. An
 * attempt runs for tens of minutes, which makes "while this is already running"
 * the normal case for a budget change, not an edge one. `queue_ticket` (ADR-005,
 * amending ADR-003's start[ticket]) is re-read and consumed every iteration,
 * not just the first, so a human can queue one at any point during a
 * long-running loop.
 *
 * Every iteration is wrapped in try/catch: a transient failure anywhere in
 * pick/dispatch (Jira, Bitbucket, or Minion itself being unreachable) backs off
 * like an empty queue instead of throwing out of the loop entirely. Found by
 * actually running Foreman's container against an unreachable Jira URL — an
 * uncaught fetch error there crashed the whole process, taking the control
 * API down with it, which defeats the point of it staying reachable through
 * a stop.
 */
export async function runLoop(deps: LoopDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  const onIterationError = deps.onIterationError ?? ((err) => console.error('runLoop iteration failed:', err))

  while (!isStopped(deps.db)) {
    try {
      const remainingBudget = getBudget(deps.db)
      // An already-exhausted budget stops the loop *before* dispatching, not
      // after. `budget` is persisted, so a run that spent it leaves 0 behind —
      // and with the check only after a dispatch, every Start on that state
      // spent one more attempt before stopping again ("it stops after the first
      // task", found live). /api/start refills an exhausted budget from
      // `budget_total` (ADR-010), so reaching this branch means there is no
      // capacity to refill from.
      if (remainingBudget !== null && remainingBudget <= 0) {
        setStopped(deps.db, true)
        break
      }

      let task = null
      const queueTicket = getQueueTicket(deps.db)
      if (queueTicket) {
        setQueueTicket(deps.db, null)
        task = await pickSpecific(deps.db, deps.taskProvider, deps.bitbucket, queueTicket, deps.fetchImpl)
      }
      if (!task) {
        task = await pick(deps.db, deps.taskProvider, deps.bitbucket, deps.fetchImpl)
      }

      if (!task) {
        await sleep(deps.pollIntervalMs)
        continue
      }

      await deps.statusMirror.onDispatch(task.jira_key)
      setCurrentTask(deps.db, {
        jira_key: task.jira_key,
        summary: task.summary,
        dispatched_at: new Date().toISOString(),
      })
      try {
        // Minion's live progress is persisted straight through to
        // `foreman_state` as it arrives, so the API reads it from the same
        // place as everything else it reports. Display-only: nothing here
        // affects the TaskRow that dispatch resolves to.
        const row = await dispatch(deps.db, deps.runner, task, deps.timeoutMs, (progress) =>
          appendCurrentProgress(deps.db, progress),
        )
        recordAttempt(deps.db, row)
        await deps.statusMirror.onComplete(row)

        // Read again rather than decrementing the value from the top of the
        // iteration: the dispatch above just took tens of minutes, which is
        // ample time for a human to have changed the budget — including to
        // unlimited, in which case there is nothing left to count down.
        const budgetAfterDispatch = getBudget(deps.db)
        if (budgetAfterDispatch !== null) {
          const remaining = budgetAfterDispatch - 1
          setBudget(deps.db, remaining)
          if (remaining <= 0) {
            setStopped(deps.db, true)
            break
          }
        }
      } finally {
        setCurrentTask(deps.db, null)
      }
    } catch (err) {
      onIterationError(err)
      await sleep(deps.pollIntervalMs)
    }
  }
}
