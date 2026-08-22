#!/usr/bin/env bun
/**
 * PreToolUse guard — blocks wiring up metered Anthropic API-key auth.
 *
 * ADR-006 chose subscription auth (`CLAUDE_CODE_OAUTH_TOKEN`) over an API key,
 * and CLAUDE.md's Workflow section states it as a rule. This is the gate,
 * because the decision is easy to undo by accident: an API key is the first
 * thing most guidance reaches for when Claude Code will not authenticate, and
 * switching to it silently moves every attempt onto per-token billing — a
 * change in what the pipeline costs to run, arrived at while debugging
 * something else.
 *
 * Matches *use*, not mention. The first version matched the bare variable name
 * and promptly blocked the commit that introduced this hook, whose message
 * named it in a sentence; it would equally have blocked ADR-006, CLAUDE.md's
 * own rule, and this comment. Writing down why something is forbidden has to
 * stay possible — only wiring it up is the problem.
 *
 * Covers Bash commands and file writes alike, since the variable would arrive
 * either by `export` / `-e` on a docker run, or written into .env, a Dockerfile
 * or a source file. Files under `tests/` and `.claude/hooks/` are exempt: that
 * is where the patterns legitimately appear as data, and a guard that cannot be
 * tested is a guard nobody can trust.
 */

const API_KEY = 'ANTHROPIC_API_KEY'

const USES = [
  new RegExp(`${API_KEY}\\s*[=:]`), //                assignment: .env, Dockerfile ENV, shell
  new RegExp(`\\bexport\\s+${API_KEY}\\b`), //        shell export with no value
  new RegExp(`-e\\s+["']?${API_KEY}\\b`), //          docker run -e passthrough
  new RegExp(`\\benv\\b[^\\n]{0,20}\\.${API_KEY}\\b`), //  process.env.<key>
  new RegExp(`\\benv\\s*\\[\\s*["']${API_KEY}["']\\s*\\]`), // env['<key>']
]

const EXEMPT_PATHS = [/(^|\/)tests\//, /(^|\/)\.claude\/hooks\//]

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export function blocks(input: { command?: unknown; content?: unknown; new_string?: unknown; file_path?: unknown }): boolean {
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  if (path && EXEMPT_PATHS.some((exempt) => exempt.test(path))) return false
  const text = [input.command, input.content, input.new_string].filter((v) => typeof v === 'string').join('\n')
  return USES.some((pattern) => pattern.test(text))
}

if (import.meta.main) {
  let input = {}
  try {
    input = JSON.parse((await readStdin()) || '{}')?.tool_input ?? {}
  } catch {
    input = {}
  }

  if (blocks(input)) {
    process.stderr.write(
      'Blocked: this wires up an Anthropic API key. Minion authenticates Claude Code ' +
        'with CLAUDE_CODE_OAUTH_TOKEN (subscription, flat-rate) per ADR-006 — an API key ' +
        'would move every attempt onto per-token billing. See CLAUDE.md.\n',
    )
    process.exit(2)
  }

  process.exit(0)
}
