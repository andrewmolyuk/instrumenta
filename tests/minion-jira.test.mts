import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachToTicket, fetchTicket, type MinionJiraConfig } from '../minion/jira.mts'

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

describe('attachToTicket', () => {
  function shot(): string {
    dir = mkdtempSync(join(tmpdir(), 'minion-shot-'))
    const path = join(dir, 'before.png')
    writeFileSync(path, 'PNGBYTES')
    return path
  }

  it('uploads the file with the header Jira requires', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 201, statusText: 'Created' }) as unknown as Response)

    expect(await attachToTicket(CONFIG, 'RPG-1', shot(), fetchImpl as unknown as typeof fetch)).toBe(true)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://x.atlassian.net/rest/api/3/issue/RPG-1/attachments')
    // Jira rejects this endpoint outright without the token header, and fetch
    // must be left to set its own multipart boundary.
    expect(init?.headers).toMatchObject({ 'X-Atlassian-Token': 'no-check' })
    expect(init?.headers).not.toHaveProperty('Content-Type')
    expect(init?.body).toBeInstanceOf(FormData)
  })

  it('sends the file under its own name, not a temp path', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 201, statusText: 'Created' }) as unknown as Response)
    await attachToTicket(CONFIG, 'RPG-1', shot(), fetchImpl as unknown as typeof fetch)

    const form = fetchImpl.mock.calls[0]![1]!.body as FormData
    expect((form.get('file') as File).name).toBe('before.png')
  })

  it('reports false for a file the agent never produced, without calling Jira', async () => {
    // The common case: the ticket was not a visual one, so there is no screenshot.
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, statusText: 'Created' }) as unknown as Response)

    expect(await attachToTicket(CONFIG, 'RPG-1', '/tmp/nope/after.png', fetchImpl as unknown as typeof fetch)).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports false rather than throwing when the upload is rejected', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 413, statusText: 'Payload Too Large' }) as unknown as Response)
    expect(await attachToTicket(CONFIG, 'RPG-1', shot(), fetchImpl as unknown as typeof fetch)).toBe(false)
  })
})
