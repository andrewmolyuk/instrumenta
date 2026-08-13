import { openDb } from '../db/index.mts'
import { ProcessMinionRunner } from '../minion/process-runner.mts'
import { JiraTaskProvider } from '../task-provider/jira.mts'
import { parseConfig } from './config.mts'
import { JiraStatusMirror } from './jira-status-mirror.mts'
import { runLoop } from './loop.mts'

/** Foreman's composition root — wires the pieces built so far into the actual loop. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseConfig(env)
  const db = openDb(config.dbPath)

  await runLoop(
    {
      db,
      taskProvider: new JiraTaskProvider(config.jira),
      github: config.github,
      runner: new ProcessMinionRunner(config.minionCommand),
      statusMirror: new JiraStatusMirror(config.jiraAuth),
      timeoutMs: config.timeoutMs,
      pollIntervalMs: config.pollIntervalMs,
    },
    config.budget,
    config.startTicket,
  )
}

if (import.meta.main) {
  await main()
}
