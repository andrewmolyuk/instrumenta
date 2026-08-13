import { openDb } from '../db/index.mts'
import { setBudget, setStartTicket } from '../db/queries.mts'
import { ProcessMinionRunner } from '../minion/process-runner.mts'
import { JiraTaskProvider } from '../task-provider/jira.mts'
import { parseConfig } from './config.mts'
import { JiraStatusMirror } from './jira-status-mirror.mts'
import { runLoop } from './loop.mts'

/**
 * Foreman's composition root — wires the pieces built so far into the actual
 * loop. `budget`/`startTicket` from the environment only seed the DB-backed
 * control state on first boot (schema default is NULL/unlimited); once
 * running, the API (not yet built) is what changes them.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseConfig(env)
  const db = openDb(config.dbPath)
  if (config.budget !== undefined) setBudget(db, config.budget)
  if (config.startTicket !== undefined) setStartTicket(db, config.startTicket)

  await runLoop({
    db,
    taskProvider: new JiraTaskProvider(config.jira),
    github: config.github,
    runner: new ProcessMinionRunner(config.minionCommand),
    statusMirror: new JiraStatusMirror(config.jiraAuth),
    timeoutMs: config.timeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  })
}

if (import.meta.main) {
  await main()
}
