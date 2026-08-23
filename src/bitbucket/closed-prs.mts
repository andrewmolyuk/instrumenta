export interface BitbucketConfig {
  workspace: string
  repoSlug: string
  token: string
}

interface SearchPullRequestsResponse {
  size: number
}

/**
 * A PR in either of these states means the ticket should not be run again:
 * OPEN is work a human still has to review, MERGED is work already delivered.
 * DECLINED is deliberately absent, and since ADR-016 it means nothing at all
 * here: a declined PR neither blocks a ticket nor retires it, so the ticket
 * goes back into the backlog like any other.
 *
 * Approval is not a state in Bitbucket, it is a flag on a participant, so an
 * approved-but-unmerged PR is still OPEN and is covered here.
 */
const BLOCKING_STATES = 'state="OPEN" OR state="MERGED"'

/**
 * Bitbucket's maximum for this endpoint. Asking for 100 is not clamped — it is
 * rejected outright with `400 Invalid pagelen`, which took down /api/queue-ticket
 * live.
 */
const MAX_PAGELEN = '50'

async function search(config: BitbucketConfig, query: string, fetchImpl: typeof fetch, fields?: string): Promise<unknown> {
  const params = new URLSearchParams({ q: query, pagelen: MAX_PAGELEN })
  if (fields) params.set('fields', fields)
  const url = `https://api.bitbucket.org/2.0/repositories/${config.workspace}/${config.repoSlug}/pullrequests?${params}`
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.token}` } })
  if (!res.ok) throw new Error(`Bitbucket search failed: ${res.status} ${res.statusText}`)
  return await res.json()
}

/** True if this branch has a PR that is open or already merged. */
export async function hasBlockingPrForBranch(
  config: BitbucketConfig,
  branchName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const data = (await search(
    config,
    `source.branch.name="${branchName}" AND (${BLOCKING_STATES})`,
    fetchImpl,
    'size',
  )) as SearchPullRequestsResponse
  return data.size > 0
}

/**
 * Every branch name that has an open or merged PR, for filtering a whole
 * backlog at once.
 *
 * One paginated sweep rather than a query per ticket: the queue is re-read on
 * every status poll, and a backlog of a few hundred tickets would otherwise be
 * a few hundred Bitbucket requests every five seconds. Callers are expected to
 * cache the result — see createApiHandler.
 */
export async function branchesWithBlockingPr(
  config: BitbucketConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  const params = new URLSearchParams({
    q: `(${BLOCKING_STATES})`,
    pagelen: MAX_PAGELEN,
    fields: 'values.source.branch.name,next',
  })
  let url: string | undefined = `https://api.bitbucket.org/2.0/repositories/${config.workspace}/${config.repoSlug}/pullrequests?${params}`

  const branches = new Set<string>()
  // Bounded so a pathological repo cannot spin here; 50 pages of 50 is 2500
  // PRs, comfortably past the few hundred this is aimed at.
  for (let page = 0; url && page < 50; page++) {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.token}` } })
    if (!res.ok) throw new Error(`Bitbucket search failed: ${res.status} ${res.statusText}`)
    const data = (await res.json()) as { values?: Array<{ source?: { branch?: { name?: string } } }>; next?: string }
    for (const pr of data.values ?? []) {
      const name = pr.source?.branch?.name
      if (name) branches.add(name)
    }
    url = data.next
  }
  return branches
}

/**
 * ADR-007's pick-eligibility check: a branch with an OPEN PR already has a
 * human's attention pending (review/merge) — Foreman shouldn't redispatch
 * and redo the work just because Jira's own status hasn't caught up yet
 * (nothing moves a ticket to Done automatically anymore; see ADR-007).
 */
export async function hasOpenPrForBranch(
  config: BitbucketConfig,
  branchName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const q = `source.branch.name="${branchName}" AND state="OPEN"`
  const url = `https://api.bitbucket.org/2.0/repositories/${config.workspace}/${config.repoSlug}/pullrequests?q=${encodeURIComponent(q)}`
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${config.token}` },
  })

  if (!res.ok) {
    throw new Error(`Bitbucket search failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as SearchPullRequestsResponse
  return data.size > 0
}
