import { Buffer } from 'node:buffer'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { adfToPlainText, type AdfNode } from '../src/task-provider/adf.mts'

/**
 * Minion's own read of the ticket it was dispatched for.
 *
 * Foreman passes only the identity of the attempt (MinionInput) — the ticket's
 * body is read here, live, at the start of the attempt. That means the agent
 * works from what the ticket says now rather than what Foreman read when it
 * built its queue, and it means attachments are reachable at all: a Jira
 * `media` node carries an attachment id that resolves only against an
 * authenticated endpoint, so the screenshot on a UI bug is invisible to anyone
 * without credentials.
 *
 * Found live on RPG-5427 — a UI alignment bug whose entire description is one
 * screenshot. Foreman rendered that to an empty string and dispatched anyway,
 * and the agent, with no statement of the problem, produced a $9.69 pull
 * request titled `RPG-5427: ` with an empty body.
 */
export interface MinionJiraConfig {
  baseUrl: string
  email: string
  apiToken: string
}

export interface JiraAttachment {
  filename: string
  mimeType: string
  /** Absolute path the file was written to — outside the git work tree, so it is never committed. */
  path: string
}

export interface JiraTicket {
  summary: string
  description: string
  attachments: JiraAttachment[]
}

interface JiraIssueResponse {
  fields: {
    summary: string
    description: AdfNode | null
    attachment?: Array<{ filename: string; mimeType: string; content: string }>
  }
}

function authHeader(config: MinionJiraConfig): string {
  return `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`
}

/**
 * Reads the ticket and downloads its attachments into `attachmentDir`.
 *
 * `attachmentDir` must sit outside the cloned repository: `stageAll` runs
 * `git add -A`, so anything written inside the work tree ends up in the commit
 * and then in the pull request.
 *
 * Attachment download is best-effort per file — one unreadable attachment
 * shouldn't cost the whole attempt, which still has a summary and a description
 * to work from. A failure to read the *issue*, by contrast, is fatal: proceeding
 * without it is exactly the RPG-5427 failure, an agent working from nothing.
 */
export async function fetchTicket(
  config: MinionJiraConfig,
  jiraKey: string,
  attachmentDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraTicket> {
  const res = await fetchImpl(
    `${config.baseUrl}/rest/api/3/issue/${jiraKey}?fields=summary,description,attachment`,
    { headers: { Authorization: authHeader(config), Accept: 'application/json' } },
  )
  if (!res.ok) {
    throw new Error(`Jira issue read failed for ${jiraKey}: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as JiraIssueResponse
  const attachments: JiraAttachment[] = []
  const candidates = data.fields.attachment ?? []

  if (candidates.length > 0) await mkdir(attachmentDir, { recursive: true })
  for (const [index, candidate] of candidates.entries()) {
    // Prefixed with the index: Jira allows two attachments with the same
    // filename on one issue, and the second would otherwise overwrite the first.
    const path = join(attachmentDir, `${index + 1}-${candidate.filename.replace(/[/\\]/g, '_')}`)
    try {
      const file = await fetchImpl(candidate.content, { headers: { Authorization: authHeader(config) } })
      if (!file.ok) continue
      await Bun.write(path, await file.arrayBuffer())
      attachments.push({ filename: candidate.filename, mimeType: candidate.mimeType, path })
    } catch {
      // Best-effort, per the note above.
    }
  }

  return {
    summary: data.fields.summary ?? '',
    description: adfToPlainText(data.fields.description),
    attachments,
  }
}
