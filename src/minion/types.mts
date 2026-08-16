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
 * `output` is captured diagnostic text, combined from whichever of these produced
 * something: Claude Code's own stdout+stderr from implementTask, and the verify
 * gate's stdout+stderr on a failed run (and the given_up that follows it) — present
 * when Minion reports the result itself. Or Minion's own process stdout+stderr when
 * ProcessMinionRunner has to synthesize a `crashed` or `timeout` result because
 * Minion never reported one (or was killed before it could) — implementTask's output
 * is echoed to Minion's own stderr for exactly this case, since it's otherwise lost
 * once an uncaught exception bypasses Minion's own structured return. Null on a
 * passing verify (`success`) — nothing to explain there.
 */
export interface MinionResult {
  status: TaskStatus
  pr_url: string | null
  output: string | null
  /** Claude Code's own total_cost_usd for this attempt; null when implementTask never got a parseable result (crash, timeout before Claude ran, missing binary). */
  cost_usd: number | null
}

export interface MinionRunner {
  run(input: MinionInput, timeoutMs: number): Promise<MinionResult>
}
