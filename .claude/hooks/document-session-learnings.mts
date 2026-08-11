#!/usr/bin/env bun
/**
 * SessionEnd hook — mines the transcript for anything worth a permanent
 * docs/todo/ entry before the session disappears.
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
 * session ends. The sub-call's write permission is scoped to docs/todo/**
 * only — it can never reach docs/adr/, so there's no immutable-record
 * risk to reason about here.
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  buildPrompt,
  CHILD_ENV_FLAG,
  expiredLogFiles,
  extractTranscriptText,
  isChildRun,
  logFileName,
  MIN_TRANSCRIPT_CHARS,
  scopedSettings,
  shouldRun,
} from './utils/session-doc-mining.mts'

const MODEL = process.env.DOCUMENT_SESSION_MODEL || 'sonnet'
const MAX_TRANSCRIPT_CHARS = Number(process.env.DOCUMENT_SESSION_MAX_CHARS) || 40_000

const HOOK_DIR = dirname(new URL(import.meta.url).pathname)
const HOOK_START = new Date()
// Overridable so the test suite can point the whole tree (log + markers) at a
// temp directory instead of appending test noise to the repo's real log.
const LOG_DIR = process.env.DOCUMENT_SESSION_LOG_DIR || join(HOOK_DIR, '..', 'logs')
// Resolved once per run, not per write: a session ending at a month boundary
// keeps all of its own lines together instead of splitting across two files.
const LOG_FILE = join(LOG_DIR, logFileName(HOOK_START))
// One empty file per session, kept under logs/ rather than beside the hook so
// all of this hook's disposable runtime state lives under a single ignored root.
const MARKER_DIR = join(LOG_DIR, 'markers')
const MARKER_TTL_MS = 90 * 24 * 60 * 60 * 1000

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

/**
 * Nothing else ever removes what this hook leaves behind, so it sweeps up after
 * itself: markers only have to outlive the session that wrote them, and month
 * logs are kept for LOG_RETENTION_MONTHS. Runs once per session end, on every
 * path including the early exits — otherwise a stretch of sessions that all bail
 * out early would let old files sit indefinitely.
 *
 * Entirely best-effort: a missing directory, a racing session, or a read-only
 * disk must never fail or delay a session end, hence the swallowed errors.
 */
function pruneOldFiles(now: Date): void {
  try {
    for (const name of readdirSync(MARKER_DIR)) {
      const path = join(MARKER_DIR, name)
      if (now.getTime() - statSync(path).mtimeMs > MARKER_TTL_MS) unlinkSync(path)
    }
  } catch {
    // See above — housekeeping failures are not worth reporting.
  }
  try {
    for (const name of expiredLogFiles(readdirSync(LOG_DIR), now)) unlinkSync(join(LOG_DIR, name))
  } catch {
    // Ditto.
  }
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

// Before anything else, including reading stdin: a mining sub-call ending must
// never start another one. Checked first because it is the only failure here
// that compounds — every other exit path costs one no-op.
if (isChildRun(process.env)) process.exit(0)

const input = parseInput(await readStdin())
const sessionId = input.session_id || 'unknown'
const reason = input.reason || ''

if (!shouldRun(reason)) process.exit(0)

pruneOldFiles(HOOK_START)

if (!input.transcript_path || !existsSync(input.transcript_path)) {
  log(sessionId, 'no transcript available, skipping')
  process.exit(0)
}

// Detached review calls have no synchronous result to dedup against, so guard
// against a double-fire (e.g. a retried hook invocation) up front instead.
const marker = join(MARKER_DIR, sessionId)
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
  mkdirSync(MARKER_DIR, { recursive: true })
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
  {
    cwd: projectDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    // Inherited by the sub-call and anything it spawns, so the whole subtree is
    // inert to this hook. Without it the sub-call's own SessionEnd fires here.
    env: { ...process.env, [CHILD_ENV_FLAG]: '1' },
  },
)
child.on('error', (err) => log(sessionId, `failed to spawn claude: ${err.message}`))
child.unref()

process.exit(0)
