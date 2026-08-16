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
 *
 * Found live: some target workflows don't expose "In Progress" as a direct,
 * one-hop transition from every starting status — Jira's transitions
 * endpoint only ever returns the hops reachable from the issue's *current*
 * status, so "To Do" -> "In Progress" silently does nothing if the workflow
 * actually requires "To Do" -> "Approved" -> "In Progress". `onDispatch`
 * gives `transitionTo` "Approved" as a fallback hop to try — only used when
 * the direct transition isn't available — rather than generalizing to
 * arbitrary multi-hop pathfinding, since this specific two-hop shape is the
 * one actually observed, not a hypothetical one.
 */
export class JiraStatusMirror implements StatusMirror {
  constructor(
    private readonly config: JiraAuthConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async onDispatch(jiraKey: string): Promise<void> {
    await this.transitionTo(jiraKey, 'In Progress', 'Approved')
  }

  async onComplete(_row: TaskRow): Promise<void> {}

  private async transitionTo(jiraKey: string, statusName: string, viaStatusName?: string): Promise<void> {
    const transitions = await this.listTransitions(jiraKey)
    const match = transitions.find((t) => t.to.name.toLowerCase() === statusName.toLowerCase())
    if (match) {
      await this.applyTransition(jiraKey, match.id)
      return
    }

    if (!viaStatusName) return
    const viaMatch = transitions.find((t) => t.to.name.toLowerCase() === viaStatusName.toLowerCase())
    if (!viaMatch) return

    await this.applyTransition(jiraKey, viaMatch.id)
    await this.transitionTo(jiraKey, statusName)
  }

  private async applyTransition(jiraKey: string, transitionId: string): Promise<void> {
    const res = await this.fetchImpl(`${this.config.baseUrl}/rest/api/3/issue/${jiraKey}/transitions`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transition: { id: transitionId } }),
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
