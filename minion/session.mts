import type { MinionInput } from '../src/minion/types.mts'
import type { JiraTicket } from './jira.mts'
import { MAX_PR_DESCRIPTION_CHARS, MAX_SESSION_CHARS } from './constants.mts'
import { claudeEffort, claudeModel } from './implement-task.mts'
import { redactCredentials } from './redact.mts'

/** Everything known about what the agent did, once implementTask returns. */
export interface SessionReport {
  input: MinionInput
  /** The ticket as Minion read it from Jira at the start of the attempt. */
  ticket: JiraTicket
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
function problemStatement(ticket: JiraTicket): string {
  const stated = [ticket.summary, ticket.description].map((part) => part.trim()).filter(Boolean)
  if (stated.length === 0) {
    return [
      '> **⚠ The agent was given no problem statement.**',
      '> This ticket had neither a summary nor a description that produced any',
      '> text. Whatever this attempt changed was not derived from a stated',
      '> problem. Review it on that basis.',
    ].join('\n')
  }
  const warning =
    ticket.description.trim().length === 0
      ? ['', '> **⚠ Title only** — this ticket has no text description.', '']
      : []
  return ['```text', ...stated, '```', ...warning].join('\n')
}

/**
 * The session record stored in `tasks.session` — the whole run, uncompressed
 * apart from MAX_SESSION_CHARS, which keeps the tail.
 */
export function buildSessionRecord(report: SessionReport): string {
  const { input, ticket, transcript, agentSummary, costUsd } = report
  const sections = [
    '## Minion session',
    '',
    `- **Ticket:** ${input.jira_key} (attempt ${input.attempt_number})`,
    `- **Model:** ${claudeModel()} (effort ${claudeEffort()})`,
    `- **Cost:** ${costUsd === null ? 'unknown' : `$${costUsd.toFixed(2)}`}`,
    `- **Attachments read:** ${ticket.attachments.length === 0 ? 'none' : ticket.attachments.map((a) => a.filename).join(', ')}`,
    '',
    '### Problem statement given to the agent',
    '',
    problemStatement(ticket),
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

/**
 * The pull request body: the agent's own closing report — what it changed and
 * why, what it would have asked a human, and what it decided without one.
 *
 * The agent writes this, not this function, because only the agent knows which
 * of its choices were judgement calls. That is the half a reviewer most needs
 * and the half no transcript makes obvious: a list of steps shows what happened,
 * not which of it was a guess. The full session goes to `tasks.session`; this is
 * the part worth putting in front of a human.
 *
 * Falls back to the ticket description when the agent produced no report in the
 * requested form — an empty pull request body is what RPG-5427 shipped, and it
 * is worse than a stale one.
 */
export function buildPrDescription(input: MinionInput, ticket: JiraTicket, agentReport: string | null): string {
  const body =
    agentReport ??
    [
      '_The agent did not produce a report for this attempt._',
      '',
      ticket.description || '_This ticket has no text description._',
    ].join('\n')
  return tail(redactCredentials(`${body}\n\n---\n${ticketFooter(input, ticket)}`), MAX_PR_DESCRIPTION_CHARS)
}

/**
 * The ticket this pull request is for, linked, at the bottom of the body.
 *
 * The title carries the key already, but as plain text — a reviewer asking
 * "what is this fixing?" had nothing to click and no summary beyond the
 * truncated title. `JIRA_BASE_URL` is read from the environment rather than
 * threaded through, the same way the model and the gate command are; without it
 * the key still appears, just not as a link.
 */
function ticketFooter(input: MinionInput, ticket: JiraTicket): string {
  const base = process.env.JIRA_BASE_URL?.trim().replace(/\/$/, '')
  const key = base ? `[${input.jira_key}](${base}/browse/${encodeURIComponent(input.jira_key)})` : input.jira_key
  return ticket.summary.trim() ? `${key} — ${ticket.summary.trim()}` : key
}
