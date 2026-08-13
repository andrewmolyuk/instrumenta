import { describe, expect, it } from 'vitest'
import type { MinionInput } from '../src/minion/types.mts'
import { implementTask } from '../minion/implement-task.mts'

const INPUT: MinionInput = { task_id: 't1', jira_key: 'KAZ-1', description: 'Fix the thing', attempt_number: 1 }

describe('implementTask', () => {
  it('runs the given command and resolves', async () => {
    await expect(implementTask('/tmp', INPUT, ['true'])).resolves.toBeUndefined()
  })

  it('does not throw when the command does not exist', async () => {
    await expect(implementTask('/tmp', INPUT, ['this-binary-does-not-exist-anywhere'])).resolves.toBeUndefined()
  })
})
