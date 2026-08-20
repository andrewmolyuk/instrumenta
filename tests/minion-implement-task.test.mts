import { afterEach, describe, expect, it } from 'vitest'
import type { MinionInput } from '../src/minion/types.mts'
import { defaultImplementCommand, implementTask } from '../minion/implement-task.mts'

const INPUT: MinionInput = { task_id: 't1', jira_key: 'KAZ-1', description: 'Fix the thing', attempt_number: 1 }

/** The prompt is the argument after `-p`, wherever the flags around it end up. */
function promptOf(command: string[]): string {
  return command[command.indexOf('-p') + 1] as string
}

function flagValue(command: string[], flag: string): string | undefined {
  const index = command.indexOf(flag)
  return index === -1 ? undefined : command[index + 1]
}

describe('implementTask', () => {
  it('runs the given command and returns empty output when it prints nothing', async () => {
    await expect(implementTask('/tmp', INPUT, ['true'])).resolves.toEqual({ output: '', costUsd: null })
  })

  it('does not throw when the command does not exist, and says so in its output', async () => {
    const result = await implementTask('/tmp', INPUT, ['this-binary-does-not-exist-anywhere'])
    expect(result.output).toContain('claude command failed to start')
    expect(result.costUsd).toBeNull()
  })

  it('captures combined stdout and stderr when stdout is not Claude Code JSON', async () => {
    const result = await implementTask('/tmp', INPUT, [
      'bun',
      '-e',
      "console.log('did some work'); console.error('a warning')",
    ])
    expect(result.output).toContain('did some work')
    expect(result.output).toContain('a warning')
    expect(result.costUsd).toBeNull()
  })

  it('parses Claude Code\'s --output-format json result for the output text and cost', async () => {
    const result = await implementTask('/tmp', INPUT, [
      'bun',
      '-e',
      "console.log(JSON.stringify({ result: 'did the thing', total_cost_usd: 0.1234 }))",
    ])
    expect(result.output).toBe('did the thing')
    expect(result.costUsd).toBe(0.1234)
  })

  it('falls back to raw output when stdout is JSON but not the Claude Code result shape', async () => {
    const result = await implementTask('/tmp', INPUT, ['bun', '-e', "console.log(JSON.stringify({ foo: 'bar' }))"])
    expect(result.output).toContain('"foo"')
    expect(result.costUsd).toBeNull()
  })
})

describe('defaultImplementCommand', () => {
  afterEach(() => {
    delete process.env.MINION_CLAUDE_MODEL
    delete process.env.MINION_CLAUDE_EFFORT
  })

  it('runs claude in unattended print mode with the jira_key and description in the prompt', () => {
    const command = defaultImplementCommand(INPUT)
    expect(command[0]).toBe('claude')
    expect(command).toContain('--dangerously-skip-permissions')
    expect(command).toContain('-p')
    expect(promptOf(command)).toContain('KAZ-1: Fix the thing')
  })

  it('pins the model to the 1M-context Opus 5 and the effort level, by default', () => {
    const command = defaultImplementCommand(INPUT)
    expect(flagValue(command, '--model')).toBe('claude-opus-5[1m]')
    expect(flagValue(command, '--effort')).toBe('high')
  })

  it('lets a deployment override the model and effort by environment', () => {
    process.env.MINION_CLAUDE_MODEL = 'claude-sonnet-5'
    process.env.MINION_CLAUDE_EFFORT = 'max'

    const command = defaultImplementCommand(INPUT)
    expect(flagValue(command, '--model')).toBe('claude-sonnet-5')
    expect(flagValue(command, '--effort')).toBe('max')
  })

  it('tells Claude Code to implement directly rather than propose and wait for confirmation', () => {
    const prompt = promptOf(defaultImplementCommand(INPUT))
    expect(prompt).toMatch(/implement the fix/i)
    expect(prompt).toMatch(/unattended/i)
    expect(prompt).toMatch(/do not stop to describe or propose/i)
  })

  it('tells Claude Code to run the project\'s own checks and fix what they report', () => {
    const prompt = promptOf(defaultImplementCommand(INPUT))
    expect(prompt).toMatch(/pre-commit hook/i)
    expect(prompt).toMatch(/fix everything they report/i)
    expect(prompt).toMatch(/run again before your work is committed/i)
  })

  it('tells Claude Code to leave the changes uncommitted', () => {
    const prompt = promptOf(defaultImplementCommand(INPUT))
    expect(prompt).toMatch(/do not run `git commit`/i)
  })
})
