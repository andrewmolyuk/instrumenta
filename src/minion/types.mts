import type { TaskStatus } from '../db/index.mts'

/** Everything Minion needs at launch (architecture.md's Minion section). */
export interface MinionInput {
  task_id: string
  jira_key: string
  description: string
  attempt_number: number
}

/**
 * The one structured result Minion reports at exit — status + PR url, if any.
 * `output` is captured diagnostic text: the verify gate's stdout+stderr on a failed
 * run (and the given_up that follows it) when Minion reports it itself, or Minion's
 * own process stdout+stderr when ProcessMinionRunner has to synthesize a `crashed` or
 * `timeout` result because Minion never reported one (or was killed before it could) —
 * null for every other status, including a passing verify.
 */
export interface MinionResult {
  status: TaskStatus
  pr_url: string | null
  output: string | null
}

export interface MinionRunner {
  run(input: MinionInput, timeoutMs: number): Promise<MinionResult>
}
