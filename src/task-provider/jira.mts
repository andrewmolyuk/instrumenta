import { Buffer } from 'node:buffer'
import { adfToPlainText, type AdfNode } from './adf.mts'
import type { BacklogItem, TaskProvider } from './types.mts'

export interface JiraConfig {
  baseUrl: string
  email: string
  apiToken: string
  /**
   * The live backlog query — ordering (priority, sprint) and what counts as
   * "open" is the target project's own Jira setup, not something Foreman
   * invents (architecture.md's Jira section, ADR-001's eligibility check).
   */
  jql: string
  maxResults?: number
}

interface JiraSearchResponse {
  issues: Array<{
    key: string
    fields: {
      summary: string
      description: AdfNode | null
    }
  }>
}

/**
 * Uses /rest/api/3/search/jql, not the older /rest/api/3/search — Atlassian
 * has removed that endpoint, a dead end hit firsthand pulling Jira status
 * history for vision.md's baseline earlier this project.
 */
export class JiraTaskProvider implements TaskProvider {
  constructor(
    private readonly config: JiraConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listBacklog(): Promise<BacklogItem[]> {
    const auth = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64')
    const res = await this.fetchImpl(`${this.config.baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jql: this.config.jql,
        fields: ['summary', 'description'],
        maxResults: this.config.maxResults ?? 50,
      }),
    })

    if (!res.ok) {
      throw new Error(`Jira search failed: ${res.status} ${res.statusText}`)
    }

    const data = (await res.json()) as JiraSearchResponse
    return data.issues.map((issue) => ({
      jira_key: issue.key,
      summary: issue.fields.summary,
      description: adfToPlainText(issue.fields.description),
    }))
  }
}
