import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_STEP_CHARS } from '../minion/constants.mts'
import { verifyCommand } from '../minion/verify-gate.mts'
import { decodeProgress, type MinionProgress } from '../src/minion/progress.mts'
import type { MinionInput } from '../src/minion/types.mts'
import type { JiraTicket } from '../minion/jira.mts'
import { defaultImplementCommand, extractReport, implementTask, REPORT_MARKER } from '../minion/implement-task.mts'

const INPUT: MinionInput = { task_id: 't1', jira_key: 'KAZ-1', attempt_number: 1 }
const TICKET: JiraTicket = { summary: 'Fix the thing', description: 'Fix the thing', attachments: [] }

/** Strips the `[mm:ss] ` elapsed prefix every step carries. */
const unstamped = (line?: string) => (line ?? '').replace(/^\[\d+:?\d*:?\d*\]\s/, '')

/** The prompt is the argument after `-p`, wherever the flags around it end up. */
function promptOf(command: string[]): string {
  return command[command.indexOf('-p') + 1] as string
}

/**
 * The prompt with its line wrapping flattened. Phrase assertions kept breaking
 * whenever a reword moved a line break into the middle of them, which tested
 * the wrapping rather than the wording.
 */
function flowed(command: string[]): string {
  return promptOf(command).replace(/\s+/g, ' ')
}

function flagValue(command: string[], flag: string): string | undefined {
  const index = command.indexOf(flag)
  return index === -1 ? undefined : command[index + 1]
}

describe('implementTask', () => {
  it('runs the given command and returns empty output when it prints nothing', async () => {
    await expect(implementTask('/tmp', INPUT, TICKET, ['true'])).resolves.toEqual({ output: '', costUsd: null, transcript: [], usageLimited: false, apiError: false })
  })

  it('does not throw when the command does not exist, and says so in its output', async () => {
    const result = await implementTask('/tmp', INPUT, TICKET, ['this-binary-does-not-exist-anywhere'])
    expect(result.output).toContain('claude command failed to start')
    expect(result.costUsd).toBeNull()
  })

  it('captures combined stdout and stderr when stdout is not Claude Code JSON', async () => {
    const result = await implementTask('/tmp', INPUT, TICKET, [
      'bun',
      '-e',
      "console.log('did some work'); console.error('a warning')",
    ])
    expect(result.output).toContain('did some work')
    expect(result.output).toContain('a warning')
    expect(result.costUsd).toBeNull()
  })

  it('parses Claude Code\'s --output-format json result for the output text and cost', async () => {
    const result = await implementTask('/tmp', INPUT, TICKET, [
      'bun',
      '-e',
      "console.log(JSON.stringify({ result: 'did the thing', total_cost_usd: 0.1234 }))",
    ])
    expect(result.output).toBe('did the thing')
    expect(result.costUsd).toBe(0.1234)
  })

  it('falls back to raw output when stdout is JSON but not the Claude Code result shape', async () => {
    const result = await implementTask('/tmp', INPUT, TICKET, ['bun', '-e', "console.log(JSON.stringify({ foo: 'bar' }))"])
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
    const command = defaultImplementCommand(INPUT, TICKET)
    expect(command[0]).toBe('claude')
    expect(command).toContain('--dangerously-skip-permissions')
    expect(command).toContain('-p')
    expect(promptOf(command)).toContain('KAZ-1: Fix the thing')
  })

  it('pins the model to the 1M-context Opus 5 and the effort level, by default', () => {
    const command = defaultImplementCommand(INPUT, TICKET)
    expect(flagValue(command, '--model')).toBe('claude-opus-5[1m]')
    expect(flagValue(command, '--effort')).toBe('high')
  })

  it('lets a deployment override the model and effort by environment', () => {
    process.env.MINION_CLAUDE_MODEL = 'claude-sonnet-5'
    process.env.MINION_CLAUDE_EFFORT = 'max'

    const command = defaultImplementCommand(INPUT, TICKET)
    expect(flagValue(command, '--model')).toBe('claude-sonnet-5')
    expect(flagValue(command, '--effort')).toBe('max')
  })

  it('tells Claude Code to implement directly rather than propose and wait for confirmation', () => {
    const prompt = promptOf(defaultImplementCommand(INPUT, TICKET))
    expect(prompt).toMatch(/implement the fix/i)
    expect(prompt).toMatch(/unattended/i)
    expect(prompt).toMatch(/do not stop to describe or propose/i)
  })

  it('tells Claude Code to run the project\'s own checks and fix what they report', () => {
    const prompt = flowed(defaultImplementCommand(INPUT, TICKET))
    expect(prompt).toMatch(/pre-commit hook/i)
    expect(prompt).toMatch(/fix what they report/i)
    // The exact gate command, so the agent runs what the gate will run rather
    // than guessing at "the project's checks" (ADR-009's whole point).
    expect(prompt).toContain(verifyCommand())
    expect(prompt).toMatch(/no commit and no pull request/i)
    // Scoped to the gate: a repository can hold config for tools its own
    // pipeline never runs, and chasing those costs minutes and finds
    // pre-existing failures.
    expect(prompt).toMatch(/Do not go looking for other linters/i)
  })

  it("names the deployment's overridden gate command, when there is one", () => {
    process.env.MINION_VERIFY_COMMAND = 'npm run lint && npm run test'
    try {
      expect(promptOf(defaultImplementCommand(INPUT, TICKET))).toContain('npm run lint && npm run test')
    } finally {
      delete process.env.MINION_VERIFY_COMMAND
    }
  })

  it('tells Claude Code to leave the changes uncommitted', () => {
    const prompt = promptOf(defaultImplementCommand(INPUT, TICKET))
    expect(prompt).toMatch(/do not run `git commit`/i)
  })
})

/** Runs implementTask over a canned stream-json transcript, collecting what it reported. */
async function runOverEvents(events: unknown[]): Promise<{ result: Awaited<ReturnType<typeof implementTask>>; progress: MinionProgress[] }> {
  const progress: MinionProgress[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const decoded = decodeProgress(String(args[0]))
    if (decoded) progress.push(decoded)
  })
  try {
    const script = events.map((e) => `console.log(${JSON.stringify(JSON.stringify(e))})`).join('; ')
    const result = await implementTask('/tmp', INPUT, TICKET, ['bun', '-e', script])
    return { result, progress }
  } finally {
    spy.mockRestore()
  }
}

describe('implementTask stream-json progress', () => {
  const EVENTS = [
    { type: 'system', subtype: 'init', model: 'claude-opus-5[1m]' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/foo.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run lint' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'a very long file dump' }] } },
    { type: 'result', subtype: 'success', result: 'fixed the thing', total_cost_usd: 1.83 },
  ]

  it("takes the output text and cost from the stream's final result event", async () => {
    const { result } = await runOverEvents(EVENTS)
    expect(result.output).toBe('fixed the thing')
    expect(result.costUsd).toBe(1.83)
  })

  it('reports a progress line per tool call, carrying the running cost', async () => {
    const { progress } = await runOverEvents(EVENTS)
    const lines = progress.map((p) => unstamped(p.line)).filter(Boolean)
    expect(lines).toContain('Read: src/foo.ts')
    expect(lines).toContain('Bash: npm run lint')
    expect(progress.at(-1)?.cost_usd).toBe(1.83)
  })

  it('records tool results, trimmed rather than dropped', async () => {
    // Originally these were dropped entirely as too bulky. That left no trace
    // of what any command returned, so nothing in the transcript could be
    // checked. They are trimmed to both ends instead.
    const { progress } = await runOverEvents(EVENTS)
    expect(progress.map((p) => p.line).join('\n')).toContain('a very long file dump')
  })

  it('skips stream lines it cannot parse rather than failing the run', async () => {
    const { result, progress } = await runOverEvents([
      { type: 'assistant', message: { content: 'not an array' } },
      { type: 'mystery-future-event' },
      { type: 'result', result: 'done anyway', total_cost_usd: 0.1 },
    ])
    expect(result.output).toBe('done anyway')
    expect(result.costUsd).toBe(0.1)
    expect(progress.length).toBeGreaterThan(0)
  })
})

describe('the ticket in the prompt', () => {
  it('leads with the summary, so the agent knows what it is fixing', () => {
    const prompt = promptOf(defaultImplementCommand(INPUT, TICKET))
    expect(prompt.startsWith('KAZ-1: Fix the thing')).toBe(true)
  })

  it('says so plainly when a ticket has no description, instead of leaving a blank', () => {
    // RPG-5427 was dispatched as `RPG-5427: ` with nothing after it.
    const prompt = promptOf(defaultImplementCommand(INPUT, { ...TICKET, description: '' }))
    expect(prompt).toContain('KAZ-1: Fix the thing')
    expect(prompt).toContain('(this ticket has no text description)')
  })

  it('points the agent at downloaded attachments by absolute path', () => {
    const prompt = promptOf(
      defaultImplementCommand(
        INPUT,
        {
          ...TICKET,
          attachments: [{ filename: 'shot.png', mimeType: 'image/png', path: '/tmp/minion-t1-attachments/1-shot.png' }],
        },
      ),
    )

    expect(prompt).toContain('/tmp/minion-t1-attachments/1-shot.png')
    expect(prompt).toContain('shot.png')
    expect(prompt).toContain('Do not copy them into the repository')
  })

  it('says nothing about attachments when there are none', () => {
    expect(promptOf(defaultImplementCommand(INPUT, TICKET))).not.toContain('This ticket has attachments')
  })

  it('asks for the smallest change, not the thorough one', () => {
    // The counterweight to "implement it, don't just propose it": an unattended
    // agent with full tool access will otherwise return a refactor for a
    // one-line bug, and every line of it needs a human to take responsibility.
    const prompt = promptOf(defaultImplementCommand(INPUT, TICKET))

    expect(prompt).toContain('smallest change')
    expect(prompt).toContain('Do not refactor code that is not broken')
    expect(prompt).toContain('leave it alone and say so in')
  })

  it('asks for a closing report covering questions and unreviewed decisions', () => {
    const prompt = promptOf(defaultImplementCommand(INPUT, TICKET))
    expect(prompt).toContain(REPORT_MARKER)
    expect(prompt).toContain('## What changed')
    expect(prompt).toContain('## Questions for a human')
    expect(prompt).toContain('## Decisions taken without human review')
  })
})

describe('extractReport', () => {
  it('takes everything after the marker, dropping the narration before it', () => {
    const output = ['I looked at the pager and fixed it.', REPORT_MARKER, '## What changed', '', 'Rewrote it.'].join('\n')
    expect(extractReport(output)).toBe('## What changed\n\nRewrote it.')
  })

  it('returns null when the agent produced no report', () => {
    expect(extractReport('I did some things and stopped.')).toBeNull()
  })

  it('returns null when the marker is there but nothing follows it', () => {
    expect(extractReport('done\n' + REPORT_MARKER + '\n  ')).toBeNull()
  })

  it('takes the last marker, so an agent echoing the instructions does not win', () => {
    const output = [REPORT_MARKER, 'the template', REPORT_MARKER, '## What changed', '', 'The real one.'].join('\n')
    expect(extractReport(output)).toContain('The real one.')
    expect(extractReport(output)).not.toContain('the template')
  })
})

describe('a step in the transcript', () => {
  it('keeps a long shell command readable instead of cutting it at 100 characters', async () => {
    // Reported live: every `Bash:` line in the log popup ended in an ellipsis
    // mid-command, which is the part you open the log to read.
    const command =
      'grep -n "float\\|display" src/components/modal/modal-styles.scss | head -40; echo "=== total lines"; wc -l src/components/modal/modal-styles.scss'
    const { progress } = await runOverEvents([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } },
    ])

    expect(unstamped(progress[0]?.line)).toBe('Bash: ' + command)
    expect(progress[0]?.line).not.toContain('…')
  })

  it('collapses a heredoc onto one line, since a step is one line', async () => {
    // appendCurrentProgress splits on newlines to keep its tail — a real line
    // break inside a step silently costs a step.
    const { progress } = await runOverEvents([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: "cat > f.scss <<'EOF'\n.a { b: c; }\nEOF" } }],
        },
      },
    ])

    expect(progress[0]?.line).not.toContain('\n')
    expect(unstamped(progress[0]?.line)).toBe("Bash: cat > f.scss <<'EOF' .a { b: c; } EOF")
  })

  it('still caps a single runaway step so it cannot swallow the record', async () => {
    const { progress } = await runOverEvents([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(5_000) }] } },
    ])

    expect(unstamped(progress[0]?.line).length).toBeLessThanOrEqual(MAX_STEP_CHARS)
    expect(progress[0]?.line).toContain('…')
  })

  it('reports what the agent said, not just its first line', async () => {
    const { progress } = await runOverEvents([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'I traced the bug.\nThe hr is 2px.' }] } },
    ])

    expect(unstamped(progress[0]?.line)).toBe('I traced the bug. The hr is 2px.')
  })
})

describe('what the transcript records', () => {
  it('records what a tool returned, not only what was run', async () => {
    // These were dropped at first, leaving a transcript of actions whose every
    // conclusion rested on output nobody could see.
    const { progress } = await runOverEvents([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep float x.css' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: '412:  float: left;' }] } },
    ])

    expect(progress.map((p) => p.line).join('\n')).toContain('→ 412: float: left;')
  })

  it('marks a failed tool call', async () => {
    const { progress } = await runOverEvents([
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'command not found: sass', is_error: true }] } },
    ])

    expect(progress[0]?.line).toContain('⚠')
    expect(progress[0]?.line).toContain('command not found')
  })

  it('keeps both ends of a long result, since which end matters varies', async () => {
    const long = 'FIRST' + 'x'.repeat(5_000) + 'LAST'
    const { progress } = await runOverEvents([
      { type: 'user', message: { content: [{ type: 'tool_result', content: long }] } },
    ])

    expect(progress[0]?.line).toContain('FIRST')
    expect(progress[0]?.line).toContain('LAST')
    expect(progress[0]?.line!.length).toBeLessThan(long.length)
  })

  it('handles a result delivered as content blocks rather than a string', async () => {
    const { progress } = await runOverEvents([
      { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'two matches' }] }] } },
    ])

    expect(progress[0]?.line).toContain('two matches')
  })

  it('stamps every step with elapsed time, so a long attempt can be read', async () => {
    const { progress } = await runOverEvents([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'looking' }] } },
    ])

    expect(progress[0]?.line).toMatch(/^\[\d{2}:\d{2}\] looking$/)
  })
})

describe('implementTask when the subscription has no capacity left', () => {
  it('flags a non-zero exit whose output names the usage limit', async () => {
    const command = ['sh', '-c', 'echo "Claude AI usage limit reached|1755000000" >&2; exit 1']
    const result = await implementTask('/tmp', INPUT, TICKET, command)

    expect(result.usageLimited).toBe(true)
  })

  it('does not flag a clean run whose report merely discusses rate limiting', async () => {
    // `output` is the agent's own report, and a ticket about the *target's*
    // rate limiting would otherwise be read as our own exhausted quota — and
    // a finished attempt's work thrown away. The zero exit is the guard.
    const command = ['sh', '-c', 'echo "fixed the 429 retry on the rate limit path"']
    const result = await implementTask('/tmp', INPUT, TICKET, command)

    expect(result.usageLimited).toBe(false)
  })

  it('does not flag an ordinary failure', async () => {
    const command = ['sh', '-c', 'echo "segmentation fault" >&2; exit 139']
    const result = await implementTask('/tmp', INPUT, TICKET, command)

    expect(result.usageLimited).toBe(false)
  })

  it('does not flag a command that could not start at all', async () => {
    const result = await implementTask('/tmp', INPUT, TICKET, ['this-binary-does-not-exist-anywhere'])

    expect(result.usageLimited).toBe(false)
  })
})

describe('implementTask when an upstream API call fails', () => {
  // Verbatim from the RPG-5827 attempt Foreman recorded as `no_change`.
  const LIVE_529 =
    'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.'

  it('flags the exact result Claude Code produced on RPG-5827', async () => {
    const result = await implementTask('/tmp', INPUT, TICKET, ['sh', '-c', `echo '${LIVE_529}'`])

    expect(result.apiError).toBe(true)
    // Not a usage limit: that distinction is what tells "wait for the window"
    // from "wait a minute", and 529 is neither 429 nor a quota message.
    expect(result.usageLimited).toBe(false)
  })

  it('flags it even on a clean exit, since the CLI reported it as its result', async () => {
    // The reason this is not guarded on the exit code: RPG-5827 arrived with a
    // result event, a cost and three transcript steps.
    const result = await implementTask('/tmp', INPUT, TICKET, ['sh', '-c', `echo '${LIVE_529}'; exit 0`])

    expect(result.apiError).toBe(true)
  })

  it('does not flag a report that merely mentions an API error it read somewhere', async () => {
    const command = ['sh', '-c', 'echo "the log was full of API Error: 500 lines from the target service"']
    const result = await implementTask('/tmp', INPUT, TICKET, command)

    expect(result.apiError).toBe(false)
  })

  it('prefers the usage limit when both could match', async () => {
    const command = ['sh', '-c', 'echo "API Error: 429 usage limit reached" >&2; exit 1']
    const result = await implementTask('/tmp', INPUT, TICKET, command)

    expect(result.usageLimited).toBe(true)
    expect(result.apiError).toBe(false)
  })
})
