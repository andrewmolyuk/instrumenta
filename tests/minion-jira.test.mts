import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTicket, type MinionJiraConfig } from '../minion/jira.mts'

const CONFIG: MinionJiraConfig = { baseUrl: 'https://x.atlassian.net', email: 'bot@x', apiToken: 'jira-token' }

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function attachmentDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'minion-attach-'))
  return join(dir, 'attachments')
}

/** RPG-5427's real description: one screenshot, no text. */
const SCREENSHOT_ONLY = {
  type: 'doc',
  content: [{ type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: '240dad', alt: 'shot.png' } }] }],
}

function fakeFetch(issue: unknown, fileBody = 'PNGDATA') {
  return vi.fn(async (url: string, init?: RequestInit) => {
    void init
    if (String(url).includes('/rest/api/3/issue/')) {
      return { ok: true, status: 200, statusText: 'OK', json: async () => issue } as unknown as Response
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => new TextEncoder().encode(fileBody).buffer,
    } as unknown as Response
  })
}

describe('fetchTicket', () => {
  it('reads the summary and description the agent needs', async () => {
    const fetchImpl = fakeFetch({
      fields: {
        summary: 'web UI: SNMP MIB export text is not aligned',
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Columns drift.' }] }] },
      },
    })

    const ticket = await fetchTicket(CONFIG, 'RPG-5427', attachmentDir(), fetchImpl as unknown as typeof fetch)

    expect(ticket.summary).toBe('web UI: SNMP MIB export text is not aligned')
    expect(ticket.description).toBe('Columns drift.')
  })

  it('downloads attachments and reports where they landed', async () => {
    const target = attachmentDir()
    const fetchImpl = fakeFetch({
      fields: {
        summary: 'web UI: SNMP MIB export text is not aligned',
        description: SCREENSHOT_ONLY,
        attachment: [{ filename: 'shot.png', mimeType: 'image/png', content: 'https://x.atlassian.net/attach/1' }],
      },
    })

    const ticket = await fetchTicket(CONFIG, 'RPG-5427', target, fetchImpl as unknown as typeof fetch)

    expect(ticket.attachments).toHaveLength(1)
    expect(ticket.attachments[0]?.filename).toBe('shot.png')
    expect(existsSync(ticket.attachments[0]!.path)).toBe(true)
    expect(readFileSync(ticket.attachments[0]!.path, 'utf-8')).toBe('PNGDATA')
    // The screenshot-only description is no longer an empty string.
    expect(ticket.description).toBe('[image: shot.png]')
  })

  it('authenticates both the issue read and the attachment download', async () => {
    const fetchImpl = fakeFetch({
      fields: {
        summary: 's',
        description: null,
        attachment: [{ filename: 'a.png', mimeType: 'image/png', content: 'https://x.atlassian.net/attach/1' }],
      },
    })

    await fetchTicket(CONFIG, 'RPG-1', attachmentDir(), fetchImpl as unknown as typeof fetch)

    for (const call of fetchImpl.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ Authorization: expect.stringMatching(/^Basic /) })
    }
  })

  it('keeps same-named attachments apart instead of overwriting', async () => {
    const fetchImpl = fakeFetch({
      fields: {
        summary: 's',
        description: null,
        attachment: [
          { filename: 'shot.png', mimeType: 'image/png', content: 'https://x/1' },
          { filename: 'shot.png', mimeType: 'image/png', content: 'https://x/2' },
        ],
      },
    })

    const ticket = await fetchTicket(CONFIG, 'RPG-1', attachmentDir(), fetchImpl as unknown as typeof fetch)

    expect(ticket.attachments).toHaveLength(2)
    expect(ticket.attachments[0]?.path).not.toBe(ticket.attachments[1]?.path)
  })

  it('survives an attachment it cannot download, keeping the ticket text', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/rest/api/3/issue/')) {
        return {
          ok: true, status: 200, statusText: 'OK',
          json: async () => ({
            fields: {
              summary: 'still usable',
              description: null,
              attachment: [{ filename: 'gone.png', mimeType: 'image/png', content: 'https://x/gone' }],
            },
          }),
        } as unknown as Response
      }
      return { ok: false, status: 404, statusText: 'Not Found' } as unknown as Response
    })

    const ticket = await fetchTicket(CONFIG, 'RPG-1', attachmentDir(), fetchImpl as unknown as typeof fetch)

    expect(ticket.summary).toBe('still usable')
    expect(ticket.attachments).toEqual([])
  })

  it('throws when the issue itself cannot be read, rather than running on nothing', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, statusText: 'Forbidden' }) as unknown as Response)

    await expect(
      fetchTicket(CONFIG, 'RPG-1', attachmentDir(), fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/RPG-1: 403/)
  })
})
