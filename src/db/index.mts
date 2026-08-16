import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql')

/** Matches CONTEXT.md's Status glossary entry and the schema's CHECK constraint. */
export type TaskStatus =
  | 'success'
  | 'failed_verify'
  | 'blocked_no_verify'
  | 'crashed'
  | 'timeout'
  | 'given_up'

export interface TaskRow {
  task_id: string
  jira_key: string
  attempt_number: number
  status: TaskStatus
  pr_url: string | null
  output: string | null
  cost_usd: number | null
  dispatched_at: string
  finished_at: string | null
}

/** Opens (creating if needed) the SQLite file at `path` and applies the schema. */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.run(readFileSync(SCHEMA_PATH, 'utf-8'))
  return db
}
