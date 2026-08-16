import { Buffer } from 'node:buffer'
import type { TaskRow } from '../db/index.mts'
import type { StatusMirror } from './loop.mts'

export interface JiraAuthConfig {
  baseUrl: string
  email: string
  apiToken: string
}

interface Transition {
  id: string
  to: { name: string }
}

interface TransitionsResponse {
  transitions: Transition[]
}

/**
 * ADR-001's mirror, write-only for human visibility: Jira's live query stays
 * the authority on eligibility, this never reads status back. Looks up the
 * issue's available transitions and matches by target status *name* rather
 * than a hardcoded transition id, since transition ids are workflow-specific
 * per target project. If the target project's workflow has no status named
 * "In Progress", this silently does nothing — same as the verify gate and
 * notes-path elsewhere, Foreman doesn't invent a convention a target project
 * didn't provide.
 *
 * ADR-007 (amends ADR-001): `success` no longer transitions to "Done" — a
 * successful attempt only means Minion opened a PR that passed verify, not
 * that a human has reviewed or merged it. `onComplete` is a no-op for every
 * attempt status now; a ticket stays wherever `onDispatch` left it ("In
 * Progress") until a human moves it to Done themselves, after actually
 * merging the PR.
 */
export class JiraStatusMirror implements StatusMirror {
  constructor(
    private readonly config: JiraAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async onDispatch(jiraKey: string): Promise<void> {
    await this.transitionTo(jiraKey, 'In Progress')
  }

  async onComplete(_row: TaskRow): Promise<void> {}

  private async transitionTo(jiraKey: string, statusName: string): Promise<void> {
    const transitions = await this.listTransitions(jiraKey)
    const match = transitions.find((t) => t.to.name.toLowerCase() === statusName.toLowerCase())
    if (!match) return

    const res = await this.fetchImpl(`${this.config.baseUrl}/rest/api/3/issue/${jiraKey}/transitions`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transition: { id: match.id } }),
    })

    if (!res.ok) {
      throw new Error(`Jira transition failed: ${res.status} ${res.statusText}`)
    }
  }

  private async listTransitions(jiraKey: string): Promise<Transition[]> {
    const res = await this.fetchImpl(`${this.config.baseUrl}/rest/api/3/issue/${jiraKey}/transitions`, {
      headers: { Authorization: this.authHeader() },
    })

    if (!res.ok) {
      throw new Error(`Jira transitions lookup failed: ${res.status} ${res.statusText}`)
    }

    const data = (await res.json()) as TransitionsResponse
    return data.transitions
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64')}`
  }
}
