import type { JiraAuthConfig } from './jira-status-mirror.mts'
import type { GitHubConfig } from '../github/closed-prs.mts'
import type { JiraConfig } from '../task-provider/jira.mts'

export interface ForemanConfig {
  dbPath: string
  jira: JiraConfig
  jiraAuth: JiraAuthConfig
  github: GitHubConfig
  minionCommand: string[]
  timeoutMs: number
  pollIntervalMs: number
  budget?: number
  startTicket?: string
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

function optionalInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = env[key]
  return value === undefined ? undefined : Number(value)
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
    github: {
      owner: required(env, 'GITHUB_OWNER'),
      repo: required(env, 'GITHUB_REPO'),
      token: required(env, 'GITHUB_TOKEN'),
    },
    minionCommand: JSON.parse(required(env, 'MINION_COMMAND')) as string[],
    timeoutMs: optionalInt(env, 'MINION_TIMEOUT_MS') ?? 600_000,
    pollIntervalMs: optionalInt(env, 'FOREMAN_POLL_INTERVAL_MS') ?? 60_000,
    budget: optionalInt(env, 'FOREMAN_BUDGET'),
    startTicket: env.FOREMAN_START_TICKET,
  }
}
