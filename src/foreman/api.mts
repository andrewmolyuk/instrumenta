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
  attemptTotals,
  listAttempts,
  setBudget,
  setBudgetTotal,
  setQueueTicket,
  setStopped,
} from '../db/queries.mts'
import type { TaskProvider } from '../task-provider/types.mts'
import type { ForemanConfig } from './config.mts'
import { branchesWithBlockingPr, hasBlockingPrForBranch, prStatusByBranch } from '../bitbucket/closed-prs.mts'

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

/**
 * How long live PR states are reused for.
 *
 * The same reason the sweep above is cached, and a sharper one: the UI polls
 * every five seconds and re-fetches /api/attempts on every poll while the
 * Attempts tab is open, so an uncached lookup would be a Bitbucket request
 * every five seconds for as long as anyone leaves that tab on screen. Measured
 * against the real repository, one such request takes ~1s for ten branches.
 *
 * Five minutes rather than the minute the sweep above uses, because nothing
 * automatic depends on this — it is a column a human reads, a PR is merged or
 * declined on human time, and `?refreshPrStatus=1` re-reads it on demand
 * (the Attempt history page has a button for exactly that). Worst case while
 * the tab sits open is one request per five minutes, and none at all when it
 * is closed.
 *
 * Keyed by the set of branches asked about, so a newly recorded attempt is not
 * left blank waiting for the previous answer to expire.
 */
const PR_STATE_CACHE_MS = 300_000

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

  let cachedPrStatus: { at: number; key: string; status: Record<string, { state: string; approved: boolean }> } | null = null

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
      let queueTotal: number | undefined
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
        // The whole backlog, not the page listBacklog returned — a source that
        // cannot say cheaply leaves the count out and the UI falls back to the
        // page size.
        queueTotal = (await deps.taskProvider.backlogCount?.()) ?? undefined
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
        queueTotal,
        queueError,
        history: listAttempts(deps.db, deps.historyLimit ?? 50),
        // Over every attempt, not over `history` above — which is capped, and
        // would give the Cockpit a total that stops growing at the cap.
        totals: attemptTotals(deps.db),
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
      const attempts = listAttempts(deps.db, null)

      // The PR's own state has to be read live: a human merges or declines long
      // after the attempt that opened it finished, so there is nothing useful to
      // store on the row. Batched by branch (a branch is the jira_key), so this
      // is a request per 25 attempts rather than one per attempt — and, unlike
      // the queue's blocking-PR sweep, it asks only about what this table shows.
      //
      // A Bitbucket outage must not cost the whole history: the attempts are
      // local and worth showing regardless, so the failure is reported
      // alongside them and the column falls back to "unknown" (same shape as
      // /api/status's queueError).
      let prStatus: Record<string, { state: string; approved: boolean }> = {}
      let prStatusError: string | undefined
      const branches = [...new Set(attempts.map((a) => a.jira_key))].sort()
      const cacheKey = branches.join(',')
      const now = deps.now?.() ?? Date.now()
      // `?refreshPrStatus=1` is the button on the Attempt history page: a human
      // who just merged something should not have to wait out the cache. Still a
      // GET — it re-reads someone else's state and changes nothing here but the
      // cached copy.
      const forced = url.searchParams.get('refreshPrStatus') === '1'
      const fresh = cachedPrStatus && cachedPrStatus.key === cacheKey && now - cachedPrStatus.at < PR_STATE_CACHE_MS
      if (fresh && !forced) {
        prStatus = cachedPrStatus!.status
      } else {
        try {
          prStatus = Object.fromEntries(await prStatusByBranch(deps.bitbucket, branches, deps.fetchImpl))
          cachedPrStatus = { at: now, key: cacheKey, status: prStatus }
        } catch (err) {
          prStatusError = err instanceof Error ? err.message : String(err)
          // Serve the stale copy rather than blanking the column over one bad
          // request; the response says how old it is and what went wrong.
          if (cachedPrStatus?.key === cacheKey) prStatus = cachedPrStatus.status
        }
      }

      return json({
        attempts,
        prStatus,
        prStatusError,
        // When the served copy was actually read from Bitbucket, so the page can
        // say how stale it is instead of implying it is live.
        prStatusAt: cachedPrStatus?.key === cacheKey ? new Date(cachedPrStatus.at).toISOString() : undefined,
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
      // is the human overriding that verdict for a ticket whose one recorded
      // attempt failed. Since ADR-016 that verdict comes from SQLite alone, so
      // delete-attempts is the other, bulk way back.
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
