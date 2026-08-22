import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PR_DESCRIPTION_CHARS, MAX_SESSION_CHARS } from '../minion/constants.mts'
import { buildPrDescription, buildSessionRecord } from '../minion/session.mts'
import type { MinionInput } from '../src/minion/types.mts'
import type { JiraTicket } from '../minion/jira.mts'

function input(overrides: Partial<MinionInput> = {}): MinionInput {
  return { task_id: 't1', jira_key: 'KAZ-1', attempt_number: 1, ...overrides }
}

function ticket(overrides: Partial<JiraTicket> = {}): JiraTicket {
  return { summary: 'Fix the thing', description: 'Fix the thing', attachments: [], ...overrides }
}

const REPORT = {
  input: input(),
  ticket: ticket(),
  transcript: ['Read: src/foo.ts', 'Bash: npm run lint'],
  agentSummary: 'fixed the thing',
  costUsd: 1.83,
}

afterEach(() => {
  delete process.env.MINION_CLAUDE_MODEL
  delete process.env.MINION_CLAUDE_EFFORT
})

describe('buildSessionRecord', () => {
  it('records the ticket, attempt, model, effort and cost', () => {
    process.env.MINION_CLAUDE_MODEL = 'claude-sonnet-5'
    process.env.MINION_CLAUDE_EFFORT = 'max'

    const record = buildSessionRecord(REPORT)

    expect(record).toContain('KAZ-1 (attempt 1)')
    expect(record).toContain('claude-sonnet-5 (effort max)')
    expect(record).toContain('$1.83')
  })

  it('records the problem statement the agent was given, and every step it took', () => {
    const record = buildSessionRecord(REPORT)

    expect(record).toContain('Fix the thing')
    expect(record).toContain('Read: src/foo.ts')
    expect(record).toContain('Bash: npm run lint')
    expect(record).toContain('What the agent did (2 steps)')
    expect(record).toContain('fixed the thing')
  })

  it('says so loudly when the agent was given no problem statement at all', () => {
    // RPG-5427: the Jira description was one screenshot, which renders to an
    // empty string, so the agent was asked to fix nothing in particular — and
    // the resulting attempt was recorded as an ordinary `success`.
    const record = buildSessionRecord({ ...REPORT, ticket: ticket({ summary: '', description: '' }) })

    expect(record).toContain('The agent was given no problem statement')
    expect(record).toContain('neither a summary nor a description')
  })

  it('flags a ticket that has a title but no description at all', () => {
    // The RPG-5427 shape once the summary reaches the agent: still worth
    // flagging, because whatever the screenshot showed is not in the brief.
    const record = buildSessionRecord({ ...REPORT, ticket: ticket({ description: '' }) })

    expect(record).toContain('Title only')
    expect(record).toContain('Fix the thing')
  })

  it('treats a whitespace-only description as no problem statement', () => {
    const record = buildSessionRecord({ ...REPORT, ticket: ticket({ summary: '  ', description: '  \n\t ' }) })
    expect(record).toContain('The agent was given no problem statement')
  })

  it('is explicit about an agent that reported no steps or no summary', () => {
    const record = buildSessionRecord({ ...REPORT, transcript: [], agentSummary: '' })

    expect(record).toContain('(the agent reported no steps)')
    expect(record).toContain('(the agent produced no summary)')
    expect(record).toContain('What the agent did (0 steps)')
  })

  it('reports an unknown cost as unknown rather than $0.00', () => {
    expect(buildSessionRecord({ ...REPORT, costUsd: null })).toContain('**Cost:** unknown')
  })

  it('redacts credentials out of the steps the agent took', () => {
    const record = buildSessionRecord({
      ...REPORT,
      transcript: ['Bash: git push https://x-token-auth:SUPERSECRET@bitbucket.org/CGS/webui.git'],
    })

    expect(record).not.toContain('SUPERSECRET')
    expect(record).toContain('x-token-auth:***@bitbucket.org')
  })

  it('keeps the tail when a session runs past the cap', () => {
    const record = buildSessionRecord({
      ...REPORT,
      transcript: Array.from({ length: 50_000 }, (_, i) => 'Read: src/file-' + i + '.ts'),
    })

    expect(record.length).toBeLessThanOrEqual(MAX_SESSION_CHARS + 20)
    expect(record).toContain('…(truncated)…')
    // The tail is what survives: the agent's closing summary, not its first steps.
    expect(record).toContain('fixed the thing')
    expect(record).not.toContain('Read: src/file-0.ts')
  })
})

describe('buildPrDescription', () => {
  it("uses the agent's own report, which is what a reviewer reads", () => {
    const report = ['## What changed', '', 'Rewrote the pager.', '', '## Questions for a human', '', '- Which sort order was intended?'].join('\n')
    expect(buildPrDescription(ticket(), report)).toBe(report)
  })

  it('falls back to the ticket description when the agent produced no report', () => {
    const body = buildPrDescription(ticket({ description: 'Columns drift.' }), null)

    expect(body).toContain('did not produce a report')
    expect(body).toContain('Columns drift.')
  })

  it('never produces an empty body, even for a ticket with no description', () => {
    // RPG-5427's pull request shipped with an empty body.
    const body = buildPrDescription(ticket({ description: '' }), null)

    expect(body.trim().length).toBeGreaterThan(0)
    expect(body).toContain('no text description')
  })

  it('redacts credentials the agent may have echoed into its report', () => {
    const body = buildPrDescription(ticket(), 'I ran git push https://x-token-auth:SECRET@bitbucket.org/CGS/webui.git')

    expect(body).not.toContain('SECRET')
    expect(body).toContain('x-token-auth:***@bitbucket.org')
  })

  it("keeps the tail when a report runs past Bitbucket's limit", () => {
    const body = buildPrDescription(ticket(), 'x'.repeat(40_000) + '\nTHE END')

    expect(body.length).toBeLessThanOrEqual(MAX_PR_DESCRIPTION_CHARS + 20)
    expect(body).toContain('THE END')
  })
})
