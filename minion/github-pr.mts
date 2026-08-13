import type { MinionInput } from '../src/minion/types.mts'

export interface GitHubPrConfig {
  owner: string
  repo: string
  token: string
  base?: string
}

interface CreatePrResponse {
  html_url: string
}

/** Opens the PR a passing verify run earns (architecture.md's Minion contract). */
export async function createPullRequest(
  config: GitHubPrConfig,
  branch: string,
  input: MinionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`https://api.github.com/repos/${config.owner}/${config.repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `${branch}: ${input.description.slice(0, 72)}`,
      head: branch,
      base: config.base ?? 'main',
      body: input.description,
    }),
  })

  if (!res.ok) {
    throw new Error(`GitHub PR creation failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as CreatePrResponse
  return data.html_url
}
