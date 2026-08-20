import type { JiraAuthConfig } from './jira-status-mirror.mts'
import type { BitbucketConfig } from '../bitbucket/closed-prs.mts'
import type { JiraConfig } from '../task-provider/jira.mts'

export interface ForemanConfig {
  dbPath: string
  jira: JiraConfig
  jiraAuth: JiraAuthConfig
  bitbucket: BitbucketConfig
  minionCommand: string[]
  timeoutMs: number
  pollIntervalMs: number
  apiPort: number
  budget?: number
  queueTicket?: string
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

/**
 * Unset and set-but-empty both mean "not configured": `FOREMAN_BUDGET=` is how
 * a human writes "no budget" in an .env file, and `Number('')` is 0 — which
 * silently meant a budget of zero, i.e. Foreman stopping itself after a single
 * dispatch (found live; see runLoop's budget check). A non-numeric value is a
 * typo worth failing the boot over rather than defaulting past: `Number('30m')`
 * is NaN, and a NaN budget or timeout fails in ways that look like anything but
 * a config error.
 */
function optionalInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = env[key]?.trim()
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${key} must be a number, got: ${env[key]}`)
  return parsed
}

/**
 * Reads the container's environment into Foreman's config — the only config
 * surface for the MVP (one process, one target project, no CLI flags parser
 * beyond what a container already gives you). `MINION_COMMAND` is a JSON
 * array so it can carry arbitrary argv (`["docker", "run", ...]`) without
 * shell-quoting rules.
 */
export function parseConfig(env: NodeJS.ProcessEnv): ForemanConfig {
  const jiraAuth: JiraAuthConfig = {
    baseUrl: required(env, 'JIRA_BASE_URL'),
    email: required(env, 'JIRA_EMAIL'),
    apiToken: required(env, 'JIRA_API_TOKEN'),
  }

  return {
    dbPath: env.FOREMAN_DB_PATH ?? './foreman.db',
    jira: { ...jiraAuth, jql: required(env, 'JIRA_JQL') },
    jiraAuth,
    bitbucket: {
      workspace: required(env, 'BITBUCKET_WORKSPACE'),
      repoSlug: required(env, 'BITBUCKET_REPO_SLUG'),
      token: required(env, 'BITBUCKET_TOKEN'),
    },
    minionCommand: JSON.parse(required(env, 'MINION_COMMAND')) as string[],
    timeoutMs: optionalInt(env, 'MINION_TIMEOUT_MS') ?? 600_000,
    pollIntervalMs: optionalInt(env, 'FOREMAN_POLL_INTERVAL_MS') ?? 60_000,
    apiPort: optionalInt(env, 'FOREMAN_API_PORT') ?? 3000,
    budget: optionalInt(env, 'FOREMAN_BUDGET'),
    queueTicket: env.FOREMAN_QUEUE_TICKET,
  }
}
