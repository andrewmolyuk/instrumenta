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
import { branchesWithBlockingPr, hasBlockingPrForBranch } from '../bitbucket/closed-prs.mts'

const UI_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ui.html'), 'utf-8')

export interface ApiDeps {
  db: Database
  taskProvider: TaskProvider
  bitbucket: BitbucketConfig
  /** Powers GET /api/config (the Settings tab). Omit to 404 that route — every other route works without it. */
  config?: ForemanConfig
  /** Caps the `history` in GET /api/status only (default 50). GET /api/attempts is never capped. */
  historyLimit?: number
  fetchImpl?: typeof fetch
  /** Injectable clock, so the blocking-PR cache is testable without waiting a minute. */
  now?: () => number
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
 * UI's Settings tab (never the auth secrets), and GET /api/attempts, the
 * complete attempt history the Attempts tab needs. A plain fetch handler, not
 * bound to a port, so it's testable directly with constructed Request
 * objects; startApiServer wraps it with Bun.serve. No separate CLI artifact
 * (architecture.md) — this JSON API is the only scriptable surface, and the
 * only thing the UI itself calls.
 */
/**
 * How long the set of branches with an open or merged PR is reused for.
 *
 * The UI polls /api/status every five seconds and the queue is filtered against
 * this set, so without a cache every poll would re-sweep every PR in the repo.
 * A minute is well inside how fast a backlog changes, and the authoritative
 * check still runs per-ticket at Pick and at queue time — this only decides
 * what a human is shown.
 */
const BLOCKING_PR_CACHE_MS = 60_000

export function createApiHandler(deps: ApiDeps): (req: Request) => Promise<Response> {
  // Per-handler, not module-level, so tests get a fresh cache each time.
  let cached: { at: number; branches: Set<string> } | null = null
  const blockingBranches = async (): Promise<Set<string>> => {
    const now = deps.now?.() ?? Date.now()
    if (cached && now - cached.at < BLOCKING_PR_CACHE_MS) return cached.branches
    const branches = await branchesWithBlockingPr(deps.bitbucket, deps.fetchImpl)
    cached = { at: now, branches }
    return branches
  }

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
        // Filtered to what Pick would actually consider: a ticket whose branch
        // already has an open or merged PR is not going to be dispatched, and
        // showing it in the queue invites someone to wonder why it never runs.
        // Deliberately not filtered on given-up — that one a human can override
        // by queueing the ticket by name, so it stays visible.
        const blocked = await blockingBranches()
        queue = queue.filter((item) => !blocked.has(item.jira_key))
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

    if (req.method === 'GET' && url.pathname === '/api/attempts') {
      // The whole history, uncapped — separate from /api/status rather than
      // lifting that endpoint's cap, because the UI polls /api/status every 5
      // seconds and every attempt row can carry up to 16KB of `output`
      // (MAX_CAPTURED_OUTPUT_CHARS). Sending all of it on every poll to keep a
      // table nobody is looking at up to date is the cost this split avoids:
      // the Attempts tab fetches this when it's actually open, and the Cockpit's
      // Recent Attempts panel only ever shows five rows.
      return json({ attempts: listAttempts(deps.db, null) })
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
      // A budget is a max-tasks-*this-run* counter (ADR-003), and pressing
      // Start is a human authorizing another run — so an exhausted counter is
      // refilled to the capacity they last set (ADR-010). Without this, Start
      // on a spent budget dispatched exactly one task and stopped again, every
      // time, since `budget` survives on the volume. Nothing to refill from
      // (no budget, or a capacity that was never recorded) is left alone.
      const budget = getBudget(deps.db)
      const budgetTotal = getBudgetTotal(deps.db)
      const refilled = budget !== null && budget <= 0 && budgetTotal !== null && budgetTotal > 0
      if (refilled) setBudget(deps.db, budgetTotal)
      setStopped(deps.db, false)
      return json({ stopped: false, budget: getBudget(deps.db), budgetRefilled: refilled })
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
      // Given-up is deliberately *not* checked here: queueing a ticket by name
      // is the human overriding that verdict, and it is the only way back for a
      // ticket retired by a closed PR — delete-attempts clears SQLite but has
      // no reach into Bitbucket.
      if (await hasBlockingPrForBranch(deps.bitbucket, jiraKey, deps.fetchImpl)) {
        return json(
          {
            error: `${jiraKey} already has an open or merged PR — review, close or unmerge it before running this ticket again`,
          },
          409,
        )
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
      if (budget !== null && (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1)) {
        // Zero and below are rejected rather than stored: a budget of 0 is
        // indistinguishable from an exhausted one, which /api/start would then
        // try to refill from a capacity of 0 forever. "No budget" is null.
        return json({ error: 'budget must be a positive integer or null' }, 400)
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
