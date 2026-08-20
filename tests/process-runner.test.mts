import { describe, expect, it } from 'vitest'
import { ProcessMinionRunner } from '../src/minion/process-runner.mts'
import { encodeProgress, type MinionProgress } from '../src/minion/progress.mts'

const INPUT = { task_id: 't1', jira_key: 'KAZ-1', description: 'do the thing', attempt_number: 1 }

describe('ProcessMinionRunner', () => {
  it('parses the JSON result the process prints on stdout', async () => {
    const runner = new ProcessMinionRunner([
      'bun',
      '-e',
      "const input = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ status: 'success', pr_url: `https://example.com/pr/${input.attempt_number}` }))",
    ])
    const result = await runner.run(INPUT, 5000)
    expect(result).toEqual({ status: 'success', pr_url: 'https://example.com/pr/1', output: null, cost_usd: null })
  })

  it('parses cost_usd through when the process reports one', async () => {
    const runner = new ProcessMinionRunner([
      'bun',
      '-e',
      "console.log(JSON.stringify({ status: 'success', pr_url: null, cost_usd: 0.42 }))",
    ])
    const result = await runner.run(INPUT, 5000)
    expect(result.cost_usd).toBe(0.42)
  })

  it('parses the output field through when the process reports one', async () => {
    const runner = new ProcessMinionRunner([
      'bun',
      '-e',
      "console.log(JSON.stringify({ status: 'failed_verify', pr_url: null, output: 'test 1 failed' }))",
    ])
    const result = await runner.run(INPUT, 5000)
    expect(result).toEqual({ status: 'failed_verify', pr_url: null, output: 'test 1 failed', cost_usd: null })
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
    expect(result).toEqual({ status: 'crashed', pr_url: null, output: 'not json', cost_usd: null })
  })

  it('reports crashed with null output on empty stdout and stderr', async () => {
    const runner = new ProcessMinionRunner(['bun', '-e', 'await Bun.stdin.text()'])
    const result = await runner.run(INPUT, 5000)
    expect(result).toEqual({ status: 'crashed', pr_url: null, output: null, cost_usd: null })
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
    expect(result).toEqual({ status: 'timeout', pr_url: null, output: null, cost_usd: null })
    expect(Date.now() - start).toBeLessThan(4000)
  })

  it('reports the result Minion already printed, not timeout, when the kill lands after it finished', async () => {
    // KAZ-8390: a 30-minute budget, a `crashed` result reported at the wire, and
    // the whole thing recorded as `timeout` with the cost and the reason discarded.
    const runner = new ProcessMinionRunner([
      'bun',
      '-e',
      "console.log(JSON.stringify({ status: 'crashed', pr_url: null, output: 'pre-commit hook failed', cost_usd: 9.72 })); await Bun.sleep(10000)",
    ])
    const result = await runner.run(INPUT, 500)

    expect(result).toEqual({
      status: 'crashed',
      pr_url: null,
      output: 'pre-commit hook failed',
      cost_usd: 9.72,
    })
  })

  it('still reports timeout when the killed process never printed a result', async () => {
    const runner = new ProcessMinionRunner(['bun', '-e', "console.log('cloned repo'); await Bun.sleep(10000)"])
    const result = await runner.run(INPUT, 500)

    expect(result.status).toBe('timeout')
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

describe('ProcessMinionRunner live progress', () => {
  /** A Minion that prints `lines` to stderr, then its structured result to stdout. */
  function runnerPrinting(lines: string[]): ProcessMinionRunner {
    const script = lines.map((l) => `console.error(${JSON.stringify(l)})`).join('; ')
    return new ProcessMinionRunner([
      'bun',
      '-e',
      `${script}; console.log(JSON.stringify({ status: 'success', pr_url: null }))`,
    ])
  }

  it('reports each progress line Minion writes to stderr', async () => {
    const seen: MinionProgress[] = []
    const runner = runnerPrinting([
      encodeProgress({ line: 'Read src/foo.ts', cost_usd: 0.5 }),
      encodeProgress({ line: 'Bash: npm run lint', cost_usd: 1.25 }),
    ])

    await runner.run(INPUT, 5000, (p) => seen.push(p))

    expect(seen).toEqual([
      { line: 'Read src/foo.ts', cost_usd: 0.5 },
      { line: 'Bash: npm run lint', cost_usd: 1.25 },
    ])
  })

  it('keeps progress lines out of the output captured for a crash', async () => {
    // The whole point of the captured output is the stack trace that explains
    // the crash — hundreds of progress lines around it would bury it.
    const runner = new ProcessMinionRunner([
      'bun',
      '-e',
      `console.error(${JSON.stringify(encodeProgress({ line: 'Read src/foo.ts' }))}); console.error('TypeError: boom'); process.exit(1)`,
    ])

    const result = await runner.run(INPUT, 5000, () => {})

    expect(result.status).toBe('crashed')
    expect(result.output).toContain('TypeError: boom')
    expect(result.output).not.toContain('Read src/foo.ts')
  })

  it('runs without an onProgress callback at all', async () => {
    const runner = runnerPrinting([encodeProgress({ line: 'Read src/foo.ts' })])
    await expect(runner.run(INPUT, 5000)).resolves.toMatchObject({ status: 'success' })
  })

  it('reports progress while the process is still running, not only at exit', async () => {
    // Buffering these until exit would make them useless: an attempt runs for
    // tens of minutes, and the card is meant to show what it is doing *now*.
    const runner = new ProcessMinionRunner([
      'bun',
      '-e',
      `console.error(${JSON.stringify(encodeProgress({ line: 'early' }))}); await Bun.sleep(400); console.log(JSON.stringify({ status: 'success', pr_url: null }))`,
    ])

    let sawEarlyLineAt = 0
    const started = Date.now()
    await runner.run(INPUT, 5000, () => {
      sawEarlyLineAt ||= Date.now() - started
    })

    expect(sawEarlyLineAt).toBeLessThan(300)
  })
})
