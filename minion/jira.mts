import { Buffer } from 'node:buffer'
import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
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

/**
 * Posts a comment on the ticket.
 *
 * Used to say why an attempt concluded that nothing needed changing (ADR-014):
 * the pipeline cannot verify that claim, so it goes to the humans who can,
 * where they already work, rather than only into a database they would have to
 * think to check. Jira's comment body is ADF, so the text is wrapped in the
 * minimal document that renders as paragraphs.
 *
 * Best-effort: a comment that fails to post must not turn a finished attempt
 * into a failed one. The caller gets `false` and carries on.
 */
export async function commentOnTicket(
  config: MinionJiraConfig,
  jiraKey: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const body = {
    type: 'doc',
    version: 1,
    content: text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  }
  try {
    const res = await fetchImpl(`${config.baseUrl}/rest/api/3/issue/${jiraKey}/comment`, {
      method: 'POST',
      headers: { Authorization: authHeader(config), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    })
    if (!res.ok) console.error(`Jira comment on ${jiraKey} failed: ${res.status} ${res.statusText}`)
    return res.ok
  } catch (err) {
    console.error(`Jira comment on ${jiraKey} failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/**
 * Attaches a file to the ticket. Returns false if it could not be uploaded.
 *
 * Used for the before/after screenshots of a visual fix (ADR-016): they belong
 * on the ticket rather than in the pull request because Bitbucket will not
 * render an inline image, and because the ticket is where the person who
 * reported the bug with a screenshot is looking.
 *
 * `X-Atlassian-Token: no-check` is required by Jira for this endpoint and the
 * upload is rejected without it. Content-Type is deliberately not set — fetch
 * generates the multipart boundary, and overriding it corrupts the body.
 *
 * Best-effort, like commentOnTicket: a failed upload must not turn a finished
 * attempt into a failed one.
 */
export async function attachToTicket(
  config: MinionJiraConfig,
  jiraKey: string,
  filePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return false
    // Read into a File rather than appending the BunFile with a filename
    // argument: Bun ignores that argument and sends the whole temp path as the
    // name, so the ticket would show an attachment called
    // `/tmp/minion-<uuid>-shots/before.png`. Screenshots are small enough that
    // holding one in memory costs nothing.
    const form = new FormData()
    form.append('file', new File([await file.arrayBuffer()], basename(filePath), { type: file.type }))

    const res = await fetchImpl(`${config.baseUrl}/rest/api/3/issue/${jiraKey}/attachments`, {
      method: 'POST',
      headers: { Authorization: authHeader(config), 'X-Atlassian-Token': 'no-check' },
      body: form,
    })
    if (!res.ok) console.error(`Jira attachment on ${jiraKey} failed: ${res.status} ${res.statusText}`)
    return res.ok
  } catch (err) {
    console.error(`Jira attachment on ${jiraKey} failed: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
