import type { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BitbucketConfig } from '../bitbucket/closed-prs.mts'
import {
  deleteAttempts,
  getBudget,
  getBudgetTotal,
  getCurrentTask,
  getQueueTicket,
  isStopped,
  listAttempts,
  setBudget,
  setBudgetTotal,
  setQueueTicket,
  setStopped,
} from '../db/queries.mts'
import type { TaskProvider } from '../task-provider/types.mts'
import type { ForemanConfig } from './config.mts'
import { isGivenUp } from './pick.mts'

const UI_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ui.html'), 'utf-8')

export interface ApiDeps {
  db: Database
  taskProvider: TaskProvider
  bitbucket: BitbucketConfig
  /** Powers GET /api/config (the Settings tab). Omit to 404 that route — every other route works without it. */
  config?: ForemanConfig
  historyLimit?: number
  fetchImpl?: typeof fetch
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * The thin API and minimal Web UI architecture.md describes, served from the
 * same container: `GET /` serves ui.html, a single static page (no build
 * step) that calls the JSON endpoints below — current status, the live
 * queue, an attempt history, and the four controls ADR-003 names — renamed by
 * ADR-005 to match what they actually do: stop, start (was "continue"),
 * queue[ticket] (was "start[ticket]"), budget — plus delete-attempts, added
 * later to give a human a way to force a given-up ticket eligible again
 * (deleteAttempts, db/queries.mts) without wiping the whole database, and
 * GET /api/config, a read-only allowlisted subset of ForemanConfig for the
 * UI's Settings tab (never the auth secrets). A plain fetch handler, not
 * bound to a port, so it's testable directly with constructed Request
 * objects; startApiServer wraps it with Bun.serve. No separate CLI artifact
 * (architecture.md) — this JSON API is the only scriptable surface, and the
 * only thing the UI itself calls.
 */
export function createApiHandler(deps: ApiDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(UI_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      // The queue read hits Jira live — if it's unreachable, that's still a
      // status worth showing (stopped/budget/history are all local), not a
      // reason to fail the whole request. Found the same way as runLoop's
      // per-iteration try/catch: running Foreman's container against an
      // unreachable Jira URL, this endpoint returned Bun's raw error page
      // instead of JSON before this was added.
      let queue: Awaited<ReturnType<TaskProvider['listBacklog']>> = []
      let queueError: string | undefined
      try {
        queue = await deps.taskProvider.listBacklog()
      } catch (err) {
        queueError = err instanceof Error ? err.message : String(err)
      }

      return json({
        stopped: isStopped(deps.db),
        budget: getBudget(deps.db),
        budgetTotal: getBudgetTotal(deps.db),
        queueTicket: getQueueTicket(deps.db),
        current: getCurrentTask(deps.db),
        queue,
        queueError,
        history: listAttempts(deps.db, deps.historyLimit ?? 50),
      })
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      // Settings tab, read-only. Deliberately an allowlist of fields, not the
      // full ForemanConfig: jiraAuth.apiToken and bitbucket.token must never
      // reach the browser, so each field sent here is named explicitly rather
      // than spreading or redacting after the fact.
      if (!deps.config) return json({ error: 'Not found' }, 404)
      const c = deps.config
      return json({
        dbPath: c.dbPath,
        jira: { baseUrl: c.jira.baseUrl, jql: c.jira.jql, email: c.jiraAuth.email },
        bitbucket: { workspace: c.bitbucket.workspace, repoSlug: c.bitbucket.repoSlug },
        minionCommand: c.minionCommand,
        timeoutMs: c.timeoutMs,
        pollIntervalMs: c.pollIntervalMs,
        apiPort: c.apiPort,
      })
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      setStopped(deps.db, true)
      return json({ stopped: true })
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      setStopped(deps.db, false)
      return json({ stopped: false })
    }

    if (req.method === 'POST' && url.pathname === '/api/queue-ticket') {
      const body = await req.json().catch(() => null)
      const jiraKey = (body as { jiraKey?: unknown } | null)?.jiraKey
      if (typeof jiraKey !== 'string' || jiraKey.length === 0) {
        return json({ error: 'jiraKey must be a non-empty string' }, 400)
      }

      // pickSpecific (pick.mts) would silently no-op on either case below —
      // it's built for the loop, where nothing eligible just means "try again
      // next iteration." A human clicking Queue Ticket needs to know why now.
      const backlog = await deps.taskProvider.listBacklog()
      if (!backlog.some((item) => item.jira_key === jiraKey)) {
        return json({ error: `${jiraKey} is not in the live backlog (doesn't match the configured JQL)` }, 404)
      }
      if (await isGivenUp(deps.db, deps.bitbucket, jiraKey, deps.fetchImpl)) {
        return json({ error: `${jiraKey} has already been given up on (3+ failed attempts or closed PRs)` }, 409)
      }

      setQueueTicket(deps.db, jiraKey)
      return json({ queueTicket: jiraKey })
    }

    if (req.method === 'POST' && url.pathname === '/api/delete-attempts') {
      const body = await req.json().catch(() => null)
      const jiraKey = (body as { jiraKey?: unknown } | null)?.jiraKey
      if (typeof jiraKey !== 'string' || jiraKey.length === 0) {
        return json({ error: 'jiraKey must be a non-empty string' }, 400)
      }
      const deleted = deleteAttempts(deps.db, jiraKey)
      return json({ jiraKey, deleted })
    }

    if (req.method === 'POST' && url.pathname === '/api/budget') {
      const body = await req.json().catch(() => null)
      const budget = (body as { budget?: unknown } | null)?.budget
      if (budget !== null && typeof budget !== 'number') {
        return json({ error: 'budget must be a number or null' }, 400)
      }
      setBudget(deps.db, budget)
      setBudgetTotal(deps.db, budget)
      return json({ budget })
    }

    return json({ error: 'Not found' }, 404)
  }
}

export function startApiServer(deps: ApiDeps, port: number) {
  return Bun.serve({ port, fetch: createApiHandler(deps) })
}
