import { describe, expect, it } from 'vitest'
import { ProcessMinionRunner } from '../src/minion/process-runner.mts'

const INPUT = { task_id: 't1', jira_key: 'KAZ-1', description: 'do the thing', attempt_number: 1 }

describe('ProcessMinionRunner', () => {
  it('parses the JSON result the process prints on stdout', async () => {
    const runner = new ProcessMinionRunner([
      'bun',
      '-e',
      "const input = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ status: 'success', pr_url: `https://example.com/pr/${input.attempt_number}` }))",
    ])
    const result = await runner.run(INPUT, 5000)
    expect(result).toEqual({ status: 'success', pr_url: 'https://example.com/pr/1' })
  })

  it('passes input to the process over stdin as JSON', async () => {
    const runner = new ProcessMinionRunner([
      'bun',
      '-e',
      "const input = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ status: input.jira_key === 'KAZ-1' ? 'success' : 'crashed', pr_url: null }))",
    ])
    const result = await runner.run(INPUT, 5000)
    expect(result.status).toBe('success')
  })

  it('reports crashed when stdout has no valid result', async () => {
    const runner = new ProcessMinionRunner(['bun', '-e', "console.log('not json')"])
    const result = await runner.run(INPUT, 5000)
    expect(result).toEqual({ status: 'crashed', pr_url: null })
  })

  it('reports crashed on empty stdout', async () => {
    const runner = new ProcessMinionRunner(['bun', '-e', 'await Bun.stdin.text()'])
    const result = await runner.run(INPUT, 5000)
    expect(result).toEqual({ status: 'crashed', pr_url: null })
  })

  it('reports timeout and kills a process that outlives its budget', async () => {
    const runner = new ProcessMinionRunner(['bun', '-e', 'await Bun.sleep(5000)'])
    const start = Date.now()
    const result = await runner.run(INPUT, 100)
    expect(result).toEqual({ status: 'timeout', pr_url: null })
    expect(Date.now() - start).toBeLessThan(4000)
  })
})
