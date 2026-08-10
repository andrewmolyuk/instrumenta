import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildPrompt,
  CHILD_ENV_FLAG,
  extractTranscriptText,
  isChildRun,
  MIN_TRANSCRIPT_CHARS,
  scopedSettings,
  shouldRun,
} from '../.claude/hooks/session-doc-mining-utils.mts'

const HOOK = join(import.meta.dirname, '..', '.claude', 'hooks', 'document-session-learnings.mts')
const HOOK_DIR = dirname(HOOK)

describe('shouldRun', () => {
  it.each(['clear', 'other', 'prompt_input_exit', ''])('runs on reason %j', (reason) => {
    expect(shouldRun(reason)).toBe(true)
  })

  it('skips a logout — that ends the account, not work on this project', () => {
    expect(shouldRun('logout')).toBe(false)
  })
})

describe('isChildRun', () => {
  it('is false for an ordinary session', () => {
    expect(isChildRun({ PATH: '/usr/bin' })).toBe(false)
  })

  it('is true once the mining sub-call has marked the environment', () => {
    expect(isChildRun({ [CHILD_ENV_FLAG]: '1' })).toBe(true)
  })

  it('treats an empty value as not a child, so an unset-but-present var cannot wedge the hook off', () => {
    expect(isChildRun({ [CHILD_ENV_FLAG]: '' })).toBe(false)
  })
})

describe('extractTranscriptText', () => {
  const line = (obj: unknown) => `${JSON.stringify(obj)}\n`

  it('extracts string content from user/assistant lines', () => {
    const transcript =
      line({ type: 'user', message: { content: 'hello' } }) +
      line({ type: 'assistant', message: { content: 'world' } })
    expect(extractTranscriptText(transcript, 1000)).toBe('hello\nworld')
  })

  it('extracts text blocks from array content, ignoring non-text blocks', () => {
    const transcript = line({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }],
      },
    })
    expect(extractTranscriptText(transcript, 1000)).toBe('ab')
  })

  it('ignores non user/assistant lines and malformed JSON', () => {
    const transcript =
      line({ type: 'system', message: { content: 'nope' } }) +
      'not json at all\n' +
      line({ type: 'user', message: { content: 'kept' } })
    expect(extractTranscriptText(transcript, 1000)).toBe('kept')
  })

  it('keeps only the last maxChars characters', () => {
    const transcript = line({ type: 'user', message: { content: 'a'.repeat(20) } })
    expect(extractTranscriptText(transcript, 5)).toBe('aaaaa')
    expect(extractTranscriptText(transcript, 5).length).toBe(5)
  })
})

describe('buildPrompt', () => {
  it('substitutes date, session id, and transcript, and keeps the safety rails', () => {
    const prompt = buildPrompt('2026-08-10', 'sess-1', 'TRANSCRIPT_MARKER')
    expect(prompt).toContain('2026-08-10')
    expect(prompt).toContain('sess-1')
    expect(prompt).toContain('TRANSCRIPT_MARKER')
    expect(prompt).toContain('docs/todo/')
    expect(prompt).toContain('docs/decisions/, will be rejected')
    expect(prompt).toContain('RESULT:')
  })
})

describe('scopedSettings', () => {
  it('is valid JSON that allows Edit only under docs/todo/ and denies Bash', () => {
    const parsed = JSON.parse(scopedSettings())
    expect(parsed.permissions.allow).toContain('Edit(docs/todo/**)')
    expect(parsed.permissions.deny).toContain('Bash')
  })
})

describe('document-session-learnings hook — deterministic exit-early paths', () => {
  const tempDirs: string[] = []
  afterAll(() => tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

  function runHook(input: Record<string, unknown>, env?: NodeJS.ProcessEnv): number {
    const res = spawnSync(HOOK, {
      input: JSON.stringify(input),
      encoding: 'utf8',
      ...(env ? { env: { ...process.env, ...env } } : {}),
    })
    return res.status ?? -1
  }

  it('exits 0 inside a mining sub-call without spawning a second one', () => {
    // The recursion this guards: the detached `claude -p` runs under the
    // project's settings, so its own SessionEnd re-entered this hook with a
    // fresh session id the marker file could not match. Observed live: 12
    // accelerating spawns before it was killed by hand.
    const dir = mkdtempSync(join(tmpdir(), 'instrumenta-sessionend-child-'))
    tempDirs.push(dir)
    const transcriptPath = join(dir, 'long.jsonl')
    const long = 'x'.repeat(MIN_TRANSCRIPT_CHARS * 2)
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: 'user', message: { content: long } })}\n`,
    )

    const input = { reason: 'other', transcript_path: transcriptPath, session_id: 'child-session' }
    expect(runHook(input, { [CHILD_ENV_FLAG]: '1' })).toBe(0)
    // The marker is written immediately before the spawn, so its absence is
    // proof the hook bailed out rather than launching a sub-call.
    expect(existsSync(join(HOOK_DIR, '.summarized-child-session'))).toBe(false)
  })

  it('exits 0 immediately on a logout, before touching the transcript', () => {
    expect(runHook({ reason: 'logout', transcript_path: '/does/not/exist' })).toBe(0)
  })

  it('exits 0 when no transcript_path is given', () => {
    expect(runHook({ reason: 'clear' })).toBe(0)
  })

  it('exits 0 when transcript_path does not exist on disk', () => {
    expect(runHook({ reason: 'clear', transcript_path: '/does/not/exist.jsonl' })).toBe(0)
  })

  it('exits 0 on a transcript too short to be worth mining', () => {
    const dir = mkdtempSync(join(tmpdir(), 'instrumenta-sessionend-'))
    tempDirs.push(dir)
    const transcriptPath = join(dir, 'short.jsonl')
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: 'user', message: { content: 'too short' } })}\n`,
    )
    expect('too short'.length).toBeLessThan(MIN_TRANSCRIPT_CHARS)
    expect(runHook({ reason: 'clear', transcript_path: transcriptPath, session_id: 'x' })).toBe(0)
  })

  it('tolerates malformed input', () => {
    const res = spawnSync(HOOK, { input: 'not json at all', encoding: 'utf8' })
    expect(res.status).toBe(0)
  })
})
