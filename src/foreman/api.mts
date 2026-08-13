import type { Database } from 'bun:sqlite'
import { getBudget, getStartTicket, isStopped, listAttempts, setBudget, setStartTicket, setStopped } from '../db/queries.mts'
import type { TaskProvider } from '../task-provider/types.mts'

export interface ApiDeps {
  db: Database
  taskProvider: TaskProvider
  historyLimit?: number
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * The thin API architecture.md describes: current status, the live queue,
 * an attempt history, and the four controls ADR-003 names — stop, continue,
 * start[ticket], budget. A plain fetch handler, not bound to a port, so it's
 * testable directly with constructed Request objects; startApiServer wraps
 * it with Bun.serve. No separate CLI artifact (architecture.md) — this JSON
 * API is the only scriptable surface, same thing the (not yet built) Web UI
 * would call.
 */
export function createApiHandler(deps: ApiDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const [queue, history] = await Promise.all([
        deps.taskProvider.listBacklog(),
        Promise.resolve(listAttempts(deps.db, deps.historyLimit ?? 50)),
      ])
      return json({
        stopped: isStopped(deps.db),
        budget: getBudget(deps.db),
        startTicket: getStartTicket(deps.db),
        queue,
        history,
      })
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      setStopped(deps.db, true)
      return json({ stopped: true })
    }

    if (req.method === 'POST' && url.pathname === '/api/continue') {
      setStopped(deps.db, false)
      return json({ stopped: false })
    }

    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = await req.json().catch(() => null)
      const jiraKey = (body as { jiraKey?: unknown } | null)?.jiraKey
      if (typeof jiraKey !== 'string' || jiraKey.length === 0) {
        return json({ error: 'jiraKey must be a non-empty string' }, 400)
      }
      setStartTicket(deps.db, jiraKey)
      return json({ startTicket: jiraKey })
    }

    if (req.method === 'POST' && url.pathname === '/api/budget') {
      const body = await req.json().catch(() => null)
      const budget = (body as { budget?: unknown } | null)?.budget
      if (budget !== null && typeof budget !== 'number') {
        return json({ error: 'budget must be a number or null' }, 400)
      }
      setBudget(deps.db, budget)
      return json({ budget })
    }

    return json({ error: 'Not found' }, 404)
  }
}

export function startApiServer(deps: ApiDeps, port: number) {
  return Bun.serve({ port, fetch: createApiHandler(deps) })
}
