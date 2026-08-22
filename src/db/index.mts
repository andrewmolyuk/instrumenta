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
  /** The full agent session for this attempt (minion/session.mts) — see schema.sql. */
  session: string | null
  dispatched_at: string
  finished_at: string | null
}

/**
 * Columns added after the first release, as [table, column, type]. schema.sql alone can't introduce these: its statements
 * are all `CREATE TABLE IF NOT EXISTS`, which is a no-op against the table an
 * existing database already has — and Foreman's database is deliberately on a
 * persistent volume, so "existing" is the normal case, not the exception.
 * Additive and nullable only: a database predating any of these simply reports
 * it as null.
 */
const ADDED_COLUMNS: Array<[table: string, column: string, type: string]> = [
  ['foreman_state', 'current_summary', 'TEXT'],
  ['foreman_state', 'current_output', 'TEXT'],
  ['foreman_state', 'current_cost_usd', 'REAL'],
  ['tasks', 'session', 'TEXT'],
]

/** Opens (creating if needed) the SQLite file at `path` and applies the schema. */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.run(readFileSync(SCHEMA_PATH, 'utf-8'))

  // SQLite has no `ADD COLUMN IF NOT EXISTS`, so the existing columns are read
  // back and the missing ones added — rather than adding blind and swallowing
  // the error, which would also swallow a genuinely broken schema.
  const columnsOf = (table: string): Set<string> =>
    new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name))
  const existing = new Map([...new Set(ADDED_COLUMNS.map(([t]) => t))].map((t) => [t, columnsOf(t)]))
  for (const [table, column, type] of ADDED_COLUMNS) {
    if (!existing.get(table)?.has(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }

  return db
}
