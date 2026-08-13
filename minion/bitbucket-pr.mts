import type { MinionInput } from '../src/minion/types.mts'

export interface BitbucketPrConfig {
  workspace: string
  repoSlug: string
  token: string
  base?: string
}

interface CreatePrResponse {
  links: { html: { href: string } }
}

/** Opens the PR a passing verify run earns (architecture.md's Minion contract). */
export async function createPullRequest(
  config: BitbucketPrConfig,
  branch: string,
  input: MinionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(
    `https://api.bitbucket.org/2.0/repositories/${config.workspace}/${config.repoSlug}/pullrequests`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: `${branch}: ${input.description.slice(0, 72)}`,
        source: { branch: { name: branch } },
        destination: { branch: { name: config.base ?? 'main' } },
        description: input.description,
      }),
    },
  )

  if (!res.ok) {
    throw new Error(`Bitbucket PR creation failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as CreatePrResponse
  return data.links.html.href
}
