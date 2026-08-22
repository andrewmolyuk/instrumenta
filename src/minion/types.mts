import type { TaskStatus } from '../db/index.mts'
import type { MinionProgress } from './progress.mts'

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
  /**
   * The full record of what the agent did this attempt (minion/session.mts) —
   * its problem statement, every step it took, and its own closing summary.
   * Reported for every status, including `success`: `output` is deliberately
   * null there ("nothing to explain"), which left successful attempts with no
   * trace at all — found live on RPG-5427, where a PR existed and nothing in
   * the system could say what had produced it. Null only when Minion never got
   * far enough to run the agent.
   */
  session: string | null
}

export interface MinionRunner {
  /**
   * `onProgress` is optional on both sides: a runner is free to report nothing
   * while a run is in flight (the loop just shows no live detail), and a caller
   * that doesn't care can leave it off. It is a *side-channel* — whatever it
   * reports is for display only, and never feeds the MinionResult this
   * resolves to, which stays the single source of truth about the attempt.
   */
  run(
    input: MinionInput,
    timeoutMs: number,
    onProgress?: (progress: MinionProgress) => void,
  ): Promise<MinionResult>
}
