#!/usr/bin/env bun
/**
 * SessionEnd hook — mines the transcript for anything worth a permanent
 * docs/todo/ entry before the session disappears (ADR-014).
 *
 * SessionEnd hooks can't block anything and get a small time budget, and the
 * real content-authorship call (`claude -p`) takes far longer than any sane
 * hook timeout — so this script spawns it detached (Node/Bun's
 * `{ detached: true }` + `.unref()`, the JS equivalent of the reference
 * implementation's `setsid`/`disown`) and returns immediately. Wired with
 * `"async": true` in settings.json so the session doesn't wait on this hook
 * either.
 *
 * Deliberately fire-and-forget and conservative: cheaper and safer to miss
 * something than to write a wrong/noisy doc nobody can review before the
 * session ends. Per ADR-014, the sub-call's write permission is scoped to
 * docs/todo/** only — it can never reach docs/decisions/, so there's no
 * immutable-record risk to reason about here.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  buildPrompt,
  extractTranscriptText,
  MIN_TRANSCRIPT_CHARS,
  scopedSettings,
  shouldRun,
} from './session-doc-mining-utils.mts'

const MODEL = process.env.DOCUMENT_SESSION_MODEL || 'sonnet'
const MAX_TRANSCRIPT_CHARS = Number(process.env.DOCUMENT_SESSION_MAX_CHARS) || 40_000

const HOOK_DIR = dirname(new URL(import.meta.url).pathname)
const LOG_DIR = join(HOOK_DIR, '..', 'logs')
const LOG_FILE = join(LOG_DIR, 'document-session-learnings.log')

type SessionEndInput = {
  reason?: string
  transcript_path?: string
  session_id?: string
  cwd?: string
}

function log(sessionId: string, message: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(
      LOG_FILE,
      `${new Date().toISOString()} [${sessionId || 'unknown'}] ${message}\n`,
      {
        flag: 'a',
      },
    )
  } catch {
    // Logging is best-effort — a full disk or missing dir shouldn't crash the hook.
  }
  process.stderr.write(`document-session-learnings: ${message}\n`)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function parseInput(raw: string): SessionEndInput {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

const input = parseInput(await readStdin())
const sessionId = input.session_id || 'unknown'
const reason = input.reason || ''

if (!shouldRun(reason)) process.exit(0)

if (!input.transcript_path || !existsSync(input.transcript_path)) {
  log(sessionId, 'no transcript available, skipping')
  process.exit(0)
}

// Detached review calls have no synchronous result to dedup against, so guard
// against a double-fire (e.g. a retried hook invocation) up front instead.
const marker = join(HOOK_DIR, `.summarized-${sessionId}`)
if (existsSync(marker)) {
  log(sessionId, 'already spawned a review for this session, skipping')
  process.exit(0)
}

const transcriptRaw = readFileSync(input.transcript_path, 'utf8')
const transcriptText = extractTranscriptText(transcriptRaw, MAX_TRANSCRIPT_CHARS)
if (transcriptText.length < MIN_TRANSCRIPT_CHARS) {
  log(sessionId, 'transcript too short to mine, skipping')
  process.exit(0)
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
const dateStr = new Date().toISOString().slice(0, 10)
const prompt = buildPrompt(dateStr, sessionId, transcriptText)

// Written before the spawn, not after: it records "attempted", not
// "succeeded" — the point is to stop a same-session retry from piling up a
// second detached call, not to prove the first one finished.
try {
  writeFileSync(marker, '')
} catch {
  // If we can't write the marker we also can't reliably dedup — proceed anyway
  // rather than silently skipping a session that has something worth mining.
}

mkdirSync(LOG_DIR, { recursive: true })
log(sessionId, `spawning review (reason=${reason}, transcript=${transcriptText.length} chars)`)

const logFd = openSync(LOG_FILE, 'a')
const child = spawn(
  'claude',
  ['-p', '--model', MODEL, '--settings', scopedSettings(), prompt, '--add-dir', projectDir],
  { cwd: projectDir, detached: true, stdio: ['ignore', logFd, logFd] },
)
child.on('error', (err) => log(sessionId, `failed to spawn claude: ${err.message}`))
child.unref()

process.exit(0)
