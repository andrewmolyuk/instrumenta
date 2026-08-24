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
 * Bitbucket's four pull-request states, verbatim. There is no "approved" among
 * them — approval is a flag on a participant, so an approved-but-unmerged PR is
 * still OPEN (see BLOCKING_STATES above). SUPERSEDED is rare and shows up when
 * one PR replaces another.
 */
export type PrState = 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED'

export interface BranchPrStatus {
  state: PrState
  /** True when at least one reviewer has approved — only meaningful while the PR is OPEN. */
  approved: boolean
}

/**
 * Which PR speaks for a branch when it has more than one, most-decisive first:
 * work already delivered beats work still pending, which beats work refused,
 * which beats a PR that was replaced by another.
 */
const STATE_PRECEDENCE: PrState[] = ['MERGED', 'OPEN', 'DECLINED', 'SUPERSEDED']

/**
 * How many branches go into one query. The URL stays small (a term is ~34
 * characters, so 25 of them is under a kilobyte), and the `next` loop below
 * covers a chunk whose branches happen to carry more than `pagelen` PRs
 * between them.
 */
const BRANCHES_PER_QUERY = 25

/**
 * The PR state of each of `branches`, for showing an attempt's outcome next to
 * it.
 *
 * Deliberately not one request per attempt: a request per row would make the
 * Attempts tab's load time a function of how much history there is. Branch
 * names are OR-ed into batches instead, so ten attempts cost one request and a
 * hundred cost four — and unlike `branchesWithBlockingPr`, which sweeps the
 * whole repository, this scales with what is on screen rather than with the
 * target repo's PR history (140 open PRs there at the time of writing).
 *
 * No state filter, because the whole point is to distinguish DECLINED and
 * SUPERSEDED from the two states the give-up logic cares about. A branch with
 * no PR at all is simply absent from the map: an attempt that reported
 * `no_change`, `usage_limit` or `failed_verify` never opened one.
 */
export async function prStatusByBranch(
  config: BitbucketConfig,
  branches: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, BranchPrStatus>> {
  const found = new Map<string, BranchPrStatus>()
  const wanted = [...new Set(branches)].filter((b) => b.length > 0)

  for (let start = 0; start < wanted.length; start += BRANCHES_PER_QUERY) {
    const chunk = wanted.slice(start, start + BRANCHES_PER_QUERY)
    const params = new URLSearchParams({
      q: chunk.map((b) => `source.branch.name="${b.replace(/"/g, '\\"')}"`).join(' OR '),
      pagelen: MAX_PAGELEN,
      fields: 'values.state,values.source.branch.name,values.participants.approved,next',
    })
    let url: string | undefined = `https://api.bitbucket.org/2.0/repositories/${config.workspace}/${config.repoSlug}/pullrequests?${params}`

    // Bounded like branchesWithBlockingPr: one chunk cannot legitimately need
    // many pages, and a runaway `next` must not spin here.
    for (let page = 0; url && page < 10; page++) {
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.token}` } })
      if (!res.ok) throw new Error(`Bitbucket search failed: ${res.status} ${res.statusText}`)
      const data = (await res.json()) as {
        values?: Array<{
          state?: string
          source?: { branch?: { name?: string } }
          participants?: Array<{ approved?: boolean }>
        }>
        next?: string
      }
      for (const pr of data.values ?? []) {
        const branch = pr.source?.branch?.name
        const state = pr.state as PrState | undefined
        if (!branch || !state || !STATE_PRECEDENCE.includes(state)) continue
        const approved = (pr.participants ?? []).some((p) => p.approved === true)
        const existing = found.get(branch)
        if (existing && STATE_PRECEDENCE.indexOf(existing.state) <= STATE_PRECEDENCE.indexOf(state)) continue
        found.set(branch, { state, approved })
      }
      url = data.next
    }
  }

  return found
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
