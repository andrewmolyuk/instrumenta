import type { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.mts'
import { getCurrentTask, isStopped, setCurrentTask, setStopped } from '../src/db/queries.mts'
import { resetTransientState } from '../src/foreman/main.mts'

let db: Database

beforeEach(() => {
  db = openDb(':memory:')
})

describe('resetTransientState', () => {
  it('clears an in-flight task left behind by a killed process', () => {
    // The loop clears the current task in a `finally`, which never runs when
    // the container is stopped mid-dispatch — and the database outlives it.
    // Found live: after a restart the Cockpit showed a Minion still working on
    // RPG-4972, duration ticking, half an hour after its container was gone.
    setCurrentTask(db, {
      jira_key: 'RPG-4972',
      summary: 'SIP correlation statistics WebUI support',
      dispatched_at: '2026-08-22T17:16:03.557Z',
    })

    resetTransientState(db)

    expect(getCurrentTask(db)).toBeNull()
  })

  it('forces stopped, whatever the database was left in', () => {
    setStopped(db, false)
    resetTransientState(db)
    expect(isStopped(db)).toBe(true)
  })

  it('is safe on a database with nothing in flight', () => {
    expect(() => resetTransientState(db)).not.toThrow()
    expect(getCurrentTask(db)).toBeNull()
  })
})
