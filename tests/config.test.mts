import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/foreman/config.mts'

const BASE_ENV = {
  JIRA_BASE_URL: 'https://example.atlassian.net',
  JIRA_EMAIL: 'bot@example.com',
  JIRA_API_TOKEN: 'jira-token',
  JIRA_JQL: 'project = KAZ AND statusCategory != Done',
  BITBUCKET_WORKSPACE: 'andrewmolyuk',
  BITBUCKET_REPO_SLUG: 'target-project',
  BITBUCKET_TOKEN: 'bb-token',
  TARGET_REPO_URL: 'https://x-token-auth:bb-token@bitbucket.org/andrewmolyuk/target-project.git',
  MINION_COMMAND: '["docker","run","--rm","-i","minion:latest"]',
}

describe('parseConfig', () => {
  it('reads required fields and applies documented defaults', () => {
    const config = parseConfig(BASE_ENV)
    expect(config.jira).toEqual({
      baseUrl: 'https://example.atlassian.net',
      email: 'bot@example.com',
      apiToken: 'jira-token',
      jql: 'project = KAZ AND statusCategory != Done',
    })
    expect(config.jiraAuth).toEqual({
      baseUrl: 'https://example.atlassian.net',
      email: 'bot@example.com',
      apiToken: 'jira-token',
    })
    expect(config.bitbucket).toEqual({ workspace: 'andrewmolyuk', repoSlug: 'target-project', token: 'bb-token' })
    expect(config.targetRepoUrl).toBe('https://x-token-auth:bb-token@bitbucket.org/andrewmolyuk/target-project.git')
    expect(config.minionCommand).toEqual(['docker', 'run', '--rm', '-i', 'minion:latest'])
    expect(config.dbPath).toBe('./foreman.db')
    expect(config.timeoutMs).toBe(600_000)
    expect(config.pollIntervalMs).toBe(60_000)
    expect(config.apiPort).toBe(3000)
    expect(config.budget).toBeUndefined()
    expect(config.startTicket).toBeUndefined()
  })

  it('overrides defaults when set', () => {
    const config = parseConfig({
      ...BASE_ENV,
      FOREMAN_DB_PATH: '/data/foreman.db',
      MINION_TIMEOUT_MS: '120000',
      FOREMAN_POLL_INTERVAL_MS: '5000',
      FOREMAN_API_PORT: '8080',
      FOREMAN_BUDGET: '3',
      FOREMAN_START_TICKET: 'KAZ-42',
    })
    expect(config.dbPath).toBe('/data/foreman.db')
    expect(config.timeoutMs).toBe(120_000)
    expect(config.pollIntervalMs).toBe(5_000)
    expect(config.apiPort).toBe(8080)
    expect(config.budget).toBe(3)
    expect(config.startTicket).toBe('KAZ-42')
  })

  it.each([
    'JIRA_BASE_URL',
    'JIRA_EMAIL',
    'JIRA_API_TOKEN',
    'JIRA_JQL',
    'BITBUCKET_WORKSPACE',
    'BITBUCKET_REPO_SLUG',
    'BITBUCKET_TOKEN',
    'TARGET_REPO_URL',
    'MINION_COMMAND',
  ])(
    'throws when %s is missing',
    (key) => {
      const env = { ...BASE_ENV }
      delete (env as Record<string, string | undefined>)[key]
      expect(() => parseConfig(env)).toThrow(`Missing required environment variable: ${key}`)
    },
  )
})
