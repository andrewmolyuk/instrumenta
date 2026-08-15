import { describe, expect, it } from 'vitest'
import type { MinionInput } from '../src/minion/types.mts'
import { defaultImplementCommand, implementTask } from '../minion/implement-task.mts'

const INPUT: MinionInput = { task_id: 't1', jira_key: 'KAZ-1', description: 'Fix the thing', attempt_number: 1 }

describe('implementTask', () => {
  it('runs the given command and returns empty output when it prints nothing', async () => {
    await expect(implementTask('/tmp', INPUT, ['true'])).resolves.toBe('')
  })

  it('does not throw when the command does not exist, and says so in its output', async () => {
    const output = await implementTask('/tmp', INPUT, ['this-binary-does-not-exist-anywhere'])
    expect(output).toContain('claude command failed to start')
  })

  it('captures combined stdout and stderr', async () => {
    const output = await implementTask('/tmp', INPUT, [
      'bun',
      '-e',
      "console.log('did some work'); console.error('a warning')",
    ])
    expect(output).toContain('did some work')
    expect(output).toContain('a warning')
  })
})

describe('defaultImplementCommand', () => {
  it('runs claude in unattended print mode with the jira_key and description in the prompt', () => {
    const [bin, flag, printFlag, prompt] = defaultImplementCommand(INPUT)
    expect(bin).toBe('claude')
    expect(flag).toBe('--dangerously-skip-permissions')
    expect(printFlag).toBe('-p')
    expect(prompt).toContain('KAZ-1: Fix the thing')
  })

  it('tells Claude Code to implement directly rather than propose and wait for confirmation', () => {
    const [, , , prompt] = defaultImplementCommand(INPUT)
    expect(prompt).toMatch(/implement the fix/i)
    expect(prompt).toMatch(/unattended/i)
    expect(prompt).toMatch(/do not stop to describe or propose/i)
  })
})
