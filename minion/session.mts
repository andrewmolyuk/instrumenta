import type { MinionInput } from '../src/minion/types.mts'
import { MAX_SESSION_CHARS } from './constants.mts'
import { claudeEffort, claudeModel } from './implement-task.mts'
import { redactCredentials } from './redact.mts'

/** Everything known about what the agent did, once implementTask returns. */
export interface SessionReport {
  input: MinionInput
  /** The agent's own trail of steps, in order (ImplementResult.transcript). */
  transcript: string[]
  /** Claude Code's final `result` text — the agent's account of what it did. */
  agentSummary: string
  costUsd: number | null
}

/** Keeps the last `max` characters, marking that earlier text was dropped. */
function tail(text: string, max: number): string {
  return text.length > max ? `…(truncated)…\n${text.slice(-max)}` : text
}

/**
 * The problem statement the agent actually received.
 *
 * This is the single most useful line in the whole report, and the reason it is
 * stated separately rather than left implicit: found live on RPG-5427, whose
 * Jira description is one embedded screenshot and no text at all. adfToPlainText
 * renders that as an empty string, so the agent was asked to fix a ticket with
 * no problem statement whatsoever — and produced a PR anyway, which passed the
 * gate, because the gate only checks that the project's own tests pass. Nothing
 * recorded anywhere said so — the attempt was stored as a plain `success`. Now
 * the record says it in the first section, where a reviewer sees it first.
 */
function problemStatement(input: MinionInput): string {
  if (input.description.trim().length === 0) {
    return [
      '> **⚠ The agent was given no problem statement.**',
      '> This ticket\'s description produced no text — it is empty, or holds only',
      '> images or attachments, which are not passed to the agent. Whatever this',
      '> attempt changed was not derived from a stated problem. Review it on that',
      '> basis.',
    ].join('\n')
  }
  return ['```text', input.description, '```'].join('\n')
}

/**
 * The session record stored in `tasks.session` — the whole run, uncompressed
 * apart from MAX_SESSION_CHARS, which keeps the tail.
 */
export function buildSessionRecord(report: SessionReport): string {
  const { input, transcript, agentSummary, costUsd } = report
  const sections = [
    '## Minion session',
    '',
    `- **Ticket:** ${input.jira_key} (attempt ${input.attempt_number})`,
    `- **Model:** ${claudeModel()} (effort ${claudeEffort()})`,
    `- **Cost:** ${costUsd === null ? 'unknown' : `$${costUsd.toFixed(2)}`}`,
    '',
    '### Problem statement given to the agent',
    '',
    problemStatement(input),
    '',
    `### What the agent did (${transcript.length} step${transcript.length === 1 ? '' : 's'})`,
    '',
    '```text',
    transcript.length > 0 ? transcript.join('\n') : '(the agent reported no steps)',
    '```',
    '',
    "### The agent's own summary",
    '',
    agentSummary.trim().length > 0 ? agentSummary : '(the agent produced no summary)',
  ]
  return tail(redactCredentials(sections.join('\n')), MAX_SESSION_CHARS)
}
