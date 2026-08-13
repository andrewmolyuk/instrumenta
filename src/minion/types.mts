import type { TaskStatus } from '../db/index.mts'

/** Everything Minion needs at launch (architecture.md's Minion section). */
export interface MinionInput {
  task_id: string
  jira_key: string
  description: string
  attempt_number: number
}

/** The one structured result Minion reports at exit — status + PR url, if any. */
export interface MinionResult {
  status: TaskStatus
  pr_url: string | null
}

export interface MinionRunner {
  run(input: MinionInput, timeoutMs: number): Promise<MinionResult>
}
