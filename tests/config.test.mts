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
    expect(config.minionCommand).toEqual(['docker', 'run', '--rm', '-i', 'minion:latest'])
    expect(config.dbPath).toBe('./foreman.db')
    expect(config.timeoutMs).toBe(600_000)
    expect(config.pollIntervalMs).toBe(60_000)
    expect(config.apiPort).toBe(3000)
    expect(config.budget).toBeUndefined()
    expect(config.queueTicket).toBeUndefined()
  })

  it('overrides defaults when set', () => {
    const config = parseConfig({
      ...BASE_ENV,
      FOREMAN_DB_PATH: '/data/foreman.db',
      MINION_TIMEOUT_MS: '120000',
      FOREMAN_POLL_INTERVAL_MS: '5000',
      FOREMAN_API_PORT: '8080',
      FOREMAN_BUDGET: '3',
      FOREMAN_QUEUE_TICKET: 'KAZ-42',
    })
    expect(config.dbPath).toBe('/data/foreman.db')
    expect(config.timeoutMs).toBe(120_000)
    expect(config.pollIntervalMs).toBe(5_000)
    expect(config.apiPort).toBe(8080)
    expect(config.budget).toBe(3)
    expect(config.queueTicket).toBe('KAZ-42')
  })

  it('treats a set-but-empty numeric variable as unset, not as zero', () => {
    // `FOREMAN_BUDGET=` in an .env file is how a human writes "no budget";
    // Number('') is 0, which used to mean "stop after one dispatch".
    const config = parseConfig({ ...BASE_ENV, FOREMAN_BUDGET: '', MINION_TIMEOUT_MS: '  ' })
    expect(config.budget).toBeUndefined()
    expect(config.timeoutMs).toBe(600_000)
  })

  it.each(['FOREMAN_BUDGET', 'MINION_TIMEOUT_MS', 'FOREMAN_POLL_INTERVAL_MS', 'FOREMAN_API_PORT'])(
    'throws on a non-numeric %s rather than defaulting past the typo',
    (key) => {
      expect(() => parseConfig({ ...BASE_ENV, [key]: '30m' })).toThrow(new RegExp(`${key} must be a number`))
    },
  )

  it.each([
    'JIRA_BASE_URL',
    'JIRA_EMAIL',
    'JIRA_API_TOKEN',
    'JIRA_JQL',
    'BITBUCKET_WORKSPACE',
    'BITBUCKET_REPO_SLUG',
    'BITBUCKET_TOKEN',
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
