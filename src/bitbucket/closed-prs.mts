export interface BitbucketConfig {
  workspace: string
  repoSlug: string
  token: string
}

interface SearchPullRequestsResponse {
  size: number
}

/**
 * The Bitbucket half of ADR-001's give-up check: declined (closed, non-merged)
 * PRs whose source branch matches `jiraKey`. Bitbucket's PR states are OPEN,
 * MERGED, DECLINED, SUPERSEDED — DECLINED is the direct analog of GitHub's
 * "closed and not merged"; SUPERSEDED (replaced by a newer PR) isn't counted,
 * since that's a different situation than the attempt actually failing.
 */
export async function closedPrCountForBranch(
  config: BitbucketConfig,
  branchName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const q = `source.branch.name="${branchName}" AND state="DECLINED"`
  const url = `https://api.bitbucket.org/2.0/repositories/${config.workspace}/${config.repoSlug}/pullrequests?q=${encodeURIComponent(q)}`
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${config.token}` },
  })

  if (!res.ok) {
    throw new Error(`Bitbucket search failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as SearchPullRequestsResponse
  return data.size
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
