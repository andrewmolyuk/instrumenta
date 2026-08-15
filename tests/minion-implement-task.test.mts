import { describe, expect, it } from 'vitest'
import type { MinionInput } from '../src/minion/types.mts'
import { defaultImplementCommand, implementTask } from '../minion/implement-task.mts'

const INPUT: MinionInput = { task_id: 't1', jira_key: 'KAZ-1', description: 'Fix the thing', attempt_number: 1 }

describe('implementTask', () => {
  it('runs the given command and resolves', async () => {
    await expect(implementTask('/tmp', INPUT, ['true'])).resolves.toBeUndefined()
  })

  it('does not throw when the command does not exist', async () => {
    await expect(implementTask('/tmp', INPUT, ['this-binary-does-not-exist-anywhere'])).resolves.toBeUndefined()
  })
})

describe('defaultImplementCommand', () => {
  it('runs claude in unattended print mode with the jira_key and description as the prompt', () => {
    expect(defaultImplementCommand(INPUT)).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '-p',
      'KAZ-1: Fix the thing',
    ])
  })
})
