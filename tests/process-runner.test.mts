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
    expect(result).toEqual({ status: 'success', pr_url: 'https://example.com/pr/1', output: null })
  })

  it('parses the output field through when the process reports one', async () => {
    const runner = new ProcessMinionRunner([
      'bun',
      '-e',
      "console.log(JSON.stringify({ status: 'failed_verify', pr_url: null, output: 'test 1 failed' }))",
    ])
    const result = await runner.run(INPUT, 5000)
    expect(result).toEqual({ status: 'failed_verify', pr_url: null, output: 'test 1 failed' })
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

  it('reports crashed with the raw stdout as output when it is not a valid result', async () => {
    const runner = new ProcessMinionRunner(['bun', '-e', "console.log('not json')"])
    const result = await runner.run(INPUT, 5000)
    expect(result).toEqual({ status: 'crashed', pr_url: null, output: 'not json' })
  })

  it('reports crashed with null output on empty stdout and stderr', async () => {
    const runner = new ProcessMinionRunner(['bun', '-e', 'await Bun.stdin.text()'])
    const result = await runner.run(INPUT, 5000)
    expect(result).toEqual({ status: 'crashed', pr_url: null, output: null })
  })

  it('captures stderr (e.g. an uncaught exception) as crash output', async () => {
    const runner = new ProcessMinionRunner(['bun', '-e', "throw new Error('boom')"])
    const result = await runner.run(INPUT, 5000)
    expect(result.status).toBe('crashed')
    expect(result.output).toContain('boom')
  })

  it('reports timeout and kills a process that outlives its budget', async () => {
    const runner = new ProcessMinionRunner(['bun', '-e', 'await Bun.sleep(5000)'])
    const start = Date.now()
    const result = await runner.run(INPUT, 100)
    expect(result).toEqual({ status: 'timeout', pr_url: null, output: null })
    expect(Date.now() - start).toBeLessThan(4000)
  })

  it('captures whatever was printed before a timeout kills the process', async () => {
    const runner = new ProcessMinionRunner([
      'bun',
      '-e',
      "console.log('cloned repo'); console.error('still implementing...'); await Bun.sleep(10000)",
    ])
    // A longer budget than the other timeout test — this one needs the child
    // process to actually boot and print before it's killed, which a very
    // tight budget can miss under load (flaky, not wrong).
    const result = await runner.run(INPUT, 500)
    expect(result.status).toBe('timeout')
    expect(result.output).toContain('cloned repo')
    expect(result.output).toContain('still implementing...')
  })
})
