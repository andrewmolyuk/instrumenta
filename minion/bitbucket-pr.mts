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

/**
 * The git clone URL for this config's repo. Derived rather than taken as its
 * own `TARGET_REPO_URL` env var — workspace/repoSlug/token already fully
 * determine it, and keeping both meant a human could change one without the
 * other, silently pointing Minion's git clone and its Bitbucket API calls at
 * different repos. `x-token-auth` is Bitbucket's fixed username for HTTPS
 * access-token auth (not a placeholder — write it literally).
 */
export function buildCloneUrl(config: BitbucketPrConfig): string {
  return `https://x-token-auth:${config.token}@bitbucket.org/${config.workspace}/${config.repoSlug}.git`
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
    const body = await res.text()
    throw new Error(`Bitbucket PR creation failed: ${res.status} ${res.statusText}\n${body}`)
  }

  const data = (await res.json()) as CreatePrResponse
  return data.links.html.href
}
