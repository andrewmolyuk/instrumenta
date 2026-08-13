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
