export interface GitHubConfig {
  owner: string
  repo: string
  token: string
}

interface SearchIssuesResponse {
  total_count: number
}

/**
 * The GitHub half of ADR-001's give-up check: closed, non-merged PRs whose
 * branch name matches `jiraKey`. `is:unmerged` (not just `is:closed`) is what
 * excludes merged PRs — GitHub's search API otherwise counts a merged PR as
 * "closed" too.
 */
export async function closedPrCountForBranch(
  config: GitHubConfig,
  branchName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const q = `repo:${config.owner}/${config.repo} is:pr is:closed is:unmerged head:${branchName}`
  const res = await fetchImpl(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}`, {
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
    },
  })

  if (!res.ok) {
    throw new Error(`GitHub search failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as SearchIssuesResponse
  return data.total_count
}
