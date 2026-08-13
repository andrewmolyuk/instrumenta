import type { Database } from 'bun:sqlite'
import type { TaskRow } from '../db/index.mts'
import { newTaskId, nextAttemptNumber } from '../db/queries.mts'
import type { MinionRunner } from '../minion/types.mts'
import type { BacklogItem } from '../task-provider/types.mts'

/**
 * Foreman's `dispatch` loop step (architecture.md): runs Minion on `task` and
 * waits synchronously for its one result. Returns a row ready for
 * `recordAttempt` — writing it is a separate step, same as the loop pseudocode
 * (`result = dispatch(task); record(result)`).
 */
export async function dispatch(
  db: Database,
  runner: MinionRunner,
  task: BacklogItem,
  timeoutMs: number,
): Promise<TaskRow> {
  const task_id = newTaskId()
  const attempt_number = nextAttemptNumber(db, task.jira_key)
  const dispatched_at = new Date().toISOString()

  const result = await runner.run(
    { task_id, jira_key: task.jira_key, description: task.description, attempt_number },
    timeoutMs,
  )

  return {
    task_id,
    jira_key: task.jira_key,
    attempt_number,
    status: result.status,
    pr_url: result.pr_url,
    dispatched_at,
    finished_at: new Date().toISOString(),
  }
}
