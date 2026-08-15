import { openDb } from '../db/index.mts'
import { isStopped, setBudget, setBudgetTotal, setQueueTicket, setStopped } from '../db/queries.mts'
import { ProcessMinionRunner } from '../minion/process-runner.mts'
import { JiraTaskProvider } from '../task-provider/jira.mts'
import { startApiServer } from './api.mts'
import { parseConfig } from './config.mts'
import { JiraStatusMirror } from './jira-status-mirror.mts'
import { type LoopDeps, runLoop } from './loop.mts'

/**
 * Foreman's composition root — wires the pieces built so far into a
 * long-running process. `budget`/`queueTicket` from the environment only
 * seed the DB-backed control state on first boot; once running, the API
 * (started alongside the loop, below) is what changes them.
 *
 * runLoop() returns once `stopped` is set (directly, or via budget reaching
 * zero) — but architecture.md's Foreman is "the only component that runs
 * continuously," and its API has to stay reachable through a stop, not just
 * up to it. So main() supervises: run the loop while not stopped, idle and
 * recheck while stopped, forever. A human clearing `stopped` via the API
 * (`/api/start`) is what makes this loop call runLoop() again.
 *
 * Every boot forces `stopped = true` before anything else runs, regardless
 * of whatever the (currently ephemeral, per-container) DB already had —
 * dispatching against the real Jira/Bitbucket backlog the moment the
 * container comes up, with no chance to look at the queue first, is exactly
 * the failure mode hit testing this locally. A human has to hit `/api/start`
 * (or the UI's Start button) to actually start it.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseConfig(env)
  const db = openDb(config.dbPath)
  setStopped(db, true)
  if (config.budget !== undefined) {
    setBudget(db, config.budget)
    setBudgetTotal(db, config.budget)
  }
  if (config.queueTicket !== undefined) setQueueTicket(db, config.queueTicket)

  const taskProvider = new JiraTaskProvider(config.jira)
  const deps: LoopDeps = {
    db,
    taskProvider,
    bitbucket: config.bitbucket,
    runner: new ProcessMinionRunner(config.minionCommand),
    statusMirror: new JiraStatusMirror(config.jiraAuth),
    timeoutMs: config.timeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  }

  startApiServer({ db, taskProvider, bitbucket: config.bitbucket }, config.apiPort)

  while (true) {
    if (isStopped(db)) {
      await Bun.sleep(config.pollIntervalMs)
    } else {
      await runLoop(deps)
    }
  }
}

if (import.meta.main) {
  await main()
}
